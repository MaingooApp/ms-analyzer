import { Module } from '@nestjs/common';

import { DocumentsModule } from './modules/documents/documents.module';
import { NatsModule } from './transports/nats.module';

@Module({
  imports: [NatsModule, DocumentsModule],
})
export class AppModule {}
