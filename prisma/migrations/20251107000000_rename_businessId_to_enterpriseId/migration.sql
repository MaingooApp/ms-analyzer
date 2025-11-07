-- AlterTable: Rename businessId to enterpriseId
ALTER TABLE "Document" RENAME COLUMN "businessId" TO "enterpriseId";

-- Add invoiceId column if it doesn't exist
DO $$ 
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns 
        WHERE table_name = 'Document' AND column_name = 'invoiceId'
    ) THEN
        ALTER TABLE "Document" ADD COLUMN "invoiceId" TEXT;
    END IF;
END $$;

-- CreateIndex
CREATE INDEX IF NOT EXISTS "Document_enterpriseId_idx" ON "Document"("enterpriseId");
CREATE INDEX IF NOT EXISTS "Document_status_idx" ON "Document"("status");
CREATE INDEX IF NOT EXISTS "Document_invoiceId_idx" ON "Document"("invoiceId");

-- Drop old index if exists
DROP INDEX IF EXISTS "Document_businessId_idx";
