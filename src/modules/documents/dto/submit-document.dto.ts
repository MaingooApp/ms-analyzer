import { Transform } from 'class-transformer';
import { IsBase64, IsBoolean, IsOptional, IsString } from 'class-validator';

export class SubmitDocumentDto {
  @IsBase64()
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
