import { Injectable } from '@nestjs/common';
import { InjectQueue } from '@nestjs/bullmq';
import { Queue } from 'bullmq';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import { TENDER_QUEUE_NAME } from '../constants';

export type EdrpouRole = 'customer' | 'supplier';
type TenderRoleFilter = EdrpouRole | EdrpouRole[];
type ContractRoleFilter = EdrpouRole | EdrpouRole[];

const DATE_ONLY_QUERY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function parseDateQueryBoundary(
    value: string,
    boundary: 'start' | 'end',
): Date {
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
    if (!dateFrom && !dateTo) {
        return undefined;
    }

    const filter: Prisma.DateTimeFilter = {};

    if (dateFrom) {
        filter.gte = parseDateQueryBoundary(dateFrom, 'start');
    }

    if (dateTo) {
        filter.lte = parseDateQueryBoundary(dateTo, 'end');
    }

    return filter;
}

type ContractSortOption =
    | 'default'
    | 'amountAsc'
    | 'amountDesc'
    | 'dateSignedDesc'
    | 'dateSignedAsc';

type TenderSortOption =
    | 'default'
    | 'dateCreatedDesc'
    | 'dateCreatedAsc'
    | 'amountAsc'
    | 'amountDesc';

function buildTenderOrderBy(
    sort: TenderSortOption | undefined,
    dateField: keyof Pick<
        Prisma.TenderOrderByWithRelationInput,
        | 'dateModified'
        | 'dateCreated'
        | 'tenderPeriodStart'
        | 'tenderPeriodEnd'
        | 'enquiryPeriodStart'
        | 'enquiryPeriodEnd'
        | 'auctionPeriodStart'
        | 'awardPeriodStart'
    >,
): Prisma.TenderOrderByWithRelationInput[] {
    const defaultOrder = { [dateField]: 'desc' } as Prisma.TenderOrderByWithRelationInput;

    switch (sort) {
        case 'dateCreatedAsc':
            return [
                { dateCreated: 'asc' },
                { dateModified: 'desc' },
            ];
        case 'dateCreatedDesc':
            return [
                { dateCreated: 'desc' },
                { dateModified: 'desc' },
            ];
        case 'amountAsc':
            return [
                { amount: 'asc' },
                { dateCreated: 'desc' },
            ];
        case 'amountDesc':
            return [
                { amount: 'desc' },
                { dateCreated: 'desc' },
            ];
        case 'default':
        default:
            return [defaultOrder];
    }
}

function buildContractOrderBy(
    sort: ContractSortOption | undefined,
    dateField: 'dateModified' | 'dateSigned',
): Prisma.ContractOrderByWithRelationInput[] {
    const defaultOrder = { [dateField]: 'desc' } as Prisma.ContractOrderByWithRelationInput;

    switch (sort) {
        case 'amountAsc':
            return [
                { amount: 'asc' },
                { dateSigned: 'desc' },
            ];
        case 'amountDesc':
            return [
                { amount: 'desc' },
                { dateSigned: 'desc' },
            ];
        case 'dateSignedAsc':
            return [
                { dateSigned: 'asc' },
                { dateModified: 'desc' },
            ];
        case 'dateSignedDesc':
            return [
                { dateSigned: 'desc' },
                { dateModified: 'desc' },
            ];
        case 'default':
        default:
            return [defaultOrder];
    }
}

@Injectable()
export class SearchService {
    constructor(
        private readonly prisma: PrismaService,
        @InjectQueue(TENDER_QUEUE_NAME) private readonly tenderQueue: Queue,
    ) { }

    /**
     * Universal tender search with filters:
     * - edrpou + role: search by customer or supplier EDRPOU
     * - status: tender status (e.g. 'complete', 'active')
     * - dateFrom / dateTo: filter by dateModified range
     * - priceFrom / priceTo: filter by amount range
     * - skip / take: pagination
     */
    async searchTenders(params: {
        edrpou?: string;
        role?: TenderRoleFilter;
        status?: string | string[];
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
        const safeTake = Math.min(params.take || 20, 100);
        const skip = params.skip || 0;

        const where: Prisma.TenderWhereInput = {};
        const roles = Array.isArray(params.role)
            ? params.role
            : params.role
                ? [params.role]
                : ['customer'];
        const statuses = Array.isArray(params.status)
            ? params.status
            : params.status
                ? [params.status]
                : [];

        // EDRPOU filter based on role
        if (params.edrpou) {
            if (roles.length === 1 && roles[0] === 'customer') {
                where.customerEdrpou = params.edrpou;
            } else if (roles.length === 1 && roles[0] === 'supplier') {
                where.contracts = {
                    some: { supplierEdrpou: params.edrpou },
                };
            } else {
                where.OR = [
                    { customerEdrpou: params.edrpou },
                    {
                        contracts: {
                            some: { supplierEdrpou: params.edrpou },
                        },
                    },
                ];
            }
        }

        // Status filter
        if (statuses.length > 0) {
            where.status = {
                in: statuses,
            };
        }

        // Year filter
        if (params.year !== undefined) {
            where.year = params.year;
        }

        // Date range filter
        const tenderDateFieldMap: Record<string, keyof Pick<Prisma.TenderOrderByWithRelationInput, 'dateModified' | 'dateCreated' | 'tenderPeriodStart' | 'tenderPeriodEnd' | 'enquiryPeriodStart' | 'enquiryPeriodEnd' | 'auctionPeriodStart' | 'awardPeriodStart'>> = {
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

        const tenderDateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
        if (tenderDateFilter) {
            Object.assign(where, { [dateField]: tenderDateFilter });
        }

        // Price range filter
        if (params.priceFrom !== undefined || params.priceTo !== undefined) {
            where.amount = {
                ...(params.priceFrom !== undefined && { gte: params.priceFrom }),
                ...(params.priceTo !== undefined && { lte: params.priceTo }),
            };
        }

        const [data, total, relatedContractTotal] = await Promise.all([
            this.prisma.tender.findMany({
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
            this.prisma.tender.count({ where }),
            this.prisma.contract.count({
                where: {
                    tender: where,
                },
            }),
        ]);

        return {
            data,
            total,
            relatedContractTotal,
            skip,
            take: safeTake,
        };
    }

    /**
     * Universal contract search with filters:
     * - edrpou + role: search by supplier EDRPOU or customer EDRPOU (via tender)
     * - status: contract status (e.g. 'active', 'terminated')
     * - dateFrom / dateTo: filter by dateSigned range
     * - priceFrom / priceTo: filter by amount range
     * - skip / take: pagination
     */
    async searchContracts(params: {
        edrpou?: string;
        role?: ContractRoleFilter;
        status?: string | string[];
        dateFrom?: string;
        dateTo?: string;
        priceFrom?: number;
        priceTo?: number;
        dateType?: string;
        sort?: ContractSortOption;
        skip?: number;
        take?: number;
    }) {
        const safeTake = Math.min(params.take || 20, 100);
        const skip = params.skip || 0;

        const where: Prisma.ContractWhereInput = {};
        const roles = Array.isArray(params.role)
            ? params.role
            : params.role
                ? [params.role]
                : ['supplier'];
        const statuses = Array.isArray(params.status)
            ? params.status
            : params.status
                ? [params.status]
                : [];

        // EDRPOU filter based on role
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

        // Status filter
        if (statuses.length > 0) {
            where.status = {
                in: statuses,
            };
        }

        // Date range filter
        const dateField: 'dateModified' | 'dateSigned' =
            params.dateType === 'dateModified' ? 'dateModified' : 'dateSigned';
        const orderBy = buildContractOrderBy(params.sort, dateField);

        const contractDateFilter = buildDateTimeFilter(params.dateFrom, params.dateTo);
        if (contractDateFilter) {
            where[dateField] = contractDateFilter;
        }

        // Price range filter
        if (params.priceFrom !== undefined || params.priceTo !== undefined) {
            where.amount = {
                ...(params.priceFrom !== undefined && { gte: params.priceFrom }),
                ...(params.priceTo !== undefined && { lte: params.priceTo }),
            };
        }

        const [data, total, relatedTenderTotal] = await Promise.all([
            this.prisma.contract.findMany({
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
            this.prisma.contract.count({ where }),
            this.countDistinctTenders(where),
        ]);

        return {
            data,
            total,
            relatedTenderTotal,
            skip,
            take: safeTake,
        };
    }

    private async countDistinctTenders(where: Prisma.ContractWhereInput): Promise<number> {
        // Use Prisma findMany + distinct as baseline; for very large result sets
        // consider replacing with raw SQL: SELECT COUNT(DISTINCT "tenderId") ...
        const rows = await this.prisma.contract.findMany({
            where,
            distinct: ['tenderId'],
            select: { tenderId: true },
        });
        return rows.length;
    }

    async getStats() {
        const results = await Promise.allSettled([
            this.prisma.tender.count(),
            this.prisma.contract.count(),
            this.prisma.syncState.findUnique({ where: { id: 1 } }),
            this.prisma.tender.count({
                where: { syncStatus: { in: ['PARTIAL', 'FAILED', 'RETRYING'] } },
            }),
            this.tenderQueue.getJobCounts(
                'waiting',
                'active',
                'delayed',
                'prioritized',
                'waiting-children',
            ),
        ]);

        const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
            r.status === 'fulfilled' ? r.value : fallback;

        const tenderCount = val(results[0], 0);
        const contractCount = val(results[1], 0);
        const syncState = val(results[2], null);
        const incompleteTenderCount = val(results[3], 0);
        const queueCounts = val(results[4], {} as Record<string, number>);

        const pendingJobs =
            (queueCounts.waiting || 0) +
            (queueCounts.active || 0) +
            (queueCounts.delayed || 0) +
            (queueCounts.prioritized || 0) +
            (queueCounts['waiting-children'] || 0);
        const isFullySynced = pendingJobs === 0 && incompleteTenderCount === 0;

        return {
            tenders: tenderCount,
            contracts: contractCount,
            lastSync: isFullySynced ? syncState?.updatedAt || null : null
        };
    }
}
