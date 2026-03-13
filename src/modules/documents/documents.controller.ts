import { Controller } from '@nestjs/common';
import { MessagePattern, Payload } from '@nestjs/microservices';

import {
  extractToolRequest,
  requireToolPermission,
  resolveToolEnterpriseId,
} from 'src/common/tool-request';
import { AnalyzerSubjects } from 'src/config';
import { DocumentsService } from './documents.service';
import { SubmitDocumentDto, SubmitBatchDto, GetDocumentDto } from './dto';

@Controller()
export class DocumentsController {
  constructor(private readonly documentsService: DocumentsService) {}

  @MessagePattern(AnalyzerSubjects.submit)
  submit(@Payload() payload: unknown) {
    const request = extractToolRequest<SubmitDocumentDto>(payload);
    requireToolPermission(request.context, 'documents.write');
    const enterpriseId = resolveToolEnterpriseId(request.context, request.data.enterpriseId);
    return this.documentsService.submit({ ...request.data, enterpriseId });
  }

  @MessagePattern(AnalyzerSubjects.submitBatch)
  submitBatch(@Payload() payload: unknown) {
    const request = extractToolRequest<SubmitBatchDto>(payload);
    requireToolPermission(request.context, 'documents.write');

    const enterpriseId = resolveToolEnterpriseId(request.context);

    return this.documentsService.submitBatch({
      documents: request.data.documents.map((document) => ({
        ...document,
        enterpriseId,
      })),
    });
  }

  @MessagePattern(AnalyzerSubjects.getById)
  getById(@Payload() payload: unknown) {
    const request = extractToolRequest<GetDocumentDto>(payload);
    requireToolPermission(request.context, 'documents.read');
    const enterpriseId = resolveToolEnterpriseId(request.context, request.data.enterpriseId);
    return this.documentsService.getById({ ...request.data, enterpriseId });
  }

  @MessagePattern(AnalyzerSubjects.health)
  health() {
    return this.documentsService.health();
  }
}
