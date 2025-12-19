-- AlterTable
ALTER TABLE "LineItem" ADD COLUMN     "productCode" TEXT,
ADD COLUMN     "productUnit" TEXT,
ADD COLUMN     "unitCount" TEXT,
ADD COLUMN     "linePrice" DECIMAL(65,30),
ADD COLUMN     "taxIndicator" TEXT,
ADD COLUMN     "discountCode" TEXT,
ADD COLUMN     "additionalReference" TEXT;
