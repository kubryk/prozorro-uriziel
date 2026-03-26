import { Injectable, Logger, OnModuleDestroy } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom, timer } from 'rxjs';
import { retry } from 'rxjs/operators';
import {
  ProzorroTenderDetails,
  ProzorroContractDetails,
  ProzorroTenderListItem,
  ProzorroTendersPageResponse,
} from './prozorro.types';

@Injectable()
export class ProzorroService implements OnModuleDestroy {
  private readonly logger = new Logger(ProzorroService.name);
  private readonly baseUrl = 'https://public.api.openprocurement.org/api/2.5';
  private readonly refillInterval: ReturnType<typeof setInterval>;

  constructor(private readonly httpService: HttpService) {
    // Refill tokens every second (per-instance — no global Redis coordination)
    this.refillInterval = setInterval(() => {
      this.tokens = this.maxTokens;
      while (this.tokens > 0 && this.pendingQueue.length > 0) {
        this.pendingQueue.shift()!();
        this.tokens--;
      }
    }, 1000);
  }

  onModuleDestroy() {
    clearInterval(this.refillInterval);
  }

  // Per-instance rate limiter (token bucket)
  private readonly maxTokens = parseInt(
    process.env.WORKER_REQUESTS_PER_SECOND || '50',
    10,
  );
  private tokens = parseInt(process.env.WORKER_REQUESTS_PER_SECOND || '50', 10);
  private pendingQueue: Array<() => void> = [];

  private acquireRateLimit(): Promise<void> {
    if (this.tokens > 0) {
      this.tokens--;
      return Promise.resolve();
    }
    // No tokens available — wait for the next refill
    return new Promise<void>((resolve) => this.pendingQueue.push(resolve));
  }

  private getRetryConfig() {
    return {
      count: 3,
      delay: (error: any, retryCount: number) => {
        this.logger.warn(
          `API Error (${error.message}). Retrying... attempt ${retryCount}`,
        );
        return timer(1000 * retryCount); // Backoff: 1s, 2s, 3s
      },
    };
  }

  async getTendersPage(
    offset?: string,
  ): Promise<{ data: ProzorroTenderListItem[]; nextPageOffset: string | null }> {
    try {
      await this.acquireRateLimit();

      const url = new URL(`${this.baseUrl}/tenders`);
      if (offset) {
        url.searchParams.set('offset', offset);
      }

      const response = await firstValueFrom(
        this.httpService.get<ProzorroTendersPageResponse>(url.toString()).pipe(retry(this.getRetryConfig())),
      );
      const responseData = response.data;

      return {
        data: responseData.data || [],
        nextPageOffset: responseData.next_page?.offset || null,
      };
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Error fetching tenders page: ${err.message}`, err.stack);
      throw error;
    }
  }

  async getTenderDetails(tenderId: string): Promise<ProzorroTenderDetails> {
    try {
      await this.acquireRateLimit();

      const url = `${this.baseUrl}/tenders/${tenderId}`;
      const response = await firstValueFrom(
        this.httpService.get<{ data: ProzorroTenderDetails }>(url).pipe(retry(this.getRetryConfig())),
      );
      return response.data.data;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Error fetching tender ${tenderId}: ${err.message}`, err.stack);
      throw error;
    }
  }

  async getContractDetails(tenderId: string, contractId: string): Promise<ProzorroContractDetails> {
    try {
      await this.acquireRateLimit();

      const url = `${this.baseUrl}/contracts/${contractId}`;
      const response = await firstValueFrom(
        this.httpService.get<{ data: ProzorroContractDetails }>(url).pipe(retry(this.getRetryConfig())),
      );
      return response.data.data;
    } catch (error: unknown) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.logger.error(`Error fetching contract ${contractId}: ${err.message}`, err.stack);
      throw error;
    }
  }
}
