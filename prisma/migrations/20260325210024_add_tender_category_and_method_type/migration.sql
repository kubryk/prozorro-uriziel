-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "mainProcurementCategory" TEXT,
ADD COLUMN     "procurementMethodType" TEXT;

-- CreateIndex
CREATE INDEX "Tender_mainProcurementCategory_idx" ON "Tender"("mainProcurementCategory");

-- CreateIndex
CREATE INDEX "Tender_procurementMethodType_idx" ON "Tender"("procurementMethodType");
