import { Module } from '@nestjs/common';

import { NatsModule } from 'src/transports/nats.module';
import { DocumentsController } from './documents.controller';
import { DocumentsService } from './documents.service';
import { OpenAiService } from './openai.service';
import { SuppliersEventHandler } from './suppliers-event.handler';
import { AzureDocIntelService } from './azure-docintelligence.service';

@Module({
  imports: [NatsModule],
  controllers: [DocumentsController, SuppliersEventHandler],
  providers: [DocumentsService, OpenAiService, AzureDocIntelService],
})
export class DocumentsModule {}
