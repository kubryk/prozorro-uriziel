import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { PRICE_ANALYSIS_QUEUE_NAME } from '../constants';
import { PriceAnalysisService } from './price-analysis.service';
import { AnalysisJobData } from './price-analysis.types';

const STATS_INTERVAL_MS = 30_000;
const DEFAULT_CONCURRENCY = 3;
const DEFAULT_LOCK_DURATION_MS = 600_000; // 10 minutes — PDF download + 2 LLM calls

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isNaN(parsed) || parsed < 1 ? fallback : parsed;
}

@Processor(PRICE_ANALYSIS_QUEUE_NAME, {
  concurrency: parsePositiveIntEnv(
    process.env.PRICE_ANALYSIS_CONCURRENCY,
    DEFAULT_CONCURRENCY,
  ),
  lockDuration: DEFAULT_LOCK_DURATION_MS,
})
export class PriceAnalysisProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(PriceAnalysisProcessor.name);
  private statsInterval: ReturnType<typeof setInterval>;

  private completedCount = 0;
  private failedCount = 0;

  constructor(private readonly priceAnalysisService: PriceAnalysisService) {
    super();

    this.statsInterval = setInterval(() => {
      if (this.completedCount === 0 && this.failedCount === 0) return;

      this.logger.log(
        `📊 За ${STATS_INTERVAL_MS / 1000}с: ${this.completedCount} аналізів завершено, ${this.failedCount} помилок`,
      );
      this.completedCount = 0;
      this.failedCount = 0;
    }, STATS_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.statsInterval);
  }

  async process(job: Job<AnalysisJobData>): Promise<void> {
    const { analysisId } = job.data;
    this.logger.log(`Processing price analysis ${analysisId}`);

    try {
      await this.priceAnalysisService.runAnalysisPipeline(analysisId);
      this.completedCount++;

      // Check if all analyses for this tender are done → notify Telegram
      const analysis = await this.priceAnalysisService.getAnalysis(analysisId);
      if (analysis?.contract?.tenderId) {
        const allDone =
          await this.priceAnalysisService.getTenderAnalysisIfComplete(
            analysis.contract.tenderId,
          );
        if (allDone && analysis.telegramChatId) {
          // Emit event or call notification service
          // This will be handled by the Telegram module listening to completed analyses
          this.logger.log(
            `All analyses for tender ${analysis.contract.tenderId} complete. Chat ${analysis.telegramChatId} should be notified.`,
          );
        }
      }
    } catch (error: unknown) {
      this.failedCount++;
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Price analysis ${analysisId} failed: ${err.message}`,
        err.stack,
      );
      throw error; // Let BullMQ handle retries
    }
  }
}
