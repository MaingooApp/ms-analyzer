import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Prisma, PrismaClient } from '@prisma/client';

import { AnalyzerEvents, NATS_SERVICE, SuppliersSubjects } from 'src/config';
import { SubmitDocumentDto, GetDocumentDto, SubmitBatchDto } from './dto';
import type { ExtractionResult } from './interfaces';
import { AzureDocIntelService, type AzureTokenUsageSnapshot } from './azure-docintelligence.service';
import { AzureBlobService } from './azure-blob.service';

@Injectable()
export class DocumentsService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    @Inject(NATS_SERVICE) private readonly client: ClientProxy,
    private readonly azureDocIntel: AzureDocIntelService,
    private readonly azureBlob: AzureBlobService,
  ) {
    super();
  }

  async onModuleInit() {
    await this.$connect();
    this.logger.log('Database connection established');
  }

  async onModuleDestroy() {
    await this.$disconnect();
    this.logger.log('Database connection closed');
  }

  async submit(payload: SubmitDocumentDto) {
    try {
      if (!payload.enterpriseId) {
        throw new RpcException({ status: 400, message: 'enterpriseId is required' });
      }

      const buffer = Buffer.from(payload.buffer, 'base64');

      const document = await this.document.create({
        data: {
          enterpriseId: payload.enterpriseId,
          uploadedBy: payload.uploadedBy,
          filename: payload.filename,
          mimetype: payload.mimetype,
          fileSize: buffer.byteLength,
          hasDeliveryNotes: Boolean(payload.hasDeliveryNotes),
          documentType: payload.documentType,
          fileData: buffer,
          status: 'PENDING',
        },
      });

      void this.processDocument(document.id);

      return { documentId: document.id };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async submitBatch(payload: SubmitBatchDto) {
    try {
      const results: { documentId: string; filename: string; success: boolean; error?: string }[] = [];
      const STAGGER_DELAY_MS = 300; 

      for (let i = 0; i < payload.documents.length; i++) {
        const doc = payload.documents[i];
        
        try {
          if (!doc.enterpriseId) {
            throw new Error('enterpriseId is required');
          }

          const buffer = Buffer.from(doc.buffer, 'base64');

          const document = await this.document.create({
            data: {
              enterpriseId: doc.enterpriseId,
              uploadedBy: doc.uploadedBy,
              filename: doc.filename,
              mimetype: doc.mimetype,
              fileSize: buffer.byteLength,
              hasDeliveryNotes: Boolean(doc.hasDeliveryNotes),
              documentType: doc.documentType,
              fileData: buffer,
              status: 'PENDING',
            },
          });

          void this.processDocument(document.id);

          results.push({
            documentId: document.id,
            filename: doc.filename,
            success: true,
          });

          if (i < payload.documents.length - 1) {
            await new Promise((resolve) => setTimeout(resolve, STAGGER_DELAY_MS));
          }
        } catch (error) {
          this.logger.error(`Failed to create document ${doc.filename}:`, error);
          results.push({
            documentId: '',
            filename: doc.filename,
            success: false,
            error: error instanceof Error ? error.message : 'Unknown error',
          });
        }
      }

      const successCount = results.filter((r) => r.success).length;
      const failureCount = results.filter((r) => !r.success).length;

      this.logger.log(
        `📦 Batch submitted: ${successCount} exitosos, ${failureCount} fallidos (${payload.documents.length} total)`,
      );

      return {
        total: payload.documents.length,
        success: successCount,
        failed: failureCount,
        results,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async getById(payload: GetDocumentDto) {
    try {
      const document = await this.document.findUnique({
        where: { id: payload.id },
        include: {
          extraction: {
            include: {
              lineItems: true,
            },
          },
        },
      });

      if (!document) {
        throw new RpcException({ status: 404, message: 'Document not found' });
      }

      if (payload.enterpriseId && document.enterpriseId !== payload.enterpriseId) {
        throw new RpcException({ status: 403, message: 'Forbidden' });
      }

      return {
        id: document.id,
        enterpriseId: document.enterpriseId,
        uploadedBy: document.uploadedBy,
        filename: document.filename,
        mimetype: document.mimetype,
        hasDeliveryNotes: Boolean(document.hasDeliveryNotes),
        documentType: document.documentType,
        status: document.status,
        errorReason: document.errorReason,
        invoiceId: document.invoiceId,
        processedAt: document.processedAt?.toISOString() ?? null,
        createdAt: document.createdAt.toISOString(),
        updatedAt: document.updatedAt.toISOString(),
        extraction: document.extraction
          ? {
              supplierName: document.extraction.supplierName,
              supplierTaxId: document.extraction.supplierTaxId,
              invoiceNumber: document.extraction.invoiceNumber,
              issueDate: document.extraction.issueDate?.toISOString() ?? null,
              total: document.extraction.totalAmount?.toNumber() ?? null,
              taxes: document.extraction.taxAmount?.toNumber() ?? null,
              currency: document.extraction.currency,
              lines: document.extraction.lineItems.map((item) => ({
                id: item.id,
                productCode: item.productCode,
                description: item.description,
                productUnit: item.productUnit,
                unitCount: item.unitCount,
                quantity: item.quantity?.toNumber() ?? null,
                unitPrice: item.unitPrice?.toNumber() ?? null,
                linePrice: item.linePrice?.toNumber() ?? null,
                total: item.total?.toNumber() ?? null,
                taxIndicator: item.taxIndicator,
                discountCode: item.discountCode,
                additionalReference: item.additionalReference,
              })),
            }
          : null,
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  async getUsage(payload: { enterpriseId: string }) {
    try {
      const usageWhere = { enterpriseId: payload.enterpriseId };
      const [documents, requests, usageAggregate, usageByModel, usageRows] = await Promise.all([
        this.document.count({
          where: { enterpriseId: payload.enterpriseId },
        }),
        this.documentTokenUsage.count({ where: usageWhere }),
        this.documentTokenUsage.aggregate({
          where: usageWhere,
          _sum: {
            inputTokens: true,
            outputTokens: true,
            totalTokens: true,
          },
        }),
        this.documentTokenUsage.groupBy({
          by: ['model'],
          where: usageWhere,
          _count: { _all: true },
          _sum: {
            inputTokens: true,
            outputTokens: true,
            totalTokens: true,
          },
          orderBy: { model: 'asc' },
        }),
        this.documentTokenUsage.findMany({
          where: usageWhere,
          include: {
            document: {
              select: {
                id: true,
                filename: true,
                documentType: true,
                status: true,
                invoiceId: true,
                processedAt: true,
                createdAt: true,
                extraction: {
                  select: {
                    supplierName: true,
                    invoiceNumber: true,
                    issueDate: true,
                    totalAmount: true,
                    currency: true,
                  },
                },
              },
            },
          },
          orderBy: { createdAt: 'desc' },
        }),
      ]);

      return {
        documents,
        requests,
        inputTokens: usageAggregate._sum.inputTokens ?? 0,
        outputTokens: usageAggregate._sum.outputTokens ?? 0,
        totalTokens: usageAggregate._sum.totalTokens ?? 0,
        byModel: usageByModel.map((entry) => ({
          model: entry.model,
          requests: entry._count._all,
          inputTokens: entry._sum.inputTokens ?? 0,
          outputTokens: entry._sum.outputTokens ?? 0,
          totalTokens: entry._sum.totalTokens ?? 0,
        })),
        byDocument: this.buildUsageByDocument(usageRows),
      };
    } catch (error) {
      throw this.handleError(error);
    }
  }

  private buildUsageByDocument(
    usageRows: Prisma.DocumentTokenUsageGetPayload<{
      include: {
        document: {
          select: {
            id: true;
            filename: true;
            documentType: true;
            status: true;
            invoiceId: true;
            processedAt: true;
            createdAt: true;
            extraction: {
              select: {
                supplierName: true;
                invoiceNumber: true;
                issueDate: true;
                totalAmount: true;
                currency: true;
              };
            };
          };
        };
      };
    }>[],
  ) {
    const byDocument = new Map<
      string,
      {
        documentId: string;
        invoiceId: string | null;
        filename: string;
        documentType: string | null;
        status: string;
        supplierName: string | null;
        invoiceNumber: string | null;
        issueDate: string | null;
        total: number | null;
        currency: string | null;
        processedAt: string | null;
        createdAt: string;
        requests: number;
        inputTokens: number;
        outputTokens: number;
        totalTokens: number;
        byModel: {
          model: string;
          inputTokens: number;
          outputTokens: number;
          totalTokens: number;
        }[];
      }
    >();

    for (const row of usageRows) {
      const extraction = row.document.extraction;
      const current =
        byDocument.get(row.documentId) ??
        {
          documentId: row.documentId,
          invoiceId: row.invoiceId ?? row.document.invoiceId,
          filename: row.document.filename,
          documentType: row.document.documentType,
          status: row.document.status,
          supplierName: extraction?.supplierName ?? null,
          invoiceNumber: extraction?.invoiceNumber ?? null,
          issueDate: extraction?.issueDate?.toISOString() ?? null,
          total: extraction?.totalAmount?.toNumber() ?? null,
          currency: extraction?.currency ?? null,
          processedAt: row.document.processedAt?.toISOString() ?? null,
          createdAt: row.document.createdAt.toISOString(),
          requests: 0,
          inputTokens: 0,
          outputTokens: 0,
          totalTokens: 0,
          byModel: [],
        };

      current.requests += 1;
      current.inputTokens += row.inputTokens;
      current.outputTokens += row.outputTokens;
      current.totalTokens += row.totalTokens;
      current.byModel.push({
        model: row.model,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        totalTokens: row.totalTokens,
      });

      byDocument.set(row.documentId, current);
    }

    return Array.from(byDocument.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async updateDocumentInvoiceId(documentId: string, invoiceId: string) {
    try {
      await this.$transaction(async (tx) => {
        await tx.document.update({
          where: { id: documentId },
          data: { invoiceId },
        });

        await tx.documentTokenUsage.updateMany({
          where: { documentId },
          data: { invoiceId },
        });
      });
      this.logger.log(`✅ Document ${documentId} linked to invoice ${invoiceId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to update document ${documentId} with invoiceId:`, error);
      throw this.handleError(error);
    }
  }

  async health() {
    const pendingCount = await this.document.count({
      where: { status: { in: ['PENDING', 'PROCESSING'] } },
    });

    return {
      status: 'ok',
      processing: pendingCount,
    };
  }

  private async processDocument(documentId: string): Promise<void> {
    const document = await this.document.findUnique({ where: { id: documentId } });

    if (!document) {
      this.logger.warn(`Document ${documentId} not found, skipping`);
      return;
    }

    await this.document.update({
      where: { id: documentId },
      data: { status: 'PROCESSING', errorReason: null },
    });

    let blobName: string | null = null;

    try {
      if (!document.fileData) {
        throw new Error('El documento no contiene datos binarios para procesar');
      }

      const buffer = Buffer.from(document.fileData);
      const mimetype = document.mimetype || 'application/pdf';

      this.logger.log(`📤 Uploading document ${documentId} to blob storage...`);
      blobName = await this.azureBlob.uploadDocument(
        documentId,
        buffer,
        mimetype,
        document.filename,
      );

      this.logger.log(`🔍 Analyzing document ${documentId} with Azure DI...`);
      const documentsUrl = await this.azureBlob.getDocumentUrl(blobName);
      const az = await this.azureDocIntel.analyzeInvoiceFromBuffer(buffer, mimetype, documentsUrl);
      if (!az) {
        throw new Error('Azure Document Intelligence no devolvió resultados');
      }

      await this.persistTokenUsage(documentId, document.enterpriseId, az.usage);

      if (az.InvoiceNumber && document.documentType) {
        const invoiceExists = await this.checkInvoiceExists(
          az.InvoiceNumber,
          document.documentType,
          document.enterpriseId,
        );

        if (invoiceExists.exists) {
          const error: any = new Error(
            `El documento ${document.documentType} con número ${az.InvoiceNumber} ya existe`,
          );
          error.isDuplicate = true;
          throw error;
        }
      }

      const extraction: ExtractionResult = {
        supplierName: az.CompanyName,
        supplierTaxId: az.CompanyTaxId,
        invoiceNumber: az.InvoiceNumber,
        issueDate: az.SaleDate,
        total: az.TotalAmount,
        taxes: az.TotalTaxAmount,
        currency: 'EUR',
        lines: az.Items.map((line) => ({
          ProductCode: line.ProductCode,
          ProductDescription: line.ProductDescription,
          ProductUnit: line.ProductUnit,
          UnitPrice: line.UnitPrice,
          UnitCount: line.UnitCount,
          LinePrice: line.LinePrice,
          Quantity: line.Quantity,
          LineAmount: line.LineAmount,
          TaxIndicator: line.TaxIndicator,
          DiscountCode: line.DiscountCode,
        })),
      };

      await this.persistExtraction(documentId, extraction);

      await this.document.update({
        where: { id: documentId },
        data: {
          status: 'DONE',
          processedAt: new Date(),
          errorReason: null,
          blobName,
          fileData: null,
        },
      });

      this.logger.log(`✅ Document ${documentId} processed and stored successfully`);

      this.client.emit(AnalyzerEvents.analyzed, {
        documentId,
        enterpriseId: document.enterpriseId,
        blobName,
        hasDeliveryNotes: Boolean(document.hasDeliveryNotes),
        documentType: document.documentType,
        extraction: {
          supplierName: extraction.supplierName,
          supplierTaxId: extraction.supplierTaxId,
          invoiceNumber: extraction.invoiceNumber,
          issueDate: extraction.issueDate,
          totalAmount: extraction.total,
          taxAmount: extraction.taxes,
          currency: extraction.currency,
          lines: extraction.lines,
        },
      });
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));

      let errorMessage = err.message;
      if ((error as any)?.response?.message) {
        errorMessage = (error as any).response.message;
      }

      this.logger.error(`Failed to process document ${documentId}`, err);

      if (blobName && (error as any)?.isDuplicate) {
        this.logger.warn(`🗑️ Deleting blob for duplicate document ${documentId}`);
        try {
          await this.azureBlob.deleteDocument(blobName);
          this.logger.log(`✅ Blob ${blobName} deleted successfully`);
        } catch (blobError) {
          this.logger.error(`Failed to delete blob ${blobName}:`, blobError);
        }
      }

      await this.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          errorReason: errorMessage.substring(0, 500),
        },
      });
    }
  }

  private async persistExtraction(documentId: string, extraction: ExtractionResult) {
    await this.$transaction(async (tx) => {
      const record = await tx.extraction.upsert({
        where: { documentId },
        create: {
          documentId,
          supplierName: extraction.supplierName ?? undefined,
          supplierTaxId: extraction.supplierTaxId ?? undefined,
          invoiceNumber: extraction.invoiceNumber ?? undefined,
          issueDate: extraction.issueDate ? new Date(extraction.issueDate) : undefined,
          totalAmount: this.toDecimal(extraction.total),
          taxAmount: this.toDecimal(extraction.taxes),
          currency: extraction.currency ?? undefined,
          rawResponse: extraction as unknown as Prisma.JsonObject,
        },
        update: {
          supplierName: extraction.supplierName ?? undefined,
          supplierTaxId: extraction.supplierTaxId ?? undefined,
          invoiceNumber: extraction.invoiceNumber ?? undefined,
          issueDate: extraction.issueDate ? new Date(extraction.issueDate) : null,
          totalAmount: this.toDecimal(extraction.total),
          taxAmount: this.toDecimal(extraction.taxes),
          currency: extraction.currency ?? undefined,
          rawResponse: extraction as unknown as Prisma.JsonObject,
        },
      });

      await tx.lineItem.deleteMany({ where: { extractionId: record.id } });

      if (extraction.lines.length > 0) {
        await tx.lineItem.createMany({
          data: extraction.lines.map((line) => ({
            extractionId: record.id,
            productCode: line.ProductCode,
            description: line.ProductDescription,
            productUnit: line.ProductUnit,
            unitCount: line.UnitCount,
            quantity: this.toDecimal(line.Quantity),
            unitPrice: this.toDecimal(line.UnitPrice),
            linePrice: this.toDecimal(line.LinePrice),
            total: this.toDecimal(line.LineAmount),
            taxIndicator: line.TaxIndicator,
            discountCode: line.DiscountCode,
            additionalReference: line.AdditionalReference,
          })),
        });
      }
    });
  }

  private async persistTokenUsage(
    documentId: string,
    enterpriseId: string,
    usage: AzureTokenUsageSnapshot | null,
  ) {
    if (!usage || usage.entries.length === 0) {
      return;
    }

    await this.$transaction(
      usage.entries.map((entry) =>
        this.documentTokenUsage.upsert({
          where: {
            documentId_model: {
              documentId,
              model: entry.model,
            },
          },
          create: {
            documentId,
            enterpriseId,
            model: entry.model,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            documentPagesStandard: usage.documentPagesStandard ?? undefined,
            contextualizationTokens: usage.contextualizationTokens ?? undefined,
            rawUsage: usage.rawUsage as Prisma.InputJsonValue,
          },
          update: {
            enterpriseId,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
            totalTokens: entry.totalTokens,
            documentPagesStandard: usage.documentPagesStandard,
            contextualizationTokens: usage.contextualizationTokens,
            rawUsage: usage.rawUsage as Prisma.InputJsonValue,
          },
        }),
      ),
    );
  }

  private async checkInvoiceExists(
    invoiceNumber: string,
    documentType: string,
    enterpriseId: string,
  ): Promise<{ exists: boolean; invoiceId?: string }> {
    try {
      const result = await firstValueFrom(
        this.client.send<{ exists: boolean; invoiceId?: string }>(
          SuppliersSubjects.checkInvoiceExists,
          { invoiceNumber, documentType, enterpriseId },
        ),
      );
      return result;
    } catch (error) {
      this.logger.warn(`No se pudo verificar si la factura existe: ${error}`);
      return { exists: false };
    }
  }

  private toDecimal(value: number | null): Prisma.Decimal | null {
    if (value === null || value === undefined) {
      return null;
    }

    return new Prisma.Decimal(value);
  }

  private handleError(error: unknown): RpcException {
    if (error instanceof RpcException) {
      return error;
    }

    if (error instanceof Prisma.PrismaClientKnownRequestError) {
      return new RpcException({ status: 400, message: error.message });
    }

    this.logger.error(error);
    return new RpcException({ status: 500, message: 'Internal server error' });
  }
}
