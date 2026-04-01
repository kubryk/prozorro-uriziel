import { Processor, WorkerHost } from '@nestjs/bullmq';
import { Job } from 'bullmq';
import { Logger, OnModuleDestroy } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import '../../env';
import { PrismaService } from '../../prisma/prisma.service';
import { ProzorroService } from '../../prozorro/prozorro.service';
import {
  ProzorroTenderDetails,
  ProzorroContractDetails,
  ProzorroLot,
  ProzorroBid,
  ProzorroComplaint,
  ProzorroItem,
} from '../../prozorro/prozorro.types';
import { TENDER_QUEUE_NAME } from '../../constants';

const STATS_INTERVAL_MS = 30_000; // Print summary every 30 seconds
const DEFAULT_WORKER_CONCURRENCY = 50;
const DEFAULT_WORKER_DB_CONCURRENCY = 2;
const DEFAULT_WORKER_LOCK_DURATION_MS = 300_000;

function parsePositiveIntEnv(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value || '', 10);

  if (Number.isNaN(parsed) || parsed < 1) {
    return fallback;
  }

  return parsed;
}

/** Strip null bytes that PostgreSQL rejects */
function sanitize(val: string | number | null | undefined, maxLength?: number): string | null {
  if (val == null) return null;
  const str = String(val).replace(/\0/g, '');
  return maxLength ? str.slice(0, maxLength) : str;
}

/** Safely parse a value to Float — Prozorro API sometimes returns numbers as strings */
function toFloat(val: string | number | null | undefined): number | null {
  if (val == null) return null;
  const n = typeof val === 'string' ? parseFloat(val) : val;
  return isNaN(n) || !isFinite(n) ? null : n;
}

interface ParsedComplaint {
  id: string;
  title: string | null;
  description: string | null;
  status: string | null;
  type: string | null;
  dateSubmitted: Date | null;
  complaintID: string | null;
  complainantEdrpou: string | null;
  complainantName: string | null;
}

interface CompanyData {
  edrpou: string;
  name: string | null;
  region: string | null;
  locality: string | null;
}

@Processor(TENDER_QUEUE_NAME, {
  // concurrency — скільки задач BullMQ тримає одночасно в пам'яті.
  // Реальний ліміт запитів до API — в ProzorroService (WORKER_REQUESTS_PER_SECOND)
  concurrency: parsePositiveIntEnv(
    process.env.WORKER_CONCURRENCY,
    DEFAULT_WORKER_CONCURRENCY,
  ),
  // BullMQ lock must outlive slower tenders; otherwise a long-running job can
  // lose its lock and then fail on moveToFinished/moveToDelayed.
  lockDuration: parsePositiveIntEnv(
    process.env.WORKER_LOCK_DURATION_MS,
    DEFAULT_WORKER_LOCK_DURATION_MS,
  ),
})
export class TenderProcessor extends WorkerHost implements OnModuleDestroy {
  private readonly logger = new Logger(TenderProcessor.name);
  private statsInterval: ReturnType<typeof setInterval>;
  private readonly maxDbWriteConcurrency = parsePositiveIntEnv(
    process.env.WORKER_DB_CONCURRENCY,
    DEFAULT_WORKER_DB_CONCURRENCY,
  );
  private activeDbWriteSlots = 0;
  private readonly pendingDbWriteWaiters: Array<() => void> = [];

  // Aggregate counters for periodic summary
  private processedTenders = 0;
  private processedContracts = 0;
  private processedItems = 0;
  private errorCount = 0;
  private partialCount = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly prozorroApi: ProzorroService,
  ) {
    super();

    // Print stats summary every 30 seconds
    this.statsInterval = setInterval(() => {
      if (this.processedTenders === 0 && this.errorCount === 0) return; // nothing to report

      const speed = (this.processedTenders / (STATS_INTERVAL_MS / 1000)).toFixed(1);
      this.logger.log(
        `📊 За ${STATS_INTERVAL_MS / 1000}с: ${this.processedTenders} тендерів (${speed}/с), ${this.processedContracts} контрактів, ${this.processedItems} предметів | помилки: ${this.errorCount}, partial: ${this.partialCount}`,
      );

      // Reset counters
      this.processedTenders = 0;
      this.processedContracts = 0;
      this.processedItems = 0;
      this.errorCount = 0;
      this.partialCount = 0;
    }, STATS_INTERVAL_MS);
  }

  onModuleDestroy() {
    clearInterval(this.statsInterval);
  }

  private async acquireDbWriteSlot(): Promise<void> {
    if (this.activeDbWriteSlots < this.maxDbWriteConcurrency) {
      this.activeDbWriteSlots++;
      return;
    }

    await new Promise<void>((resolve) => {
      this.pendingDbWriteWaiters.push(resolve);
    });
    this.activeDbWriteSlots++;
  }

  private releaseDbWriteSlot(): void {
    this.activeDbWriteSlots--;
    const nextWaiter = this.pendingDbWriteWaiters.shift();
    if (nextWaiter) {
      nextWaiter();
    }
  }

  private async fetchContractWithRetry(
    tenderId: string,
    contractId: string,
  ): Promise<ProzorroContractDetails | null> {
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        return await this.prozorroApi.getContractDetails(contractId);
      } catch (contractError: any) {
        const status = contractError?.response?.status;
        if (status && status >= 400 && status < 500) {
          this.logger.warn(
            `Skipping contract ${contractId} for tender ${tenderId} (HTTP ${status}): ${contractError.message}`,
          );
          return null;
        }
        if (attempt === 3) {
          this.logger.warn(
            `Skipping contract ${contractId} for tender ${tenderId} after 3 attempts: ${contractError.message}`,
          );
          return null;
        }
        await new Promise((r) => setTimeout(r, 1000 * attempt));
      }
    }
    return null;
  }

  private async withDbWriteSlot<T>(work: () => Promise<T>): Promise<T> {
    await this.acquireDbWriteSlot();
    try {
      return await work();
    } finally {
      this.releaseDbWriteSlot();
    }
  }

  async process(
    job: Job<{ tenderId: string; dateModified?: string | Date }, any, string>,
  ): Promise<{ success: boolean; reason?: string; customers?: number; contracts?: number }> {
    const { tenderId } = job.data;

    try {
      const tenderDetails = await this.prozorroApi.getTenderDetails(tenderId);

      if (!tenderDetails || typeof tenderDetails.id !== 'string') {
        throw new Error(`Invalid or missing tender data for: ${tenderId}`);
      }

      if (!tenderDetails.status) {
        throw new Error(`Tender ${tenderId} has no status field`);
      }

      // Extract Customer (from procuringEntity)
      let customerEdrpou: string | null = null;
      let customerName: string | null = null;
      let customerRegion: string | null = null;
      let customerLocality: string | null = null;
      if (tenderDetails.procuringEntity) {
        const pe = tenderDetails.procuringEntity;
        if (pe.identifier?.id) {
          customerEdrpou = pe.identifier.id;
          customerName = pe.name || pe.identifier.legalName || null;
        }
        if (pe.address) {
          customerRegion = pe.address.region || null;
          customerLocality = pe.address.locality || null;
        }
      }

      // Helper to parse Prozorro dates
      const pDate = (d: string | null | undefined) => d ? new Date(d) : null;
      const fallbackDateModified = job.data.dateModified
        ? new Date(job.data.dateModified)
        : new Date();
      const safeFallbackDateModified = Number.isNaN(fallbackDateModified.getTime())
        ? new Date()
        : fallbackDateModified;
      const tenderDateModified = pDate(tenderDetails.dateModified) ?? safeFallbackDateModified;
      const tenderDateCreated = pDate(tenderDetails.dateCreated) ?? tenderDateModified;
      const tenderYear = tenderDateModified.getUTCFullYear();

      // Extract Lots
      const lots = Array.isArray(tenderDetails.lots)
        ? tenderDetails.lots.map((lot: ProzorroLot) => ({
            id: lot.id,
            title: sanitize(lot.title),
            description: sanitize(lot.description),
            status: lot.status || null,
            amount: toFloat(lot.value?.amount),
            currency: lot.value?.currency || null,
            valueAddedTaxIncluded: lot.value?.valueAddedTaxIncluded ?? null,
          }))
        : [];

      // Extract Bids
      const bids = Array.isArray(tenderDetails.bids)
        ? tenderDetails.bids.map((bid: ProzorroBid) => {
            const tenderer = bid.tenderers?.[0];
            return {
              id: bid.id,
              date: pDate(bid.date),
              status: bid.status || null,
              amount: toFloat(bid.value?.amount),
              currency: bid.value?.currency || null,
              valueAddedTaxIncluded: bid.value?.valueAddedTaxIncluded ?? null,
              bidderEdrpou: sanitize(tenderer?.identifier?.id),
              bidderName: sanitize(tenderer?.name || tenderer?.identifier?.legalName),
            };
          })
        : [];

      // Extract Complaints (from tender level and awards)
      const parseComplaint = (c: ProzorroComplaint): ParsedComplaint => ({
        id: c.id,
        title: sanitize(c.title),
        description: sanitize(c.description),
        status: c.status || null,
        type: c.type || null,
        dateSubmitted: pDate(c.dateSubmitted),
        complaintID: c.complaintID || null,
        complainantEdrpou: sanitize(c.author?.identifier?.id),
        complainantName: sanitize(c.author?.name),
      });

      const complaints: ParsedComplaint[] = [];
      if (Array.isArray(tenderDetails.complaints)) {
        for (const c of tenderDetails.complaints) {
          complaints.push(parseComplaint(c));
        }
      }
      if (Array.isArray(tenderDetails.awards)) {
        for (const award of tenderDetails.awards) {
          if (Array.isArray(award.complaints)) {
            for (const c of award.complaints) {
              complaints.push(parseComplaint(c));
            }
          }
        }
      }

      const contractRefs = Array.isArray(tenderDetails.contracts)
        ? tenderDetails.contracts
        : null;
      const expectedContractIds: string[] = [];
      if (contractRefs) {
        for (const contractRef of contractRefs) {
          if (
            typeof contractRef?.id === 'string' &&
            !expectedContractIds.includes(contractRef.id)
          ) {
            expectedContractIds.push(contractRef.id);
          }
        }
      }

      // Fetch contract details in parallel (rate limiting is handled by ProzorroService)
      let hasFailedContracts = false;
      const contractDetailsToPersist: ProzorroContractDetails[] = [];
      if (expectedContractIds.length > 0) {
        const results = await Promise.allSettled(
          expectedContractIds.map((contractId) => this.fetchContractWithRetry(tenderId, contractId)),
        );
        for (const result of results) {
          if (result.status === 'fulfilled' && result.value) {
            contractDetailsToPersist.push(result.value);
          } else {
            hasFailedContracts = true;
          }
        }
      }
      const contractsCount = contractDetailsToPersist.length;

      const tenderWriteData = {
        tenderID: tenderDetails.tenderID,
        title: sanitize(tenderDetails.title),
        description: sanitize(tenderDetails.description),
        status: tenderDetails.status,
        amount: toFloat(tenderDetails.value?.amount),
        currency: tenderDetails.value?.currency || null,
        valueAddedTaxIncluded: tenderDetails.value?.valueAddedTaxIncluded ?? null,
        year: tenderYear,
        dateModified: tenderDateModified,
        dateCreated: tenderDateCreated,
        tenderPeriodStart: pDate(tenderDetails.tenderPeriod?.startDate),
        tenderPeriodEnd: pDate(tenderDetails.tenderPeriod?.endDate),
        enquiryPeriodStart: pDate(tenderDetails.enquiryPeriod?.startDate),
        enquiryPeriodEnd: pDate(tenderDetails.enquiryPeriod?.endDate),
        auctionPeriodStart: pDate(tenderDetails.auctionPeriod?.startDate),
        awardPeriodStart: pDate(tenderDetails.awardPeriod?.startDate),
        mainProcurementCategory: tenderDetails.mainProcurementCategory || null,
        procurementMethod: tenderDetails.procurementMethod || null,
        procurementMethodType: tenderDetails.procurementMethodType || null,
        customerEdrpou: sanitize(customerEdrpou),
        customerName: sanitize(customerName),
        customerRegion: sanitize(customerRegion),
        customerLocality: sanitize(customerLocality),
        syncStatus: 'FULL' as const,
      };

      const contractWrites = contractDetailsToPersist.map((contract: ProzorroContractDetails) => {
        // Support both new format (contract.value.amount) and old format (contract.amount)
        const value = contract.value || {};
        const amount = toFloat(value.amount ?? contract.amount);
        const currency = value.currency || contract.currency || null;
        const vatIncluded =
          value.valueAddedTaxIncluded ??
          contract.valueAddedTaxIncluded ??
          null;
        const amountNet = toFloat(value.amountNet ?? contract.amountNet);

        // Extract Supplier for this contract
        let supplierEdrpou: string | null = null;
        let supplierName: string | null = null;

        if (
          contract.suppliers &&
          Array.isArray(contract.suppliers) &&
          contract.suppliers.length > 0
        ) {
          const supplier = contract.suppliers[0];
          supplierEdrpou = supplier.identifier?.id || null;
          supplierName = supplier.name || supplier.identifier?.legalName || null;
        }

        // Extract items for this contract
        const items = Array.isArray(contract.items)
          ? contract.items.map((item: ProzorroItem) => ({
              id: item.id,
              description: sanitize(item.description),
              quantity: toFloat(item.quantity),
              unitName: sanitize(item.unit?.name),
              unitCode: item.unit?.code || null,
              classificationId: item.classification?.id || null,
              classificationDescription: sanitize(item.classification?.description),
              deliveryRegion: sanitize(item.deliveryAddress?.region),
              deliveryLocality: sanitize(item.deliveryAddress?.locality),
            }))
          : [];

        return {
          id: contract.id,
          data: {
            contractID: contract.contractID || null,
            contractNumber: sanitize(contract.contractNumber, 500),
            description: sanitize(contract.description),
            status: contract.status || null,
            amount,
            currency,
            valueAddedTaxIncluded: vatIncluded,
            amountNet,
            dateSigned: contract.dateSigned
              ? new Date(contract.dateSigned)
              : null,
            date: contract.date ? new Date(contract.date) : null,
            dateModified: contract.dateModified
              ? new Date(contract.dateModified)
              : null,
            dateCreated: contract.dateCreated
              ? new Date(contract.dateCreated)
              : null,
            periodStartDate: pDate(contract.period?.startDate),
            periodEndDate: pDate(contract.period?.endDate),
            supplierEdrpou: sanitize(supplierEdrpou),
            supplierName: sanitize(supplierName),
            tenderId: tenderDetails.id,
          },
          items,
        };
      });

      // Collect all unique companies (by ЄДРПОУ) for upsert
      const companyMap = new Map<string, CompanyData>();

      // Customer
      if (customerEdrpou) {
        companyMap.set(customerEdrpou, {
          edrpou: customerEdrpou,
          name: customerName,
          region: customerRegion,
          locality: customerLocality,
        });
      }

      // Suppliers from contracts
      for (const cw of contractWrites) {
        const edrpou = cw.data.supplierEdrpou;
        if (edrpou && !companyMap.has(edrpou)) {
          companyMap.set(edrpou, {
            edrpou,
            name: cw.data.supplierName,
            region: null,
            locality: null,
          });
        }
      }

      // Bidders from bids
      for (const bid of bids) {
        if (bid.bidderEdrpou && !companyMap.has(bid.bidderEdrpou)) {
          companyMap.set(bid.bidderEdrpou, {
            edrpou: bid.bidderEdrpou,
            name: bid.bidderName,
            region: null,
            locality: null,
          });
        }
      }

      // Complainants from complaints
      for (const c of complaints) {
        if (c.complainantEdrpou && !companyMap.has(c.complainantEdrpou)) {
          companyMap.set(c.complainantEdrpou, {
            edrpou: c.complainantEdrpou,
            name: c.complainantName,
            region: null,
            locality: null,
          });
        }
      }

      // Upsert companies one-by-one (no transaction) to avoid deadlocks
      // when multiple workers upsert the same company concurrently.
      // Uses DB write slot to respect connection pool limits.
      const edrpouToCompanyId = new Map<string, string>();
      if (companyMap.size > 0) {
        await this.withDbWriteSlot(async () => {
          for (const company of companyMap.values()) {
            for (let attempt = 1; attempt <= 3; attempt++) {
              try {
                const result = await this.prisma.company.upsert({
                  where: { edrpou: company.edrpou },
                  update: {
                    ...(company.name ? { name: company.name } : {}),
                    ...(company.region ? { region: company.region } : {}),
                    ...(company.locality ? { locality: company.locality } : {}),
                  },
                  create: {
                    edrpou: company.edrpou,
                    name: company.name,
                    region: company.region,
                    locality: company.locality,
                  },
                  select: { id: true, edrpou: true },
                });
                edrpouToCompanyId.set(result.edrpou, result.id);
                break;
              } catch (e: unknown) {
                if (attempt === 3) throw e;
                await new Promise((r) => setTimeout(r, 50 * attempt));
              }
            }
          }
        });
      }

      // Resolve FK IDs
      const customerId = customerEdrpou ? edrpouToCompanyId.get(customerEdrpou) ?? null : null;

      const deleteWhere: Prisma.ContractWhereInput =
        expectedContractIds.length > 0
          ? {
              tenderId: tenderDetails.id,
              id: { notIn: expectedContractIds },
            }
          : { tenderId: tenderDetails.id };

      const transactionOperations: Prisma.PrismaPromise<unknown>[] = [
        this.prisma.tender.upsert({
          where: { id: tenderDetails.id },
          update: { ...tenderWriteData, customerId },
          create: {
            id: tenderDetails.id,
            ...tenderWriteData,
            customerId,
          },
        }),
        ...contractWrites.map(({ id, data }) => {
          const supplierId = data.supplierEdrpou
            ? edrpouToCompanyId.get(data.supplierEdrpou) ?? null
            : null;
          return this.prisma.contract.upsert({
            where: { id },
            update: { ...data, supplierId },
            create: { id, ...data, supplierId },
          });
        }),
        // Upsert items for each contract
        ...contractWrites.flatMap(({ id: contractId, items }) =>
          items.map((item) =>
            this.prisma.item.upsert({
              where: { id: item.id },
              update: { ...item, contractId },
              create: { ...item, contractId },
            }),
          ),
        ),
        // Delete stale items per contract (compare only with that contract's item IDs)
        ...contractWrites.map(({ id: contractId, items }) => {
          const contractItemIds = items.map((item) => item.id);
          return this.prisma.item.deleteMany({
            where: {
              contractId,
              ...(contractItemIds.length > 0
                ? { id: { notIn: contractItemIds } }
                : {}),
            },
          });
        }),
        this.prisma.contract.deleteMany({
          where: deleteWhere,
        }),
        // Upsert lots/bids/complaints
        ...lots.map((lot) =>
          this.prisma.lot.upsert({
            where: { id: lot.id },
            update: { ...lot, tenderId: tenderDetails.id },
            create: { ...lot, tenderId: tenderDetails.id },
          }),
        ),
        ...bids.map((bid) => {
          const bidderId = bid.bidderEdrpou
            ? edrpouToCompanyId.get(bid.bidderEdrpou) ?? null
            : null;
          return this.prisma.bid.upsert({
            where: { id: bid.id },
            update: { ...bid, tenderId: tenderDetails.id, bidderId },
            create: { ...bid, tenderId: tenderDetails.id, bidderId },
          });
        }),
        ...complaints.map((c) => {
          const complainantId = c.complainantEdrpou
            ? edrpouToCompanyId.get(c.complainantEdrpou) ?? null
            : null;
          return this.prisma.complaint.upsert({
            where: { id: c.id },
            update: { ...c, tenderId: tenderDetails.id, complainantId },
            create: { ...c, tenderId: tenderDetails.id, complainantId },
          });
        }),
        // Delete stale lots/bids/complaints that no longer exist in Prozorro payload
        this.prisma.lot.deleteMany({
          where: {
            tenderId: tenderDetails.id,
            ...(lots.length > 0 ? { id: { notIn: lots.map((l) => l.id) } } : {}),
          },
        }),
        this.prisma.bid.deleteMany({
          where: {
            tenderId: tenderDetails.id,
            ...(bids.length > 0 ? { id: { notIn: bids.map((b) => b.id) } } : {}),
          },
        }),
        this.prisma.complaint.deleteMany({
          where: {
            tenderId: tenderDetails.id,
            ...(complaints.length > 0 ? { id: { notIn: complaints.map((c) => c.id) } } : {}),
          },
        }),
      ];

      if (hasFailedContracts) {
        transactionOperations.push(
          this.prisma.tender.update({
            where: { id: tenderDetails.id },
            data: { syncStatus: 'PARTIAL' },
          }),
        );
      }

      // Split large transactions into batches to avoid timeouts
      const BATCH_SIZE = 50;
      await this.withDbWriteSlot(async () => {
        if (transactionOperations.length <= BATCH_SIZE) {
          await this.prisma.$transaction(transactionOperations);
        } else {
          // First batch: tender upsert + contracts (must be atomic)
          const coreBatchEnd = 1 + contractWrites.length;
          await this.prisma.$transaction(transactionOperations.slice(0, coreBatchEnd));
          // Remaining operations in batches
          const rest = transactionOperations.slice(coreBatchEnd);
          for (let i = 0; i < rest.length; i += BATCH_SIZE) {
            await this.prisma.$transaction(rest.slice(i, i + BATCH_SIZE));
          }
        }
      });

      if (hasFailedContracts) {
        this.partialCount++;
      }

      // Update aggregate counters (no per-tender log)
      const itemsCount = contractWrites.reduce((sum, cw) => sum + cw.items.length, 0);
      this.processedTenders++;
      this.processedContracts += contractsCount;
      this.processedItems += itemsCount;

      return {
        success: true,
        customers: customerEdrpou ? 1 : 0,
        contracts: contractsCount,
      };
    } catch (error) {
      this.errorCount++;
      const fallbackDateModified = job.data.dateModified
        ? new Date(job.data.dateModified)
        : new Date();
      const safeDateModified = Number.isNaN(fallbackDateModified.getTime())
        ? new Date()
        : fallbackDateModified;

      await this.withDbWriteSlot(() =>
        this.prisma.tender.upsert({
          where: { id: tenderId },
          update: {
            year: safeDateModified.getUTCFullYear(),
            dateModified: safeDateModified,
            syncStatus: 'FAILED',
          },
          create: {
            id: tenderId,
            year: safeDateModified.getUTCFullYear(),
            dateModified: safeDateModified,
            syncStatus: 'FAILED',
          },
        }),
      );
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(
        `Failed to process tender ${tenderId}: ${err.message}`,
        err.stack,
      );
      throw error;
    }
  }
}
