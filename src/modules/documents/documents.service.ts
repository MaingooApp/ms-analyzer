import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { firstValueFrom } from 'rxjs';
import { Prisma, PrismaClient } from '@prisma/client';

import { AnalyzerEvents, envs, NATS_SERVICE, SuppliersSubjects } from 'src/config';
import { SubmitDocumentDto, GetDocumentDto } from './dto';
import type { ExtractionResult } from './interfaces';
import { AzureDocIntelService } from './azure-docintelligence.service';
import { AzureBlobService } from './azure-blob.service';

@Injectable()
export class DocumentsService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(DocumentsService.name);
  private readonly queue: string[] = [];
  private activeJobs = 0;

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
    await this.requeuePending();
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

      this.enqueue(document.id);

      return { documentId: document.id };
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

  async updateDocumentInvoiceId(documentId: string, invoiceId: string) {
    try {
      await this.document.update({
        where: { id: documentId },
        data: { invoiceId },
      });
      this.logger.log(`✅ Document ${documentId} linked to invoice ${invoiceId}`);
    } catch (error) {
      this.logger.error(`❌ Failed to update document ${documentId} with invoiceId:`, error);
      throw this.handleError(error);
    }
  }

  async health() {
    return {
      status: 'ok',
      queued: this.queue.length,
      activeJobs: this.activeJobs,
    };
  }

  private enqueue(documentId: string) {
    this.queue.push(documentId);
    void this.drainQueue();
  }

  private async drainQueue(): Promise<void> {
    if (this.activeJobs >= envs.processingConcurrency) {
      return;
    }

    const nextId = this.queue.shift();
    if (!nextId) {
      return;
    }

    this.activeJobs += 1;

    try {
      await this.processDocument(nextId);
    } catch (error) {
      this.logger.error(`Failed to process document ${nextId}`, error as Error);
    } finally {
      this.activeJobs -= 1;
      if (this.queue.length > 0) {
        void this.drainQueue();
      }
    }
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

    try {
      if (!document.fileData) {
        throw new Error('El documento no contiene datos binarios para procesar');
      }

      const buffer = Buffer.from(document.fileData);
      const mimetype = document.mimetype || 'application/pdf';

      this.logger.log(`📤 Uploading document ${documentId} to blob storage...`);
      const blobName = await this.azureBlob.uploadDocument(
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

      if (az.InvoiceNumber && document.documentType) {
        const invoiceExists = await this.checkInvoiceExists(
          az.InvoiceNumber,
          document.documentType,
          document.enterpriseId,
        );

        if (invoiceExists.exists) {
          throw new Error(
            `El documento ${document.documentType} con número ${az.InvoiceNumber} ya existe`,
          );
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

      // Extraer mensaje más específico si viene de HttpException de NestJS
      let errorMessage = err.message;
      if ((error as any)?.response?.message) {
        errorMessage = (error as any).response.message;
      }

      this.logger.error(`Failed to process document ${documentId}`, err);

      await this.document.update({
        where: { id: documentId },
        data: {
          status: 'FAILED',
          errorReason: errorMessage.substring(0, 500), // Limitar longitud del mensaje
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

  private async requeuePending(): Promise<void> {
    const pending = await this.document.findMany({
      where: {
        status: {
          in: ['PENDING', 'PROCESSING'],
        },
      },
      select: { id: true },
    });

    for (const doc of pending) {
      this.enqueue(doc.id);
    }
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
