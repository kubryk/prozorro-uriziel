-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "edrpou" TEXT NOT NULL,
    "name" TEXT,
    "region" TEXT,
    "locality" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Company_edrpou_key" ON "Company"("edrpou");

-- CreateIndex
CREATE INDEX "Company_name_idx" ON "Company"("name");

-- CreateIndex
CREATE INDEX "Company_region_idx" ON "Company"("region");

-- AlterTable: Tender - add customerId FK
ALTER TABLE "Tender" ADD COLUMN "customerId" TEXT;

-- AlterTable: Contract - add supplierId FK
ALTER TABLE "Contract" ADD COLUMN "supplierId" TEXT;

-- AlterTable: Bid - add bidderId FK
ALTER TABLE "Bid" ADD COLUMN "bidderId" TEXT;

-- AlterTable: Complaint - add complainant fields
ALTER TABLE "Complaint" ADD COLUMN "complainantEdrpou" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "complainantName" TEXT;
ALTER TABLE "Complaint" ADD COLUMN "complainantId" TEXT;

-- CreateIndex
CREATE INDEX "Tender_customerId_idx" ON "Tender"("customerId");

-- CreateIndex
CREATE INDEX "Contract_supplierId_idx" ON "Contract"("supplierId");

-- CreateIndex
CREATE INDEX "Bid_bidderId_idx" ON "Bid"("bidderId");

-- CreateIndex
CREATE INDEX "Complaint_complainantEdrpou_idx" ON "Complaint"("complainantEdrpou");

-- CreateIndex
CREATE INDEX "Complaint_complainantId_idx" ON "Complaint"("complainantId");

-- AddForeignKey
ALTER TABLE "Tender" ADD CONSTRAINT "Tender_customerId_fkey" FOREIGN KEY ("customerId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Contract" ADD CONSTRAINT "Contract_supplierId_fkey" FOREIGN KEY ("supplierId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_bidderId_fkey" FOREIGN KEY ("bidderId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_complainantId_fkey" FOREIGN KEY ("complainantId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;
