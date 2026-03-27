import { Logger } from '@nestjs/common';
import { SyncService } from './sync.service';

describe('SyncService', () => {
  let service: SyncService;
  let prisma: {
    syncState: {
      findUnique: jest.Mock;
      create: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
    };
    tender: {
      count: jest.Mock;
      findMany: jest.Mock;
      update: jest.Mock;
    };
  };
  let prozorroApi: {
    getTendersPage: jest.Mock;
  };
  let tenderQueue: {
    add: jest.Mock;
    getJobCounts: jest.Mock;
    getJob: jest.Mock;
  };
  let statsIntervalHandler: (() => Promise<void> | void) | undefined;

  beforeEach(() => {
    statsIntervalHandler = undefined;
    jest.spyOn(global, 'setInterval').mockImplementation((handler: TimerHandler) => {
      statsIntervalHandler = handler as () => Promise<void> | void;
      return 0 as any;
    });
    jest.spyOn(Logger.prototype, 'log').mockImplementation();
    jest.spyOn(Logger.prototype, 'error').mockImplementation();
    delete process.env.APP_ROLE;

    prisma = {
      syncState: {
        findUnique: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      tender: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn(),
        update: jest.fn().mockResolvedValue(undefined),
      },
    };

    prozorroApi = {
      getTendersPage: jest.fn(),
    };

    tenderQueue = {
      add: jest.fn().mockResolvedValue(undefined),
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        failed: 0,
      }),
      getJob: jest.fn().mockResolvedValue(null),
    };

    service = new SyncService(
      prisma as any,
      prozorroApi as any,
      tenderQueue as any,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
    delete process.env.APP_ROLE;
  });

  it('ставить versioned main jobs, щоб нові апдейти тендера не блокувались старим failed jobId', async () => {
    prisma.syncState.findUnique
      .mockResolvedValueOnce({ id: 1, lastOffset: 'offset-1' })
      .mockResolvedValueOnce({ id: 1, lastOffset: 'offset-2' })
      .mockResolvedValueOnce({ id: 1, lastOffset: 'offset-2' })
      .mockResolvedValueOnce({ id: 1, lastOffset: 'offset-3' });
    prozorroApi.getTendersPage
      .mockResolvedValueOnce({
        data: [
          {
            id: 'tender-1',
            dateModified: '2026-01-01T00:00:00.000Z',
          },
        ],
        nextPageOffset: 'offset-2',
      })
      .mockResolvedValueOnce({
        data: [
          {
            id: 'tender-1',
            dateModified: '2026-01-02T00:00:00.000Z',
          },
        ],
        nextPageOffset: 'offset-3',
      });

    await service.handleSync();
    await service.handleSync();

    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      1,
      'process-tender',
      {
        tenderId: 'tender-1',
        dateModified: '2026-01-01T00:00:00.000Z',
      },
      {
        jobId: `main-tender-1-${Date.parse('2026-01-01T00:00:00.000Z')}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          count: 1000,
        },
      },
    );
    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      2,
      'process-tender',
      {
        tenderId: 'tender-1',
        dateModified: '2026-01-02T00:00:00.000Z',
      },
      {
        jobId: `main-tender-1-${Date.parse('2026-01-02T00:00:00.000Z')}`,
        attempts: 5,
        backoff: {
          type: 'exponential',
          delay: 5000,
        },
        removeOnComplete: true,
        removeOnFail: {
          count: 1000,
        },
      },
    );
  });

  it('не логує лише історичні failed jobs як активні помилки, якщо живої роботи вже немає', async () => {
    tenderQueue.getJobCounts.mockResolvedValue({
      waiting: 0,
      active: 0,
      failed: 287,
    });
    prisma.tender.count.mockResolvedValue(0);

    await statsIntervalHandler?.();

    expect(Logger.prototype.log).not.toHaveBeenCalled();
  });

  it('у статистиці явно позначає failed jobs як історію та показує незавершені тендери в БД', async () => {
    tenderQueue.getJobCounts.mockResolvedValue({
      waiting: 83307,
      active: 150,
      failed: 287,
    });
    prisma.tender.count.mockResolvedValue(12);
    (service as any).addedCount = 8;

    await statsIntervalHandler?.();

    expect(Logger.prototype.log).toHaveBeenCalledWith(
      '📥 За 30с: додано 8 тендерів у чергу | Черга: 83307 очікують, 150 активних, 287 історичних failed jobs | БД: 12 незавершених тендерів',
    );
  });

  it('ставить нові retry jobs для PARTIAL і FAILED тендерів та очищає їх статус', async () => {
    prisma.tender.findMany.mockResolvedValue([
      {
        id: 'tender-partial',
        dateModified: new Date('2026-01-01T00:00:00.000Z'),
        syncStatus: 'PARTIAL',
      },
      {
        id: 'tender-failed',
        dateModified: new Date('2026-01-02T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
    ]);

    await service.retryPartialTenders();

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: { syncStatus: { in: ['PARTIAL', 'FAILED'] } },
      take: 100,
      orderBy: { dateModified: 'asc' },
    });
    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      1,
      'process-tender',
      {
        tenderId: 'tender-partial',
        dateModified: new Date('2026-01-01T00:00:00.000Z'),
      },
      {
        jobId: 'retry-tender-partial',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(tenderQueue.add).toHaveBeenNthCalledWith(
      2,
      'process-tender',
      {
        tenderId: 'tender-failed',
        dateModified: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        jobId: 'retry-tender-failed',
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
        removeOnComplete: true,
        removeOnFail: true,
      },
    );
    expect(prisma.tender.update).toHaveBeenNthCalledWith(1, {
      where: { id: 'tender-partial' },
      data: { syncStatus: 'RETRYING' },
    });
    expect(prisma.tender.update).toHaveBeenNthCalledWith(2, {
      where: { id: 'tender-failed' },
      data: { syncStatus: 'RETRYING' },
    });
  });

  it('реанімує існуючий failed retry job замість створення дубля з тим самим jobId', async () => {
    const failedRetryJob = {
      getState: jest.fn().mockResolvedValue('failed'),
      retry: jest.fn().mockResolvedValue(undefined),
      remove: jest.fn(),
    };
    prisma.tender.findMany.mockResolvedValue([
      {
        id: 'tender-failed',
        dateModified: new Date('2026-01-02T00:00:00.000Z'),
        syncStatus: 'FAILED',
      },
    ]);
    tenderQueue.getJob.mockResolvedValue(failedRetryJob);

    await service.retryPartialTenders();

    expect(tenderQueue.getJob).toHaveBeenCalledWith('retry-tender-failed');
    expect(failedRetryJob.getState).toHaveBeenCalledTimes(1);
    expect(failedRetryJob.retry).toHaveBeenCalledWith('failed', {
      resetAttemptsMade: true,
      resetAttemptsStarted: true,
    });
    expect(tenderQueue.add).not.toHaveBeenCalled();
    expect(prisma.tender.update).toHaveBeenCalledWith({
      where: { id: 'tender-failed' },
      data: { syncStatus: 'RETRYING' },
    });
  });
});
