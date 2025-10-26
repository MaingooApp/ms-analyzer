import { Controller, Logger } from '@nestjs/common';
import { EventPattern, Payload } from '@nestjs/microservices';
import { SuppliersEvents } from 'src/config';
import { DocumentsService } from './documents.service';

interface InvoiceProcessedPayload {
  documentId: string;
  invoiceId: string;
  enterpriseId: string;
  success: boolean;
}

@Controller()
export class SuppliersEventHandler {
  private readonly logger = new Logger(SuppliersEventHandler.name);

  constructor(private readonly documentsService: DocumentsService) {}

  @EventPattern(SuppliersEvents.invoiceProcessed)
  async handleInvoiceProcessed(@Payload() payload: InvoiceProcessedPayload) {
    this.logger.log(
      `📥 Received invoice processed event: ${payload.invoiceId} for document ${payload.documentId}`,
    );

    try {
      // Actualizar el documento con el invoiceId
      await this.documentsService.updateDocumentInvoiceId(payload.documentId, payload.invoiceId);

      this.logger.log(
        `✅ Updated document ${payload.documentId} with invoiceId ${payload.invoiceId}`,
      );
    } catch (error) {
      this.logger.error(`❌ Error updating document ${payload.documentId}:`, error);
    }
  }
}
