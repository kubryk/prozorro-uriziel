-- CreateTable
CREATE TABLE "Lot" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" TEXT,
    "amount" DOUBLE PRECISION,
    "currency" TEXT,
    "valueAddedTaxIncluded" BOOLEAN,
    "tenderId" TEXT NOT NULL,

    CONSTRAINT "Lot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Bid" (
    "id" TEXT NOT NULL,
    "date" TIMESTAMP(3),
    "status" TEXT,
    "amount" DOUBLE PRECISION,
    "currency" TEXT,
    "valueAddedTaxIncluded" BOOLEAN,
    "bidderEdrpou" TEXT,
    "bidderName" TEXT,
    "tenderId" TEXT NOT NULL,

    CONSTRAINT "Bid_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Complaint" (
    "id" TEXT NOT NULL,
    "title" TEXT,
    "description" TEXT,
    "status" TEXT,
    "type" TEXT,
    "dateSubmitted" TIMESTAMP(3),
    "complaintID" TEXT,
    "tenderId" TEXT NOT NULL,

    CONSTRAINT "Complaint_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Lot_tenderId_idx" ON "Lot"("tenderId");

-- CreateIndex
CREATE INDEX "Lot_status_idx" ON "Lot"("status");

-- CreateIndex
CREATE INDEX "Bid_tenderId_idx" ON "Bid"("tenderId");

-- CreateIndex
CREATE INDEX "Bid_bidderEdrpou_idx" ON "Bid"("bidderEdrpou");

-- CreateIndex
CREATE INDEX "Bid_status_idx" ON "Bid"("status");

-- CreateIndex
CREATE INDEX "Complaint_tenderId_idx" ON "Complaint"("tenderId");

-- CreateIndex
CREATE INDEX "Complaint_status_idx" ON "Complaint"("status");

-- AddForeignKey
ALTER TABLE "Lot" ADD CONSTRAINT "Lot_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Bid" ADD CONSTRAINT "Bid_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Complaint" ADD CONSTRAINT "Complaint_tenderId_fkey" FOREIGN KEY ("tenderId") REFERENCES "Tender"("id") ON DELETE CASCADE ON UPDATE CASCADE;
