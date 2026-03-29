import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { GeminiService } from './gemini.service';
import { PRICE_ANALYSIS_QUEUE_NAME } from '../constants';
import { AnalysisJobData } from './price-analysis.types';

@Injectable()
export class PriceAnalysisService {
  private readonly logger = new Logger(PriceAnalysisService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfExtractor: PdfExtractorService,
    private readonly gemini: GeminiService,
    @InjectQueue(PRICE_ANALYSIS_QUEUE_NAME) private readonly analysisQueue: Queue,
  ) {}

  /**
   * Queue analysis for all contracts of a single tender.
   * Returns the number of analysis jobs created.
   */
  async triggerTenderAnalysis(
    tenderId: string,
    chatId: string,
    messageId?: number,
  ): Promise<{ count: number; analysisIds: string[] }> {
    const contracts = await this.prisma.contract.findMany({
      where: { tenderId },
      select: { id: true },
    });

    if (contracts.length === 0) {
      return { count: 0, analysisIds: [] };
    }

    const analysisIds: string[] = [];

    for (const contract of contracts) {
      // Skip if already has a pending/in-progress analysis
      const existing = await this.prisma.priceAnalysis.findFirst({
        where: {
          contractId: contract.id,
          status: {
            in: ['PENDING', 'DOWNLOADING_PDF', 'EXTRACTING_ITEMS', 'SEARCHING_PRICES'],
          },
        },
      });
      if (existing) {
        analysisIds.push(existing.id);
        continue;
      }

      const analysis = await this.prisma.priceAnalysis.create({
        data: {
          contractId: contract.id,
          status: 'PENDING',
          telegramChatId: chatId,
          telegramMessageId: messageId,
        },
      });
      analysisIds.push(analysis.id);

      await this.analysisQueue.add(
        'analyze-contract',
        { analysisId: analysis.id } satisfies AnalysisJobData,
        {
          jobId: `analysis-${analysis.id}`,
          attempts: 2,
          backoff: { type: 'exponential', delay: 10_000 },
          removeOnComplete: true,
          removeOnFail: { count: 500 },
        },
      );
    }

    return { count: analysisIds.length, analysisIds };
  }

  /**
   * Queue analysis for multiple tenders.
   */
  async triggerBulkAnalysis(
    tenderIds: string[],
    chatId: string,
  ): Promise<{ totalCount: number; analysisIds: string[] }> {
    let totalCount = 0;
    const allAnalysisIds: string[] = [];

    for (const tenderId of tenderIds) {
      const result = await this.triggerTenderAnalysis(tenderId, chatId);
      totalCount += result.count;
      allAnalysisIds.push(...result.analysisIds);
    }

    return { totalCount, analysisIds: allAnalysisIds };
  }

  /**
   * Core analysis pipeline — called by the BullMQ processor.
   */
  async runAnalysisPipeline(analysisId: string): Promise<void> {
    const analysis = await this.prisma.priceAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        contract: {
          include: {
            tender: { select: { customerRegion: true } },
          },
        },
      },
    });

    if (!analysis) {
      throw new Error(`Analysis ${analysisId} not found`);
    }

    try {
      // Step 1: Download PDF
      await this.updateStatus(analysisId, 'DOWNLOADING_PDF');

      const documents = await this.pdfExtractor.fetchContractDocuments(
        analysis.contractId,
      );
      const bestDoc = this.pdfExtractor.selectBestDocument(documents);

      if (!bestDoc?.url) {
        await this.failAnalysis(analysisId, 'Не знайдено PDF-документів для цього контракту');
        return;
      }

      await this.prisma.priceAnalysis.update({
        where: { id: analysisId },
        data: { sourceDocumentTitle: bestDoc.title || 'Unnamed document' },
      });

      const fullText = await this.pdfExtractor.downloadAndExtractPdf(bestDoc.url);

      if (!fullText || fullText.trim().length < 50) {
        await this.failAnalysis(analysisId, 'Не вдалося витягти текст з PDF');
        return;
      }

      const specText = this.pdfExtractor.extractSpecificationSection(fullText);

      // Step 2: Extract items via Gemini
      await this.updateStatus(analysisId, 'EXTRACTING_ITEMS');

      const extractedItems = await this.gemini.extractItemsFromText(specText);

      if (extractedItems.length === 0) {
        await this.failAnalysis(analysisId, 'Не вдалося витягти товари/ціни зі специфікації');
        return;
      }

      // Save extracted items
      for (const item of extractedItems) {
        await this.prisma.priceAnalysisItem.create({
          data: {
            analysisId,
            itemName: item.itemName,
            unitPrice: item.unitPrice,
            quantity: item.quantity,
            unit: item.unit,
          },
        });
      }

      // Step 3: Search market prices
      await this.updateStatus(analysisId, 'SEARCHING_PRICES');

      const region = analysis.contract.tender?.customerRegion ?? null;

      const marketPrices = await this.gemini.searchMarketPrices(
        extractedItems.map((item) => ({
          itemName: item.itemName,
          unit: item.unit,
        })),
        region,
      );

      // Update items with market prices and compute deviations
      const savedItems = await this.prisma.priceAnalysisItem.findMany({
        where: { analysisId },
        orderBy: { id: 'asc' },
      });

      let itemsAboveMarket = 0;
      let weightedDeviationSum = 0;
      let totalWeight = 0;

      for (let i = 0; i < savedItems.length; i++) {
        const marketData = marketPrices[i];
        if (!marketData) continue;

        const deviation =
          marketData.marketPrice && marketData.marketPrice > 0
            ? (savedItems[i].unitPrice - marketData.marketPrice) /
              marketData.marketPrice
            : null;

        if (deviation !== null && deviation > 0.2) {
          itemsAboveMarket++;
        }

        // Weight by item value (unitPrice * quantity) for risk score
        const itemValue =
          savedItems[i].unitPrice * (savedItems[i].quantity || 1);
        if (deviation !== null) {
          weightedDeviationSum += Math.max(0, deviation) * itemValue;
          totalWeight += itemValue;
        }

        await this.prisma.priceAnalysisItem.update({
          where: { id: savedItems[i].id },
          data: {
            marketPrice: marketData.marketPrice,
            marketPriceMin: marketData.marketPriceMin,
            marketPriceMax: marketData.marketPriceMax,
            marketSource: marketData.source,
            priceDeviation: deviation,
          },
        });
      }

      // Compute risk score: 0.0 - 1.0
      const riskScore =
        totalWeight > 0
          ? Math.min(1, weightedDeviationSum / totalWeight)
          : null;

      await this.prisma.priceAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'COMPLETE',
          totalItems: savedItems.length,
          itemsAboveMarket,
          riskScore,
        },
      });

      this.logger.log(
        `Analysis ${analysisId} complete: ${savedItems.length} items, risk=${riskScore?.toFixed(2)}, ${itemsAboveMarket} above market`,
      );
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Analysis ${analysisId} failed: ${err.message}`,
        err.stack,
      );
      await this.failAnalysis(analysisId, err.message);
      throw error; // Re-throw so BullMQ can retry
    }
  }

  /**
   * Get a completed analysis with all items.
   */
  async getAnalysis(analysisId: string) {
    return this.prisma.priceAnalysis.findUnique({
      where: { id: analysisId },
      include: {
        extractedItems: { orderBy: { priceDeviation: 'desc' } },
        contract: {
          select: {
            contractID: true,
            supplierName: true,
            supplierEdrpou: true,
            amount: true,
            tenderId: true,
          },
        },
      },
    });
  }

  /**
   * Check if all analyses for a tender are complete.
   * Returns the full list if all done, null otherwise.
   */
  async getTenderAnalysisIfComplete(tenderId: string) {
    const contracts = await this.prisma.contract.findMany({
      where: { tenderId },
      select: { id: true },
    });

    const analyses = await this.prisma.priceAnalysis.findMany({
      where: {
        contractId: { in: contracts.map((c) => c.id) },
      },
      include: {
        extractedItems: { orderBy: { priceDeviation: 'desc' } },
        contract: {
          select: {
            contractID: true,
            supplierName: true,
            supplierEdrpou: true,
            amount: true,
          },
        },
      },
      orderBy: { createdAt: 'desc' },
    });

    // Take the latest analysis per contract
    const latestByContract = new Map<string, (typeof analyses)[number]>();
    for (const a of analyses) {
      if (!latestByContract.has(a.contractId)) {
        latestByContract.set(a.contractId, a);
      }
    }

    const latest = [...latestByContract.values()];
    const allDone = latest.every(
      (a) => a.status === 'COMPLETE' || a.status === 'FAILED',
    );

    return allDone ? latest : null;
  }

  private async updateStatus(analysisId: string, status: string) {
    await this.prisma.priceAnalysis.update({
      where: { id: analysisId },
      data: { status },
    });
  }

  private async failAnalysis(analysisId: string, errorMessage: string) {
    await this.prisma.priceAnalysis.update({
      where: { id: analysisId },
      data: { status: 'FAILED', errorMessage },
    });
  }
}
