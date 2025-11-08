import { Injectable, Logger } from '@nestjs/common';
import {
  BlobServiceClient,
  ContainerClient,
  generateBlobSASQueryParameters,
  BlobSASPermissions,
  StorageSharedKeyCredential,
} from '@azure/storage-blob';
import { envs } from 'src/config';

@Injectable()
export class AzureBlobService {
  private readonly logger = new Logger(AzureBlobService.name);
  private readonly containerClient: ContainerClient;
  private readonly accountName: string;
  private readonly accountKey: string;

  constructor() {
    const blobServiceClient = BlobServiceClient.fromConnectionString(
      envs.azureStorageConnectionString,
    );

    this.containerClient = blobServiceClient.getContainerClient(envs.documentsContainerName);

    // Extraer accountName y accountKey del connection string para SAS tokens
    const connStrMatch = envs.azureStorageConnectionString.match(
      /AccountName=([^;]+).*AccountKey=([^;]+)/,
    );

    if (connStrMatch) {
      this.accountName = connStrMatch[1];
      this.accountKey = connStrMatch[2];
    } else {
      throw new Error('Invalid Azure Storage connection string format');
    }

    this.logger.log('✅ Azure Blob Service initialized');
  }

  /**
   * Sube un documento al blob storage con tier Cool (Esporádico)
   */
  async uploadDocument(
    documentId: string,
    buffer: Buffer,
    mimetype: string,
    filename: string,
  ): Promise<string> {
    try {
      const extension = filename.split('.').pop() || 'pdf';
      const blobName = `${documentId}.${extension}`;
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

      // Subir con tier Cool directamente
      await blockBlobClient.upload(buffer, buffer.length, {
        blobHTTPHeaders: {
          blobContentType: mimetype,
          blobContentDisposition: `inline; filename="${filename}"`,
        },
        metadata: {
          originalFilename: filename,
          uploadedAt: new Date().toISOString(),
          documentId,
        },
        tier: 'Cool', // Tier esporádico desde el inicio
      });

      this.logger.log(`✅ Document uploaded to Cool tier: ${blobName}`);
      return blobName;
    } catch (error) {
      this.logger.error('Failed to upload document to blob storage', error);
      throw error;
    }
  }

  /**
   * Genera URL temporal con SAS token para acceso seguro
   * @param expiresInHours - Horas de validez del link (default: 24h para exportaciones)
   */
  async getDocumentUrl(blobName: string, expiresInHours: number = 24): Promise<string> {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);

      const sharedKeyCredential = new StorageSharedKeyCredential(this.accountName, this.accountKey);

      const sasToken = generateBlobSASQueryParameters(
        {
          containerName: this.containerClient.containerName,
          blobName,
          permissions: BlobSASPermissions.parse('r'),
          startsOn: new Date(),
          expiresOn: new Date(Date.now() + expiresInHours * 60 * 60 * 1000),
        },
        sharedKeyCredential,
      ).toString();

      return `${blockBlobClient.url}?${sasToken}`;
    } catch (error) {
      this.logger.error(`Failed to generate SAS URL for blob: ${blobName}`, error);
      throw error;
    }
  }

  /**
   * Genera múltiples URLs para exportación masiva
   * Optimizado para lotes grandes
   */
  async getMultipleDocumentUrls(
    blobNames: string[],
    expiresInHours: number = 48,
  ): Promise<Map<string, string>> {
    const urls = new Map<string, string>();

    // Procesar en paralelo (máximo 50 a la vez para no saturar)
    const batchSize = 50;
    for (let i = 0; i < blobNames.length; i += batchSize) {
      const batch = blobNames.slice(i, i + batchSize);
      const batchUrls = await Promise.all(
        batch.map(async (blobName) => {
          try {
            const url = await this.getDocumentUrl(blobName, expiresInHours);
            return { blobName, url };
          } catch (error) {
            this.logger.warn(`Failed to generate URL for ${blobName}:`, error);
            return { blobName, url: null };
          }
        }),
      );

      batchUrls.forEach(({ blobName, url }) => {
        if (url) urls.set(blobName, url);
      });
    }

    this.logger.log(`📦 Generated ${urls.size}/${blobNames.length} URLs for export`);
    return urls;
  }

  async deleteDocument(blobName: string): Promise<void> {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      await blockBlobClient.deleteIfExists();
      this.logger.log(`🗑️ Document deleted from blob storage: ${blobName}`);
    } catch (error) {
      this.logger.error(`Failed to delete document: ${blobName}`, error);
      throw error;
    }
  }

  async documentExists(blobName: string): Promise<boolean> {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      return await blockBlobClient.exists();
    } catch (error) {
      this.logger.error(`Failed to check document existence: ${blobName}`, error);
      return false;
    }
  }

  /**
   * Obtiene metadata del blob sin descargar el archivo
   */
  async getDocumentMetadata(blobName: string) {
    try {
      const blockBlobClient = this.containerClient.getBlockBlobClient(blobName);
      const properties = await blockBlobClient.getProperties();

      return {
        contentType: properties.contentType,
        contentLength: properties.contentLength,
        metadata: properties.metadata,
        tier: properties.accessTier,
        lastModified: properties.lastModified,
      };
    } catch (error) {
      this.logger.error(`Failed to get metadata for: ${blobName}`, error);
      throw error;
    }
  }
}
