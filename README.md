# Documents Analyzer Service

Processes uploaded invoices/albaranes and extracts structured data using OpenAI. Exposes NATS request/reply handlers only.

## Setup

```bash
pnpm install
cp .env.example .env
pnpm prisma:generate
pnpm prisma:migrate
pnpm run start:dev
```

Requires PostgreSQL (`DATABASE_URL`) and an OpenAI API key.

## Environment variables

- `NATS_SERVERS`: comma separated list of NATS URLs.
- `DATABASE_URL`: PostgreSQL connection string.
- `OPENAI_API_KEY`: secret key.
- `OPENAI_MODEL`: default `gpt-4o-mini`.
- `OPENAI_REQUEST_TIMEOUT_MS`: client timeout.
- `OPENAI_MAX_RETRIES`: retry count for extraction.
- `PROCESSING_CONCURRENCY`: max concurrent document jobs.

## Prisma schema

**Extracción temporal (IA):**

- `Document` tracks ingestion state and metadata from uploaded files.
- `Extraction` stores normalized invoice data extracted by OpenAI.
- `LineItem` stores the line details associated to an extraction.

**Suppliers & Invoices (persistente):**

- `Supplier` stores supplier information (name, CIF/NIF, address, contacts, delivery terms).
- `Invoice` stores invoice records linked to suppliers and restaurants.
- `InvoiceLine` stores individual line items from invoices.
- `SupplierProduct` links products to suppliers with their references.

## NATS Contracts

| Subject                 | Payload                                                                  | Response                                     |
| ----------------------- | ------------------------------------------------------------------------ | -------------------------------------------- |
| `analyzer.submit`       | `{ buffer(base64), filename, mimetype, notes?, businessId, uploadedBy }` | `{ documentId }`                             |
| `analyzer.getById`      | `{ id, businessId? }`                                                    | `{ status, extraction?, errorReason?, ... }` |
| `analyzer.health.check` | `void`                                                                   | `{ status: 'ok', queued, activeJobs }`       |

### Events

- `documents.analyzed`: emitted with `{ documentId, businessId, supplierName, invoiceNumber, total, currency }`.
- `documents.analysis.failed`: emitted with `{ documentId, businessId, reason }`.

## Processing notes

- Simple in-memory queue ensures up to `PROCESSING_CONCURRENCY` jobs run concurrently.
- Spanish NIF validation applied to supplier tax IDs.
- All numeric values normalized to decimals; dates normalized to ISO 8601 before persistence.
- Raw OpenAI JSON response stored for traceability.
