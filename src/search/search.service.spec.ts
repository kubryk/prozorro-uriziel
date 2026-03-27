import { SearchService } from './search.service';

describe('SearchService', () => {
  let service: SearchService;
  let prisma: {
    tender: {
      findMany: jest.Mock;
      count: jest.Mock;
    };
    contract: {
      findMany: jest.Mock;
      count: jest.Mock;
      groupBy: jest.Mock;
    };
    syncState: {
      findUnique: jest.Mock;
    };
  };
  let tenderQueue: {
    getJobCounts: jest.Mock;
  };

  beforeEach(() => {
    prisma = {
      tender: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      contract: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        groupBy: jest.fn().mockResolvedValue([]),
      },
      syncState: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };
    tenderQueue = {
      getJobCounts: jest.fn().mockResolvedValue({
        waiting: 0,
        active: 0,
        delayed: 0,
        prioritized: 0,
        'waiting-children': 0,
      }),
    };

    service = new SearchService(prisma as any, tenderQueue as any);
  });

  it('будує supplier-фільтр для тендерів і обмежує take до 100', async () => {
    await service.searchTenders({
      edrpou: '12345678',
      role: 'supplier',
      priceFrom: 1000,
      priceTo: 5000,
      take: 500,
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {
        contracts: {
          some: { supplierEdrpou: '12345678' },
        },
        amount: {
          gte: 1000,
          lte: 5000,
        },
      },
      skip: 0,
      take: 100,
      orderBy: [{ dateModified: 'desc' }],
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
    expect(prisma.tender.count).toHaveBeenCalledWith({
      where: {
        contracts: {
          some: { supplierEdrpou: '12345678' },
        },
        amount: {
          gte: 1000,
          lte: 5000,
        },
      },
    });
  });

  it('підтримує обидві ролі та кілька статусів у пошуку тендерів', async () => {
    await service.searchTenders({
      edrpou: '12345678',
      role: ['customer', 'supplier'],
      status: ['active', 'complete'],
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { customerEdrpou: '12345678' },
          {
            contracts: {
              some: { supplierEdrpou: '12345678' },
            },
          },
        ],
        status: {
          in: ['active', 'complete'],
        },
      },
      skip: 0,
      take: 20,
      orderBy: [{ dateModified: 'desc' }],
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
  });

  it('робить dateTo inclusive до кінця доби для тендерів і підтримує dateCreated як поле фільтрації', async () => {
    await service.searchTenders({
      dateType: 'dateCreated',
      dateFrom: '2026-03-08',
      dateTo: '2026-03-08',
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {
        dateCreated: {
          gte: new Date('2026-03-08T00:00:00.000Z'),
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
      skip: 0,
      take: 20,
      orderBy: [{ dateCreated: 'desc' }],
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
    expect(prisma.tender.count).toHaveBeenCalledWith({
      where: {
        dateCreated: {
          gte: new Date('2026-03-08T00:00:00.000Z'),
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
    });
  });

  it('сортує тендери за датою публікації від новіших до старіших', async () => {
    await service.searchTenders({
      sort: 'dateCreatedDesc',
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 20,
      orderBy: [
        { dateCreated: 'desc' },
        { dateModified: 'desc' },
      ],
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
  });

  it('сортує тендери за сумою від менших до більших', async () => {
    await service.searchTenders({
      sort: 'amountAsc',
    });

    expect(prisma.tender.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 20,
      orderBy: [
        { amount: 'asc' },
        { dateCreated: 'desc' },
      ],
      include: {
        contracts: {
          select: {
            id: true,
            contractID: true,
            status: true,
            amount: true,
            supplierEdrpou: true,
            supplierName: true,
          },
        },
      },
    });
  });

  it('повертає реальну кількість контрактів для знайдених тендерів', async () => {
    prisma.contract.count.mockResolvedValue(42);

    await expect(service.searchTenders({})).resolves.toMatchObject({
      total: 0,
      relatedContractTotal: 42,
      skip: 0,
      take: 20,
    });

    expect(prisma.contract.count).toHaveBeenCalledWith({
      where: {
        tender: {},
      },
    });
  });

  it('робить dateTo inclusive до кінця доби для контрактів', async () => {
    await service.searchContracts({
      dateType: 'dateSigned',
      dateTo: '2026-03-08',
    });

    expect(prisma.contract.findMany).toHaveBeenCalledWith({
      where: {
        dateSigned: {
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
      skip: 0,
      take: 20,
      orderBy: [{ dateSigned: 'desc' }],
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            customerEdrpou: true,
            customerName: true,
            status: true,
          },
        },
      },
    });
    expect(prisma.contract.count).toHaveBeenCalledWith({
      where: {
        dateSigned: {
          lte: new Date('2026-03-08T23:59:59.999Z'),
        },
      },
    });
  });

  it('підтримує обидві ролі та кілька статусів у пошуку контрактів', async () => {
    await service.searchContracts({
      edrpou: '12345678',
      role: ['supplier', 'customer'],
      status: ['active', 'terminated'],
    });

    expect(prisma.contract.findMany).toHaveBeenCalledWith({
      where: {
        OR: [
          { supplierEdrpou: '12345678' },
          { tender: { customerEdrpou: '12345678' } },
        ],
        status: {
          in: ['active', 'terminated'],
        },
      },
      skip: 0,
      take: 20,
      orderBy: [{ dateSigned: 'desc' }],
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            customerEdrpou: true,
            customerName: true,
            status: true,
          },
        },
      },
    });
  });

  it('сортує контракти за сумою у зростаючому порядку з fallback по новішій даті підписання', async () => {
    await service.searchContracts({
      sort: 'amountAsc',
    });

    expect(prisma.contract.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 20,
      orderBy: [
        { amount: 'asc' },
        { dateSigned: 'desc' },
      ],
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            customerEdrpou: true,
            customerName: true,
            status: true,
          },
        },
      },
    });
  });

  it('сортує контракти за датою підписання від старіших до новіших', async () => {
    await service.searchContracts({
      dateType: 'dateModified',
      sort: 'dateSignedAsc',
    });

    expect(prisma.contract.findMany).toHaveBeenCalledWith({
      where: {},
      skip: 0,
      take: 20,
      orderBy: [
        { dateSigned: 'asc' },
        { dateModified: 'desc' },
      ],
      include: {
        tender: {
          select: {
            id: true,
            tenderID: true,
            title: true,
            customerEdrpou: true,
            customerName: true,
            status: true,
          },
        },
      },
    });
  });

  it('повертає реальну кількість унікальних тендерів для знайдених контрактів', async () => {
    prisma.contract.groupBy.mockResolvedValue([
      { tenderId: 'tender-db-1', _count: 2 },
      { tenderId: 'tender-db-2', _count: 1 },
      { tenderId: 'tender-db-3', _count: 1 },
    ]);
    prisma.contract.count.mockResolvedValue(17);

    await expect(service.searchContracts({})).resolves.toMatchObject({
      total: 17,
      relatedTenderTotal: 3,
      skip: 0,
      take: 20,
    });

    expect(prisma.contract.groupBy).toHaveBeenCalledWith({
      by: ['tenderId'],
      where: {},
      _count: true,
      orderBy: { tenderId: 'asc' },
      take: 10_000,
    });
  });

  it('повертає агреговану статистику по тендерах, контрактах і синку', async () => {
    prisma.tender.count
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(0);
    prisma.contract.count.mockResolvedValue(7);
    prisma.syncState.findUnique.mockResolvedValue({
      updatedAt: new Date('2026-03-08T10:00:00.000Z'),
    });

    await expect(service.getStats()).resolves.toEqual({
      tenders: 11,
      contracts: 7,
      lastSync: new Date('2026-03-08T10:00:00.000Z'),
    });
  });

  it('повертає lastSync як null, якщо в черзі є backlog або лишилися incomplete тендери', async () => {
    prisma.tender.count
      .mockResolvedValueOnce(11)
      .mockResolvedValueOnce(2);
    prisma.contract.count.mockResolvedValue(7);
    prisma.syncState.findUnique.mockResolvedValue({
      updatedAt: new Date('2026-03-08T10:00:00.000Z'),
    });
    tenderQueue.getJobCounts.mockResolvedValue({
      waiting: 1,
      active: 0,
      delayed: 0,
      prioritized: 0,
      'waiting-children': 0,
    });

    await expect(service.getStats()).resolves.toEqual({
      tenders: 11,
      contracts: 7,
      lastSync: null,
    });
    expect(prisma.tender.count).toHaveBeenNthCalledWith(2, {
      where: { syncStatus: { in: ['PARTIAL', 'FAILED', 'RETRYING'] } },
    });
    expect(tenderQueue.getJobCounts).toHaveBeenCalledWith(
      'waiting',
      'active',
      'delayed',
      'prioritized',
      'waiting-children',
    );
  });
});
