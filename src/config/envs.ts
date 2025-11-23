import 'dotenv/config';
import * as joi from 'joi';

interface EnvVars {
  PORT: number;
  NATS_SERVERS: string[];
  DATABASE_URL: string;
  PROCESSING_CONCURRENCY: number;
  AZURE_STORAGE_CONNECTION_STRING: string;
  AZURE_DOCUMENTS_CONTAINER: string;
  CU_ENDPOINT: string;
  CU_KEY: string;
}

const envSchema = joi
  .object<EnvVars>({
    PORT: joi.number().default(3002),
    NATS_SERVERS: joi.array().items(joi.string()).min(1).required(),
    DATABASE_URL: joi
      .string()
      .uri()
      .pattern(/^postgres(?:ql)?:/i, { name: 'PostgreSQL connection string' })
      .required(),
    PROCESSING_CONCURRENCY: joi.number().integer().min(1).default(2),
    AZURE_STORAGE_CONNECTION_STRING: joi.string().required(),
    CU_ENDPOINT: joi.string().required(),
    CU_KEY: joi.string().required(),
    AZURE_DOCUMENTS_CONTAINER: joi.string().default('invoices'),
  })
  .unknown(true);

const { error, value } = envSchema.validate({
  ...process.env,
  NATS_SERVERS: process.env['NATS_SERVERS']?.split(',').map((item) => item.trim()),
});

if (error) {
  throw new Error(`Config validation error: ${error.message}`);
}

const envVars = value as EnvVars;

export const envs = {
  port: envVars.PORT,
  natsServers: envVars.NATS_SERVERS,
  databaseUrl: envVars.DATABASE_URL,
  processingConcurrency: envVars.PROCESSING_CONCURRENCY,
  azureStorageConnectionString: envVars.AZURE_STORAGE_CONNECTION_STRING,
  documentsContainerName: envVars.AZURE_DOCUMENTS_CONTAINER,
  cuEndpoint: envVars.CU_ENDPOINT,
  cuKey: envVars.CU_KEY,
};
