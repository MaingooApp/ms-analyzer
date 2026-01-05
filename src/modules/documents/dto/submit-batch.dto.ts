import { Type } from 'class-transformer';
import { IsArray, ValidateNested, ArrayMinSize, ArrayMaxSize } from 'class-validator';
import { SubmitDocumentDto } from './submit-document.dto';

export class SubmitBatchDto {
  @IsArray()
  @ArrayMinSize(1, { message: 'Debe incluir al menos un documento' })
  @ArrayMaxSize(50, { message: 'El máximo de documentos por lote es 50' })
  @ValidateNested({ each: true })
  @Type(() => SubmitDocumentDto)
  documents!: SubmitDocumentDto[];
}
