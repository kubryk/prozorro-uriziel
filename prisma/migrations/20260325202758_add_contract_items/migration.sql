-- CreateTable
CREATE TABLE "Item" (
    "id" TEXT NOT NULL,
    "description" TEXT,
    "quantity" DOUBLE PRECISION,
    "unitName" TEXT,
    "unitCode" TEXT,
    "classificationId" TEXT,
    "classificationDescription" TEXT,
    "deliveryRegion" TEXT,
    "deliveryLocality" TEXT,
    "contractId" TEXT NOT NULL,

    CONSTRAINT "Item_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Item_classificationId_idx" ON "Item"("classificationId");

-- CreateIndex
CREATE INDEX "Item_contractId_idx" ON "Item"("contractId");

-- CreateIndex
CREATE INDEX "Item_description_idx" ON "Item"("description");

-- AddForeignKey
ALTER TABLE "Item" ADD CONSTRAINT "Item_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "Contract"("id") ON DELETE CASCADE ON UPDATE CASCADE;
