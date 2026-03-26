import { Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { ProzorroService } from '../prozorro/prozorro.service';
import { TENDER_QUEUE_NAME } from '../constants';

@Injectable()
export class SyncService implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(SyncService.name);
  private isSyncing = false;
  private addedCount = 0;
  private statsInterval: ReturnType<typeof setInterval>;
  private readonly incompleteSyncStatuses = ['PARTIAL', 'FAILED'] as const;
  private readonly mainQueueFailedJobsToKeep = (() => {
    const parsed = Number.parseInt(
      process.env.MAIN_QUEUE_FAILED_JOBS_TO_KEEP || '1000',
      10,
    );

    if (Number.isNaN(parsed) || parsed < 0) {
      return 1000;
    }

    return parsed;
  })();
  private readonly retryableJobStates = new Set([
    'waiting',
    'active',
    'delayed',
    'prioritized',
    'waiting-children',
  ]);

  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroApi: ProzorroService,
    @InjectQueue(TENDER_QUEUE_NAME) private readonly tenderQueue: Queue,
  ) {
    // Print sync stats every 30 seconds
    this.statsInterval = setInterval(async () => {
      if (process.env.APP_ROLE === 'WORKER') return;
      try {
        const [counts, incompleteTendersCount] = await Promise.all([
          this.tenderQueue.getJobCounts('waiting', 'active', 'failed'),
          this.prisma.tender.count({
            where: { syncStatus: { in: [...this.incompleteSyncStatuses] } },
          }),
        ]);
        if (
          this.addedCount === 0 &&
          counts.waiting === 0 &&
          counts.active === 0 &&
          incompleteTendersCount === 0
        ) {
          return;
        }
        this.logger.log(
          `📥 За 30с: додано ${this.addedCount} тендерів у чергу | Черга: ${counts.waiting} очікують, ${counts.active} активних, ${counts.failed} історичних failed jobs | БД: ${incompleteTendersCount} незавершених тендерів`,
        );
        this.addedCount = 0;
      } catch { /* ignore */ }
    }, 30_000);
  }

  async onApplicationBootstrap() {
    this.logger.log('SyncService initialized, checking initial offset...');
  }

  onModuleDestroy() {
    clearInterval(this.statsInterval);
  }

  private buildMainJobId(tender: {
    id: string;
    dateModified?: string | Date;
  }): string {
    const rawDateModified =
      tender.dateModified instanceof Date
        ? Number.isNaN(tender.dateModified.getTime())
          ? ''
          : tender.dateModified.toISOString()
        : typeof tender.dateModified === 'string'
          ? tender.dateModified
          : '';
    const parsedDateModified = rawDateModified ? new Date(rawDateModified) : null;

    if (parsedDateModified && !Number.isNaN(parsedDateModified.getTime())) {
      return `main-${tender.id}-${parsedDateModified.getTime()}`;
    }

    const normalizedDateModified = rawDateModified.replace(/[^a-zA-Z0-9_-]/g, '_');
    return normalizedDateModified
      ? `main-${tender.id}-${normalizedDateModified}`
      : `main-${tender.id}`;
  }

  private async queueRetryForTender(tender: {
    id: string;
    dateModified: Date;
  }): Promise<void> {
    const retryJobId = `retry-${tender.id}`;
    const existingRetryJob = await this.tenderQueue.getJob(retryJobId);

    if (!existingRetryJob) {
      await this.tenderQueue.add(
        'process-tender',
        { tenderId: tender.id, dateModified: tender.dateModified },
        {
          jobId: retryJobId,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5000 },
          removeOnComplete: true,
          removeOnFail: true,
        },
      );
      return;
    }

    const existingState = await existingRetryJob.getState();

    if (existingState === 'failed' || existingState === 'completed') {
      await existingRetryJob.retry(existingState, {
        resetAttemptsMade: true,
        resetAttemptsStarted: true,
      });
      return;
    }

    if (this.retryableJobStates.has(existingState)) {
      this.logger.log(
        `Retry job ${retryJobId} already exists in state ${existingState}, skipping duplicate enqueue.`,
      );
      return;
    }

    this.logger.warn(
      `Retry job ${retryJobId} has unexpected state ${existingState}. Recreating it.`,
    );
    await existingRetryJob.remove();
    await this.tenderQueue.add(
      'process-tender',
      { tenderId: tender.id, dateModified: tender.dateModified },
      {
        jobId: retryJobId,
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
  }

  @Cron('*/6 * * * * *') // Run every 6 seconds (~500 tenders per 30s)
  async handleSync() {
    // If this instance is only a worker, do not fetch new pages
    if (process.env.APP_ROLE === 'WORKER') return;

    if (this.isSyncing) return;
    this.isSyncing = true;

    try {
      let syncState = await this.prisma.syncState.findUnique({
        where: { id: 1 },
      });
      if (!syncState) {
        // Use SYNC_START_DATE as the initial offset (Prozorro accepts ISO date strings)
        const startOffset = process.env.SYNC_START_DATE || null;
        this.logger.log(
          `No sync state found. Starting from: ${startOffset || 'the very beginning'}`,
        );
        syncState = await this.prisma.syncState.create({
          data: { id: 1, lastOffset: startOffset },
        });
      }

      let currentOffset = syncState.lastOffset;
      let pagesProcessed = 0;
      const MAX_PAGES_PER_RUN = 1; // Fetch 1 page per run (100 tenders)

      while (pagesProcessed < MAX_PAGES_PER_RUN) {
        // 2. Fetch page from Prozorro
        const { data, nextPageOffset } = await this.prozorroApi.getTendersPage(
          currentOffset || undefined,
        );

        if (!data || data.length === 0) {
          break;
        }

        // 3. Add valid tenders to queue with retries
        for (const tender of data) {
          await this.tenderQueue.add(
            'process-tender',
            { tenderId: tender.id, dateModified: tender.dateModified },
            {
              // Deduplicate only the same tender version; newer dateModified values must enqueue.
              jobId: this.buildMainJobId(tender),
              attempts: 5, // Retry up to 5 times if fails
              backoff: {
                type: 'exponential',
                delay: 5000, // Delay increases: 5s, 10s, 20s...
              },
              removeOnComplete: true, // Keep Redis clean
              removeOnFail: {
                count: this.mainQueueFailedJobsToKeep,
              }, // Keep a bounded failed-job history for inspection
            },
          );
        }

        this.addedCount += data.length;

        // 4. Update local tracker and Database offset (optimistic locking via updatedAt)
        currentOffset = nextPageOffset;
        if (currentOffset) {
          const updated = await this.prisma.syncState.updateMany({
            where: { id: 1, updatedAt: syncState!.updatedAt },
            data: { lastOffset: currentOffset },
          });
          if (updated.count === 0) {
            this.logger.warn('Sync state was modified by another instance, skipping this run');
            break;
          }
          syncState = await this.prisma.syncState.findUnique({ where: { id: 1 } });
        }

        pagesProcessed++;

        // If the page was not full, we've likely caught up to real-time
        if (data.length < 100) break;
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error during synchronization loop', err.stack);
    } finally {
      this.isSyncing = false;
    }
  }

  // Run every 10 minutes to retry tenders that were not fully synced
  @Cron('*/10 * * * *')
  async retryPartialTenders() {
    if (process.env.APP_ROLE === 'WORKER') return;

    this.logger.log('Checking for incomplete tenders to retry...');
    try {
      const incompleteTenders = await this.prisma.tender.findMany({
        where: { syncStatus: { in: [...this.incompleteSyncStatuses] } },
        take: 100, // Process in batches
        orderBy: { dateModified: 'asc' }, // Oldest first
      });

      if (incompleteTenders.length === 0) {
        this.logger.log('No incomplete tenders found.');
        return;
      }

      this.logger.log(
        `Found ${incompleteTenders.length} incomplete tenders. Queuing for retry.`,
      );

      for (const tender of incompleteTenders) {
        // Reuse or recreate the retry job safely to avoid duplicate-job stalls.
        await this.queueRetryForTender(tender);

        // Mark as RETRYING so it's not picked up again by this cron,
        // but won't be confused with successfully synced (FULL) tenders.
        // Processor will set FULL on success or PARTIAL/FAILED on error.
        await this.prisma.tender.update({
          where: { id: tender.id },
          data: { syncStatus: 'RETRYING' }
        });
      }
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error('Error in retryPartialTenders cron', err.stack);
    }
  }
}
