-- AlterTable
ALTER TABLE "Contract" ADD COLUMN     "contractNumber" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "periodEndDate" TIMESTAMP(3),
ADD COLUMN     "periodStartDate" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "customerLocality" TEXT,
ADD COLUMN     "customerRegion" TEXT,
ADD COLUMN     "description" TEXT,
ADD COLUMN     "procurementMethod" TEXT,
ADD COLUMN     "valueAddedTaxIncluded" BOOLEAN;

-- CreateIndex
CREATE INDEX "Contract_contractNumber_idx" ON "Contract"("contractNumber");

-- CreateIndex
CREATE INDEX "Contract_periodEndDate_idx" ON "Contract"("periodEndDate");

-- CreateIndex
CREATE INDEX "Tender_procurementMethod_idx" ON "Tender"("procurementMethod");

-- CreateIndex
CREATE INDEX "Tender_customerRegion_idx" ON "Tender"("customerRegion");
