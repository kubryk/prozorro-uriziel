import { Injectable, Logger } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { PdfExtractorService } from './pdf-extractor.service';
import { GeminiService } from './gemini.service';
import { MistralOcrService } from './mistral-ocr.service';
import { PRICE_ANALYSIS_QUEUE_NAME } from '../constants';
import {
  AnalysisJobData,
  ContractItemReference,
  ExtractedItem,
  SkippedAnalysisContract,
  StartedAnalysisContract,
  TriggerBulkAnalysisResult,
  TriggerTenderAnalysisResult,
} from './price-analysis.types';
import { ProzorroDocument } from '../prozorro/prozorro.types';

@Injectable()
export class PriceAnalysisService {
  private readonly logger = new Logger(PriceAnalysisService.name);
  private readonly nonAnalyzableTenderStatuses = new Set([
    'cancelled',
    'unsuccessful',
    'draft',
    'planning',
  ]);
  private readonly nonAnalyzableContractStatuses = new Set(['cancelled']);
  private readonly pendingContractStatuses = new Set(['pending']);

  constructor(
    private readonly prisma: PrismaService,
    private readonly pdfExtractor: PdfExtractorService,
    private readonly gemini: GeminiService,
    private readonly mistralOcr: MistralOcrService,
    @InjectQueue(PRICE_ANALYSIS_QUEUE_NAME)
    private readonly analysisQueue: Queue,
  ) {}

  private buildContractItemReferences(
    items: Array<{
      description?: string | null;
      quantity?: number | null;
      unitName?: string | null;
      classificationDescription?: string | null;
    }>,
  ): ContractItemReference[] {
    return items
      .map((item) => ({
        itemName:
          item.description?.trim() ||
          item.classificationDescription?.trim() ||
          '',
        quantity:
          typeof item.quantity === 'number' && Number.isFinite(item.quantity)
            ? item.quantity
            : null,
        unit: item.unitName?.trim() || null,
        classificationDescription:
          item.classificationDescription?.trim() || null,
      }))
      .filter((item) => item.itemName.length > 0);
  }

  private normalizeStatus(status: string | null | undefined): string | null {
    const normalized = status?.trim().toLowerCase();
    return normalized && normalized.length > 0 ? normalized : null;
  }

  private getTenderSkipReason(
    status: string | null | undefined,
  ): string | null {
    const normalizedStatus = this.normalizeStatus(status);
    if (!normalizedStatus) {
      return null;
    }

    if (this.nonAnalyzableTenderStatuses.has(normalizedStatus)) {
      return `Тендер має статус "${status}", аналіз недоречний`;
    }

    return null;
  }

  private getContractSkipReason(contract: {
    status?: string | null;
    amount?: number | null;
    dateSigned?: Date | null;
  }): string | null {
    const normalizedStatus = this.normalizeStatus(contract.status);

    if (
      normalizedStatus &&
      this.nonAnalyzableContractStatuses.has(normalizedStatus)
    ) {
      return `Контракт має статус "${contract.status}", аналіз недоречний`;
    }

    if (
      normalizedStatus &&
      this.pendingContractStatuses.has(normalizedStatus) &&
      !contract.dateSigned
    ) {
      return `Контракт ще не підписаний або не набрав чинності (статус "${contract.status}")`;
    }

    if (
      typeof contract.amount === 'number' &&
      Number.isFinite(contract.amount) &&
      contract.amount <= 0
    ) {
      return 'У контракту сума 0 або менша, ціновий аналіз недоречний';
    }

    return null;
  }

  private async createSkippedAnalysis(
    contractId: string,
    chatId: string,
    messageId: number | undefined,
    reason: string,
  ): Promise<void> {
    await this.prisma.priceAnalysis.deleteMany({
      where: {
        contractId,
        status: { in: ['FAILED', 'SKIPPED'] },
      },
    });

    await this.prisma.priceAnalysis.create({
      data: {
        contractId,
        status: 'SKIPPED',
        errorMessage: reason,
        telegramChatId: chatId,
        telegramMessageId: messageId,
      },
    });
  }

  /**
   * Queue analysis for all contracts of a single tender.
   * Returns the number of analysis jobs created.
   */
  async triggerTenderAnalysis(
    tenderId: string,
    chatId: string,
    messageId?: number,
  ): Promise<TriggerTenderAnalysisResult> {
    const contracts = await this.prisma.contract.findMany({
      where: { tenderId },
      select: {
        id: true,
        contractID: true,
        contractNumber: true,
        status: true,
        amount: true,
        dateSigned: true,
      },
    });

    if (contracts.length === 0) {
      return {
        count: 0,
        analysisIds: [],
        startedContracts: [],
        skippedContracts: [],
      };
    }

    const analysisIds: string[] = [];
    const startedContracts: StartedAnalysisContract[] = [];
    const skippedContracts: SkippedAnalysisContract[] = [];
    const tender = await this.prisma.tender.findUnique({
      where: { id: tenderId },
      select: {
        status: true,
      },
    });
    const tenderSkipReason = this.getTenderSkipReason(tender?.status);

    for (const contract of contracts) {
      // Skip if already has a pending/in-progress analysis
      const existing = await this.prisma.priceAnalysis.findFirst({
        where: {
          contractId: contract.id,
          status: {
            in: [
              'PENDING',
              'DOWNLOADING_PDF',
              'EXTRACTING_ITEMS',
              'SEARCHING_PRICES',
            ],
          },
        },
      });
      if (existing) {
        analysisIds.push(existing.id);
        startedContracts.push({
          tenderId,
          contractId: contract.id,
          contractID: contract.contractID,
          contractNumber: contract.contractNumber,
          state: 'IN_PROGRESS',
        });
        continue;
      }

      if (tenderSkipReason) {
        await this.createSkippedAnalysis(
          contract.id,
          chatId,
          messageId,
          tenderSkipReason,
        );
        skippedContracts.push({
          tenderId,
          contractId: contract.id,
          contractID: contract.contractID,
          contractNumber: contract.contractNumber,
          reason: tenderSkipReason,
        });
        continue;
      }

      const contractSkipReason = this.getContractSkipReason(contract);
      if (contractSkipReason) {
        await this.createSkippedAnalysis(
          contract.id,
          chatId,
          messageId,
          contractSkipReason,
        );
        skippedContracts.push({
          tenderId,
          contractId: contract.id,
          contractID: contract.contractID,
          contractNumber: contract.contractNumber,
          reason: contractSkipReason,
        });
        continue;
      }

      let hasRankedDocuments = true;
      try {
        const documents = await this.pdfExtractor.fetchContractDocuments(
          contract.id,
        );
        hasRankedDocuments =
          this.pdfExtractor.rankDocuments(documents).length > 0;
      } catch (error: unknown) {
        this.logger.warn(
          `Could not pre-check documents for contract ${contract.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      if (!hasRankedDocuments) {
        await this.createSkippedAnalysis(
          contract.id,
          chatId,
          messageId,
          'У контракту немає PDF-документів для аналізу',
        );
        skippedContracts.push({
          tenderId,
          contractId: contract.id,
          contractID: contract.contractID,
          contractNumber: contract.contractNumber,
          reason: 'У контракту немає PDF-документів для аналізу',
        });
        continue;
      }

      // Remove old FAILED/SKIPPED analyses so they don't block re-analysis
      await this.prisma.priceAnalysis.deleteMany({
        where: {
          contractId: contract.id,
          status: { in: ['FAILED', 'SKIPPED'] },
        },
      });

      const analysis = await this.prisma.priceAnalysis.create({
        data: {
          contractId: contract.id,
          status: 'PENDING',
          telegramChatId: chatId,
          telegramMessageId: messageId,
        },
      });
      analysisIds.push(analysis.id);
      startedContracts.push({
        tenderId,
        contractId: contract.id,
        contractID: contract.contractID,
        contractNumber: contract.contractNumber,
        state: 'QUEUED',
      });

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

    return {
      count: analysisIds.length,
      analysisIds,
      startedContracts,
      skippedContracts,
    };
  }

  /**
   * Queue analysis for multiple tenders.
   */
  async triggerBulkAnalysis(
    tenderIds: string[],
    chatId: string,
  ): Promise<TriggerBulkAnalysisResult> {
    let totalCount = 0;
    const allAnalysisIds: string[] = [];
    const skippedContracts: SkippedAnalysisContract[] = [];
    const startedTenderIds: string[] = [];

    for (const tenderId of tenderIds) {
      const result = await this.triggerTenderAnalysis(tenderId, chatId);
      totalCount += result.count;
      allAnalysisIds.push(...result.analysisIds);
      skippedContracts.push(...result.skippedContracts);
      if (result.analysisIds.length > 0) {
        startedTenderIds.push(tenderId);
      }
    }

    return {
      totalCount,
      analysisIds: allAnalysisIds,
      skippedContracts,
      startedTenderIds,
    };
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
            items: {
              select: {
                description: true,
                quantity: true,
                unitName: true,
                classificationDescription: true,
              },
            },
            tender: { select: { customerRegion: true } },
          },
        },
      },
    });

    if (!analysis) {
      throw new Error(`Analysis ${analysisId} not found`);
    }

    try {
      const contractItemReferences = this.buildContractItemReferences(
        analysis.contract.items,
      );

      // Step 1: Download PDF(s) and extract items — cascade through all ranked documents
      await this.updateStatus(analysisId, 'DOWNLOADING_PDF');

      const documents = await this.pdfExtractor.fetchContractDocuments(
        analysis.contractId,
      );
      const rankedDocs = this.pdfExtractor.rankDocuments(documents);

      if (rankedDocs.length === 0) {
        await this.failAnalysis(
          analysisId,
          'Не знайдено PDF-документів для цього контракту',
        );
        return;
      }

      let extractedItems: ExtractedItem[] = [];
      let succeededDoc: ProzorroDocument | null = null;

      for (const doc of rankedDocs) {
        if (!doc.url) continue;
        this.logger.log(
          `Analysis ${analysisId}: trying document "${doc.title ?? 'no title'}"`,
        );

        let pdfBuffer: Buffer;
        try {
          pdfBuffer = await this.pdfExtractor.downloadPdf(doc.url);
        } catch {
          this.logger.warn(
            `Analysis ${analysisId}: download failed for "${doc.title}", skipping`,
          );
          continue;
        }

        // Text extraction
        const fullText = await this.pdfExtractor.extractTextFromPdf(pdfBuffer);
        let specText =
          fullText && fullText.trim().length >= 50
            ? this.pdfExtractor.extractSpecificationSection(fullText)
            : null;

        // Mistral OCR fallback (scanned PDF)
        if (
          (!specText || specText.trim().length < 50) &&
          this.mistralOcr.isAvailable
        ) {
          this.logger.log(
            `Analysis ${analysisId}: trying Mistral OCR for "${doc.title}"`,
          );
          const ocrText = await this.mistralOcr.extractTextFromPdf(pdfBuffer);
          if (ocrText && ocrText.trim().length >= 50) {
            specText =
              this.pdfExtractor.extractSpecificationSection(ocrText) ?? ocrText;
          }
        }

        // Full-text fallback: spec section not found but document has text
        let effectiveText = specText;
        if (
          (!effectiveText || effectiveText.trim().length < 50) &&
          fullText.length >= 200
        ) {
          this.logger.warn(
            `Analysis ${analysisId}: spec section not found in "${doc.title}", using full-text fallback`,
          );
          // Prices are usually at the end — take the last portion of the text
          effectiveText =
            fullText.length > 12000 ? fullText.slice(-12000) : fullText;
        }

        // Step 2: Extract items via Gemini
        await this.updateStatus(analysisId, 'EXTRACTING_ITEMS');

        let docItems: ExtractedItem[] =
          effectiveText && effectiveText.trim().length >= 50
            ? await this.gemini.extractItemsFromText(
                effectiveText,
                contractItemReferences,
              )
            : [];

        if (docItems.length === 0) {
          const screenshots =
            await this.pdfExtractor.renderPdfScreenshots(pdfBuffer);
          docItems = await this.gemini.extractItemsFromImages(
            screenshots,
            contractItemReferences,
          );
        }

        if (docItems.length > 0) {
          extractedItems = docItems;
          succeededDoc = doc;
          this.logger.log(
            `Analysis ${analysisId}: extracted ${docItems.length} items from "${doc.title}"`,
          );
          break;
        }

        this.logger.warn(
          `Analysis ${analysisId}: 0 items from "${doc.title}", trying next PDF`,
        );
      }

      if (!succeededDoc) {
        await this.failAnalysis(
          analysisId,
          'Не вдалося витягти товари/ціни з жодного PDF',
        );
        return;
      }

      await this.prisma.priceAnalysis.update({
        where: { id: analysisId },
        data: {
          sourceDocumentTitle: succeededDoc.title || 'Unnamed document',
          sourceDocumentUrl: succeededDoc.url,
        },
      });

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
      // TODO: re-enable when item extraction is verified
      // await this.updateStatus(analysisId, 'SEARCHING_PRICES');
      // const region = analysis.contract.tender?.customerRegion ?? null;
      // const marketPrices = await this.gemini.searchMarketPrices(
      //   extractedItems.map((item) => ({
      //     itemName: item.itemName,
      //     unit: item.unit,
      //     quantity: item.quantity,
      //   })),
      //   region,
      // );
      // const savedItems = await this.prisma.priceAnalysisItem.findMany({
      //   where: { analysisId },
      //   orderBy: { id: 'asc' },
      // });
      // let itemsAboveMarket = 0;
      // let weightedDeviationSum = 0;
      // let totalWeight = 0;
      // for (let i = 0; i < savedItems.length; i++) {
      //   const marketData = marketPrices[i];
      //   if (!marketData) continue;
      //   const deviation =
      //     marketData.marketPrice && marketData.marketPrice > 0
      //       ? (savedItems[i].unitPrice - marketData.marketPrice) / marketData.marketPrice
      //       : null;
      //   if (deviation !== null && deviation > 0.2) itemsAboveMarket++;
      //   const itemValue = savedItems[i].unitPrice * (savedItems[i].quantity || 1);
      //   if (deviation !== null) {
      //     weightedDeviationSum += Math.max(0, deviation) * itemValue;
      //     totalWeight += itemValue;
      //   }
      //   await this.prisma.priceAnalysisItem.update({
      //     where: { id: savedItems[i].id },
      //     data: {
      //       marketPrice: marketData.marketPrice,
      //       marketPriceMin: marketData.marketPriceMin,
      //       marketPriceMax: marketData.marketPriceMax,
      //       marketSource: marketData.source,
      //       priceDeviation: deviation,
      //     },
      //   });
      // }
      // const riskScore = totalWeight > 0 ? Math.min(1, weightedDeviationSum / totalWeight) : null;

      await this.prisma.priceAnalysis.update({
        where: { id: analysisId },
        data: {
          status: 'COMPLETE',
          totalItems: extractedItems.length,
          itemsAboveMarket: 0,
          riskScore: null,
        },
      });

      this.logger.log(
        `Analysis ${analysisId} complete: ${extractedItems.length} items extracted (market search skipped)`,
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
      (a) =>
        a.status === 'COMPLETE' ||
        a.status === 'FAILED' ||
        a.status === 'SKIPPED',
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
