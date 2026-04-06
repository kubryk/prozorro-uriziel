import { PrismaClient, Prisma } from '@prisma/client';

type EdrpouRole = 'customer' | 'supplier';

const DATE_ONLY_QUERY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateQueryBoundary(value: string, boundary: 'start' | 'end'): Date {
  if (DATE_ONLY_QUERY_PATTERN.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    if (boundary === 'end') {
      return new Date(Date.UTC(year, month - 1, day, 23, 59, 59, 999));
    }
    return new Date(Date.UTC(year, month - 1, day, 0, 0, 0, 0));
  }
  return new Date(value);
}

function buildDateTimeFilter(
  dateFrom?: string,
  dateTo?: string,
): Prisma.DateTimeFilter | undefined {
  if (!dateFrom && !dateTo) return undefined;
  const filter: Prisma.DateTimeFilter = {};
  if (dateFrom) filter.gte = parseDateQueryBoundary(dateFrom, 'start');
  if (dateTo) filter.lte = parseDateQueryBoundary(dateTo, 'end');
  return filter;
}

type TenderSortOption = 'default' | 'dateCreatedDesc' | 'dateCreatedAsc' | 'amountAsc' | 'amountDesc';
type ContractSortOption = 'default' | 'amountAsc' | 'amountDesc' | 'dateSignedDesc' | 'dateSignedAsc';

function buildTenderOrderBy(
  sort: TenderSortOption | undefined,
  dateField: keyof Pick<
    Prisma.TenderOrderByWithRelationInput,
    'dateModified' | 'dateCreated' | 'tenderPeriodStart' | 'tenderPeriodEnd' |
    'enquiryPeriodStart' | 'enquiryPeriodEnd' | 'auctionPeriodStart' | 'awardPeriodStart'
  >,
): Prisma.TenderOrderByWithRelationInput[] {
  const defaultOrder = { [dateField]: 'desc' } as Prisma.TenderOrderByWithRelationInput;
  switch (sort) {
    case 'dateCreatedAsc': return [{ dateCreated: 'asc' }, { dateModified: 'desc' }];
    case 'dateCreatedDesc': return [{ dateCreated: 'desc' }, { dateModified: 'desc' }];
    case 'amountAsc': return [{ amount: 'asc' }, { dateCreated: 'desc' }];
    case 'amountDesc': return [{ amount: 'desc' }, { dateCreated: 'desc' }];
    default: return [defaultOrder];
  }
}

function buildContractOrderBy(
  sort: ContractSortOption | undefined,
  dateField: 'dateModified' | 'dateSigned',
): Prisma.ContractOrderByWithRelationInput[] {
  const defaultOrder = { [dateField]: 'desc' } as Prisma.ContractOrderByWithRelationInput;
  switch (sort) {
    case 'amountAsc': return [{ amount: 'asc' }, { dateSigned: 'desc' }];
    case 'amountDesc': return [{ amount: 'desc' }, { dateSigned: 'desc' }];
    case 'dateSignedAsc': return [{ dateSigned: 'asc' }, { dateModified: 'desc' }];
    case 'dateSignedDesc': return [{ dateSigned: 'desc' }, { dateModified: 'desc' }];
    default: return [defaultOrder];
  }
}

export async function searchTenders(prisma: PrismaClient, params: {
  edrpou?: string;
  role?: EdrpouRole[];
  status?: string[];
  year?: number;
  dateFrom?: string;
  dateTo?: string;
  dateType?: string;
  sort?: TenderSortOption;
  priceFrom?: number;
  priceTo?: number;
  skip?: number;
  take?: number;
}) {
  const safeTake = Math.min(params.take ?? 20, 100);
  const skip = params.skip ?? 0;
  const roles = params.role?.length ? params.role : ['customer' as EdrpouRole];
  const statuses = params.status ?? [];

  const where: Prisma.TenderWhereInput = {};

  if (params.edrpou) {
    if (roles.length === 1 && roles[0] === 'customer') {
      where.customerEdrpou = params.edrpou;
    } else if (roles.length === 1 && roles[0] === 'supplier') {
      where.contracts = { some: { supplierEdrpou: params.edrpou } };
    } else {
      where.OR = [
        { customerEdrpou: params.edrpou },
        { contracts: { some: { supplierEdrpou: params.edrpou } } },
      ];
    }
  }

  if (statuses.length > 0) where.status = { in: statuses };
  if (params.year !== undefined) where.year = params.year;

  const tenderDateFieldMap: Record<string, keyof Pick<
    Prisma.TenderOrderByWithRelationInput,
    'dateModified' | 'dateCreated' | 'tenderPeriodStart' | 'tenderPeriodEnd' |
    'enquiryPeriodStart' | 'enquiryPeriodEnd' | 'auctionPeriodStart' | 'awardPeriodStart'
  >> = {
    dateCreated: 'dateCreated',
    tenderPeriodStart: 'tenderPeriodStart',
    tenderPeriodEnd: 'tenderPeriodEnd',
    enquiryPeriodStart: 'enquiryPeriodStart',
    enquiryPeriodEnd: 'enquiryPeriodEnd',
    auctionPeriodStart: 'auctionPeriodStart',
    awardPeriodStart: 'awardPeriodStart',
  };
  const dateField = tenderDateFieldMap[params.dateType ?? ''] ?? 'dateModified';
  const orderBy = buildTenderOrderBy(params.sort, dateField);

  const dateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
  if (dateFilter) Object.assign(where, { [dateField]: dateFilter });

  if (params.priceFrom !== undefined || params.priceTo !== undefined) {
    where.amount = {
      ...(params.priceFrom !== undefined && { gte: params.priceFrom }),
      ...(params.priceTo !== undefined && { lte: params.priceTo }),
    };
  }

  const [data, total, relatedContractTotal] = await Promise.all([
    prisma.tender.findMany({
      where,
      skip,
      take: safeTake,
      orderBy,
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
    }),
    prisma.tender.count({ where }),
    prisma.contract.count({ where: { tender: where } }),
  ]);

  return { data, total, relatedContractTotal, skip, take: safeTake };
}

export async function searchContracts(prisma: PrismaClient, params: {
  edrpou?: string;
  role?: EdrpouRole[];
  status?: string[];
  dateFrom?: string;
  dateTo?: string;
  dateType?: string;
  sort?: ContractSortOption;
  priceFrom?: number;
  priceTo?: number;
  skip?: number;
  take?: number;
}) {
  const safeTake = Math.min(params.take ?? 20, 100);
  const skip = params.skip ?? 0;
  const roles = params.role?.length ? params.role : ['supplier' as EdrpouRole];
  const statuses = params.status ?? [];

  const where: Prisma.ContractWhereInput = {};

  if (params.edrpou) {
    if (roles.length === 1 && roles[0] === 'supplier') {
      where.supplierEdrpou = params.edrpou;
    } else if (roles.length === 1 && roles[0] === 'customer') {
      where.tender = { customerEdrpou: params.edrpou };
    } else {
      where.OR = [
        { supplierEdrpou: params.edrpou },
        { tender: { customerEdrpou: params.edrpou } },
      ];
    }
  }

  if (statuses.length > 0) where.status = { in: statuses };

  const dateField: 'dateModified' | 'dateSigned' =
    params.dateType === 'dateModified' ? 'dateModified' : 'dateSigned';
  const orderBy = buildContractOrderBy(params.sort, dateField);

  const dateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
  if (dateFilter) where[dateField] = dateFilter;

  if (params.priceFrom !== undefined || params.priceTo !== undefined) {
    where.amount = {
      ...(params.priceFrom !== undefined && { gte: params.priceFrom }),
      ...(params.priceTo !== undefined && { lte: params.priceTo }),
    };
  }

  const [data, total, relatedTenderTotal] = await Promise.all([
    prisma.contract.findMany({
      where,
      skip,
      take: safeTake,
      orderBy,
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
    }),
    prisma.contract.count({ where }),
    countDistinctTenders(prisma, where),
  ]);

  return { data, total, relatedTenderTotal, skip, take: safeTake };
}

async function countDistinctTenders(
  prisma: PrismaClient,
  where: Prisma.ContractWhereInput,
): Promise<number> {
  const groups = await prisma.contract.groupBy({
    by: ['tenderId'],
    where,
    _count: true,
    orderBy: { tenderId: 'asc' },
    take: 10_000,
  });
  return groups.length;
}

export async function getCompanyProfile(prisma: PrismaClient, edrpou: string) {
  const company = await prisma.company.findUnique({ where: { edrpou } });
  if (!company) return null;

  const results = await Promise.allSettled([
    prisma.tender.count({ where: { customerEdrpou: edrpou } }),
    prisma.tender.aggregate({ where: { customerEdrpou: edrpou }, _sum: { amount: true } }),
    prisma.contract.count({ where: { supplierEdrpou: edrpou } }),
    prisma.contract.aggregate({ where: { supplierEdrpou: edrpou }, _sum: { amount: true } }),
    prisma.bid.count({ where: { bidderEdrpou: edrpou } }),
    prisma.complaint.count({ where: { tender: { customerEdrpou: edrpou } } }),
    prisma.complaint.count({ where: { complainantEdrpou: edrpou } }),
    prisma.tender.findMany({
      where: { customerEdrpou: edrpou },
      orderBy: { dateModified: 'desc' },
      take: 5,
      select: { id: true, tenderID: true, title: true, status: true, amount: true, currency: true, dateModified: true },
    }),
    prisma.contract.findMany({
      where: { supplierEdrpou: edrpou },
      orderBy: { dateSigned: 'desc' },
      take: 5,
      select: {
        id: true, contractID: true, description: true, status: true, amount: true, currency: true, dateSigned: true,
        tender: { select: { tenderID: true, title: true, customerEdrpou: true, customerName: true } },
      },
    }),
  ]);

  const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
    r.status === 'fulfilled' ? r.value : fallback;

  const tenderCount = val(results[0], 0);
  const tenderSum = val(results[1], { _sum: { amount: null } });
  const contractCount = val(results[2], 0);
  const contractSum = val(results[3], { _sum: { amount: null } });
  const bidCount = val(results[4], 0);
  const complaintsAgainst = val(results[5], 0);
  const complaintsBy = val(results[6], 0);
  const recentTenders = val(results[7], [] as object[]);
  const recentContracts = val(results[8], [] as object[]);
  const winRate = bidCount > 0 ? contractCount / bidCount : null;

  return {
    edrpou: company.edrpou,
    name: company.name,
    region: company.region,
    locality: company.locality,
    asCustomer: { tenderCount, totalAmount: tenderSum._sum.amount },
    asSupplier: { contractCount, totalAmount: contractSum._sum.amount, bidCount, winRate },
    complaints: { against: complaintsAgainst, by: complaintsBy },
    recentTenders,
    recentContracts,
  };
}

export async function getTenderById(prisma: PrismaClient, tenderID: string) {
  return prisma.tender.findFirst({
    where: { tenderID },
    include: {
      contracts: {
        select: {
          id: true,
          contractID: true,
          status: true,
          amount: true,
          currency: true,
          supplierEdrpou: true,
          supplierName: true,
          dateSigned: true,
        },
      },
    },
  });
}

export async function getStats(prisma: PrismaClient) {
  const [tenderCount, contractCount, syncState] = await Promise.all([
    prisma.tender.count(),
    prisma.contract.count(),
    prisma.syncState.findUnique({ where: { id: 1 } }),
  ]);
  return {
    tenders: tenderCount,
    contracts: contractCount,
    lastSync: syncState?.updatedAt ?? null,
  };
}
