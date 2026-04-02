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
    if (!this.gemini.isAvailable) {
      throw new Error(
        'Gemini API не налаштований — аналіз цін неможливий (перевірте GEMINI_API_KEY)',
      );
    }

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
      let lastDocumentError: string | null = null;

      await this.updateStatus(analysisId, 'EXTRACTING_ITEMS');

      for (const doc of rankedDocs) {
        if (!doc.url) {
          this.logger.warn(
            `Analysis ${analysisId}: document "${doc.title ?? 'no title'}" has no URL, skipping`,
          );
          continue;
        }

        try {
          this.logger.log(
            `Analysis ${analysisId}: trying document "${doc.title ?? 'no title'}"`,
          );

          const pdfBuffer = await this.pdfExtractor.downloadPdf(doc.url);

          // OCR extraction via Mistral (always)
          // Pass the full OCR text directly to Gemini — Mistral returns clean markdown,
          // Gemini finds the item table itself without keyword-based pre-filtering.
          const ocrText = await this.mistralOcr.extractTextFromPdf(pdfBuffer);

          // Step 2: Extract items via Gemini
          const docItems: ExtractedItem[] =
            ocrText && ocrText.trim().length >= 50
              ? await this.gemini.extractItemsFromText(
                  ocrText,
                  contractItemReferences,
                )
              : [];

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
        } catch (error: unknown) {
          lastDocumentError =
            error instanceof Error ? error.message : String(error);
          this.logger.warn(
            `Analysis ${analysisId}: failed to process "${doc.title ?? 'no title'}": ${lastDocumentError}`,
          );
          continue;
        }
      }

      if (!succeededDoc) {
        if (lastDocumentError) {
          this.logger.warn(
            `Analysis ${analysisId}: all ranked PDFs failed or produced 0 items; last document error: ${lastDocumentError}`,
          );
        }
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
      await this.prisma.priceAnalysisItem.createMany({
        data: extractedItems.map((item) => ({
          analysisId,
          itemName: item.itemName,
          unitPrice: item.unitPrice,
          quantity: item.quantity,
          unit: item.unit,
        })),
      });

      // Step 3: Search market prices — temporarily disabled
      // TODO: re-enable when market price search is ready

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
        `Analysis ${analysisId} complete: ${extractedItems.length} items`,
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
