-- CreateTable
CREATE TABLE "PriceAnalysis" (
    "id" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "errorMessage" TEXT,
    "totalItems" INTEGER,
    "itemsAboveMarket" INTEGER,
    "riskScore" DOUBLE PRECISION,
    "sourceDocumentTitle" TEXT,
    "telegramChatId" TEXT,
    "telegramMessageId" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "PriceAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PriceAnalysisItem" (
    "id" TEXT NOT NULL,
    "analysisId" TEXT NOT NULL,
    "itemName" TEXT NOT NULL,
    "unitPrice" DOUBLE PRECISION NOT NULL,
    "quantity" DOUBLE PRECISION,
    "unit" TEXT,
    "marketPrice" DOUBLE PRECISION,
    "marketPriceMin" DOUBLE PRECISION,
    "marketPriceMax" DOUBLE PRECISION,
    "marketSource" TEXT,
    "priceDeviation" DOUBLE PRECISION,

    CONSTRAINT "PriceAnalysisItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PriceAnalysis_contractId_idx" ON "PriceAnalysis"("contractId");

-- CreateIndex
CREATE INDEX "PriceAnalysis_status_idx" ON "PriceAnalysis"("status");

-- CreateIndex
CREATE INDEX "PriceAnalysis_riskScore_idx" ON "PriceAnalysis"("riskScore");

-- CreateIndex
CREATE INDEX "PriceAnalysisItem_analysisId_idx" ON "PriceAnalysisItem"("analysisId");

-- CreateIndex
CREATE INDEX "Contract_tenderId_supplierEdrpou_idx" ON "Contract"("tenderId", "supplierEdrpou");

-- CreateIndex
CREATE INDEX "Tender_year_dateModified_idx" ON "Tender"("year", "dateModified");

-- AddForeignKey
ALTER TABLE "PriceAnalysis" ADD CONSTRAINT "PriceAnalysis_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PriceAnalysisItem" ADD CONSTRAINT "PriceAnalysisItem_analysisId_fkey" FOREIGN KEY ("analysisId") REFERENCES "PriceAnalysis"("id") ON DELETE CASCADE ON UPDATE CASCADE;
