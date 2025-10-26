import { IsBase64, IsOptional, IsString, MaxLength } from 'class-validator';

export class SubmitDocumentDto {
  @IsBase64()
  buffer!: string;

  @IsString()
  filename!: string;

  @IsString()
  mimetype!: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @IsString()
  uploadedBy!: string;

  @IsOptional()
  @IsString()
  enterpriseId?: string;
}
