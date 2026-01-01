import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

export class SubmitDocumentDto {
  @IsString()
  buffer!: string;

  @IsString()
  filename!: string;

  @IsString()
  mimetype!: string;

  @IsString()
  documentType!: string;

  @Transform(({ value }) => value === 'true' || value === true)
  @IsBoolean()
  hasDeliveryNotes!: boolean;

  @IsString()
  uploadedBy!: string;

  @IsOptional()
  @IsString()
  enterpriseId?: string;
}
