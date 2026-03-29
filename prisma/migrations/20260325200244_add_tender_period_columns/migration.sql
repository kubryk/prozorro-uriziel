-- AlterTable
ALTER TABLE "Tender" ADD COLUMN     "auctionPeriodStart" TIMESTAMP(3),
ADD COLUMN     "awardPeriodStart" TIMESTAMP(3),
ADD COLUMN     "enquiryPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "enquiryPeriodStart" TIMESTAMP(3),
ADD COLUMN     "tenderPeriodEnd" TIMESTAMP(3),
ADD COLUMN     "tenderPeriodStart" TIMESTAMP(3),
ALTER COLUMN "dateCreated" DROP NOT NULL,
ALTER COLUMN "dateCreated" DROP DEFAULT;

-- CreateIndex
CREATE INDEX "Contract_dateSigned_idx" ON "Contract"("dateSigned");

-- CreateIndex
CREATE INDEX "Tender_tenderPeriodStart_idx" ON "Tender"("tenderPeriodStart");

-- CreateIndex
CREATE INDEX "Tender_tenderPeriodEnd_idx" ON "Tender"("tenderPeriodEnd");

-- CreateIndex
CREATE INDEX "Tender_enquiryPeriodStart_idx" ON "Tender"("enquiryPeriodStart");

-- CreateIndex
CREATE INDEX "Tender_enquiryPeriodEnd_idx" ON "Tender"("enquiryPeriodEnd");

-- CreateIndex
CREATE INDEX "Tender_auctionPeriodStart_idx" ON "Tender"("auctionPeriodStart");

-- CreateIndex
CREATE INDEX "Tender_awardPeriodStart_idx" ON "Tender"("awardPeriodStart");
