-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('PENDING', 'PROCESSING', 'DONE', 'FAILED');

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "enterpriseId" TEXT NOT NULL,
    "uploadedBy" TEXT NOT NULL,
    "filename" TEXT NOT NULL,
    "mimetype" TEXT NOT NULL,
    "fileSize" INTEGER NOT NULL,
    "documentType" TEXT,
    "hasDeliveryNotes" BOOLEAN NOT NULL,
    "status" "DocumentStatus" NOT NULL DEFAULT 'PENDING',
    "errorReason" TEXT,
    "processedAt" TIMESTAMP(3),
    "fileData" BYTEA,
    "blobName" TEXT,
    "invoiceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Extraction" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "supplierName" TEXT,
    "supplierTaxId" TEXT,
    "invoiceNumber" TEXT,
    "issueDate" TIMESTAMP(3),
    "totalAmount" DECIMAL(65,30),
    "taxAmount" DECIMAL(65,30),
    "currency" TEXT,
    "rawResponse" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Extraction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LineItem" (
    "id" TEXT NOT NULL,
    "extractionId" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DECIMAL(65,30),
    "unitPrice" DECIMAL(65,30),
    "total" DECIMAL(65,30),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LineItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Document_enterpriseId_idx" ON "Document"("enterpriseId");

-- CreateIndex
CREATE INDEX "Document_status_idx" ON "Document"("status");

-- CreateIndex
CREATE INDEX "Document_invoiceId_idx" ON "Document"("invoiceId");

-- CreateIndex
CREATE UNIQUE INDEX "Extraction_documentId_key" ON "Extraction"("documentId");

-- CreateIndex
CREATE INDEX "LineItem_extractionId_idx" ON "LineItem"("extractionId");

-- AddForeignKey
ALTER TABLE "Extraction" ADD CONSTRAINT "Extraction_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LineItem" ADD CONSTRAINT "LineItem_extractionId_fkey" FOREIGN KEY ("extractionId") REFERENCES "Extraction"("id") ON DELETE CASCADE ON UPDATE CASCADE;