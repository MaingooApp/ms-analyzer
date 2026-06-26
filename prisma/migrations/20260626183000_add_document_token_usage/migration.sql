-- CreateTable
CREATE TABLE "DocumentTokenUsage" (
    "id" UUID NOT NULL,
    "documentId" UUID NOT NULL,
    "invoiceId" TEXT,
    "enterpriseId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL,
    "outputTokens" INTEGER NOT NULL,
    "totalTokens" INTEGER NOT NULL,
    "documentPagesStandard" INTEGER,
    "contextualizationTokens" INTEGER,
    "rawUsage" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentTokenUsage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "DocumentTokenUsage_documentId_model_key" ON "DocumentTokenUsage"("documentId", "model");

-- CreateIndex
CREATE INDEX "DocumentTokenUsage_enterpriseId_idx" ON "DocumentTokenUsage"("enterpriseId");

-- CreateIndex
CREATE INDEX "DocumentTokenUsage_invoiceId_idx" ON "DocumentTokenUsage"("invoiceId");

-- CreateIndex
CREATE INDEX "DocumentTokenUsage_documentId_idx" ON "DocumentTokenUsage"("documentId");

-- AddForeignKey
ALTER TABLE "DocumentTokenUsage" ADD CONSTRAINT "DocumentTokenUsage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;
