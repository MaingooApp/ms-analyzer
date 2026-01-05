import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import { AnalyzerSubjects } from 'src/config';
import { DocumentsService } from './documents.service';
import { SubmitDocumentDto, SubmitBatchDto, GetDocumentDto } from './dto';

@Controller()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @MessagePattern(AnalyzerSubjects.submit)
  submit(@Payload() payload: SubmitDocumentDto) {
    return this.documentsService.submit(payload);
  }

  @MessagePattern(AnalyzerSubjects.submitBatch)
  submitBatch(@Payload() payload: SubmitBatchDto) {
    return this.documentsService.submitBatch(payload);
  }

  @MessagePattern(AnalyzerSubjects.getById)
  getById(@Payload() payload: GetDocumentDto) {
    return this.documentsService.getById(payload);
  }

  @MessagePattern(AnalyzerSubjects.health)
  health() {
    return this.documentsService.health();
  }
}
