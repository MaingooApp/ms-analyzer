import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ClientProxy, RpcException } from '@nestjs/microservices';
import { Prisma, PrismaClient } from '@prisma/client';

import { AnalyzerEvents, envs, NATS_SERVICE } from 'src/config';
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
          notes: payload.notes,
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
        notes: document.notes,
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
                description: item.description,
                quantity: item.quantity?.toNumber() ?? null,
                unitPrice: item.unitPrice?.toNumber() ?? null,
                total: item.total?.toNumber() ?? null,
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
      const az = await this.azureDocIntel.analyzeInvoiceFromBuffer(buffer, mimetype);
      if (!az) {
        throw new Error('Azure Document Intelligence no devolvió resultados');
      }

      const extraction: ExtractionResult = {
        supplierName: az.supplierName,
        supplierTaxId: az.supplierTaxId,
        invoiceNumber: az.invoiceNumber,
        issueDate: az.issueDate,
        total: az.total,
        taxes: az.taxes,
        currency: (az.currency ?? 'EUR').toUpperCase(),
        lines: az.lines.map((line) => ({
          description: line.description,
          productCode: line.productCode,
          quantity: line.quantity,
          unitPrice: line.unitPrice,
          total: line.total,
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

      this.client.emit(AnalyzerEvents.failed, {
        documentId,
        enterpriseId: document.enterpriseId,
        reason: errorMessage,
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
            description: line.description ?? undefined,
            quantity: this.toDecimal(line.quantity),
            unitPrice: this.toDecimal(line.unitPrice),
            total: this.toDecimal(line.total),
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
