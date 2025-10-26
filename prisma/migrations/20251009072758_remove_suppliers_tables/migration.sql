/*
  Warnings:

  - You are about to drop the `Invoice` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `InvoiceLine` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `Supplier` table. If the table is not empty, all the data it contains will be lost.
  - You are about to drop the `SupplierProduct` table. If the table is not empty, all the data it contains will be lost.

*/
-- DropForeignKey
ALTER TABLE "public"."Invoice" DROP CONSTRAINT "Invoice_supplierId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InvoiceLine" DROP CONSTRAINT "InvoiceLine_invoiceId_fkey";

-- DropForeignKey
ALTER TABLE "public"."InvoiceLine" DROP CONSTRAINT "InvoiceLine_suppliersProductId_fkey";

-- DropForeignKey
ALTER TABLE "public"."SupplierProduct" DROP CONSTRAINT "SupplierProduct_supplierId_fkey";

-- DropTable
DROP TABLE "public"."Invoice";

-- DropTable
DROP TABLE "public"."InvoiceLine";

-- DropTable
DROP TABLE "public"."Supplier";

-- DropTable
DROP TABLE "public"."SupplierProduct";
