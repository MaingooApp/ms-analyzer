import { IsOptional, IsString } from 'class-validator';

export class GetDocumentDto {
  @IsString()
  id!: string;

  @IsOptional()
  @IsString()
  enterpriseId?: string;
}
