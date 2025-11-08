import { Module } from '@nestjs/common';

import { NatsModule } from 'src/transports/nats.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { SuppliersEventHandler } from './suppliers-event.handler';
import { AzureDocIntelService } from './azure-docintelligence.service';
import { AzureBlobService } from './azure-blob.service';

@Module({
  imports: [NatsModule],
  controllers: [DocumentsController, SuppliersEventHandler],
  providers: [DocumentsService, AzureDocIntelService, AzureBlobService],
})
export class DocumentsModule {}
