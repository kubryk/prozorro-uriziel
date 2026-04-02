import { Injectable, Logger } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { firstValueFrom } from 'rxjs';
import { MarketPriceResult } from './price-analysis.types';

export interface N8nMarketItem {
  id: string;
  itemName: string;
  unit: string | null;
}

export interface N8nWebhookRequest {
  analysisId: string;
  contractId: string;
  region: string | null;
  items: N8nMarketItem[];
}

interface N8nWebhookResponseItem {
  id: string;
  name?: string | null;
  market_avg?: number | null;
  market_min?: number | null;
  market_max?: number | null;
  source?: string | null;
}

@Injectable()
export class N8nMarketPriceService {
  private readonly logger = new Logger(N8nMarketPriceService.name);

  constructor(private readonly http: HttpService) {}

  get isAvailable(): boolean {
    return !!process.env.N8N_MARKET_PRICE_WEBHOOK_URL?.trim();
  }

  async searchMarketPrices(
    items: N8nMarketItem[],
    region: string | null,
    analysisId: string,
    contractId: string,
  ): Promise<Map<string, MarketPriceResult>> {
    const webhookUrl = process.env.N8N_MARKET_PRICE_WEBHOOK_URL?.trim();
    if (!webhookUrl) {
      throw new Error('N8N_MARKET_PRICE_WEBHOOK_URL is not configured');
    }

    const payload: N8nWebhookRequest = {
      analysisId,
      contractId,
      region,
      items,
    };

    this.logger.log(
      `Sending ${items.length} items to n8n webhook for analysis ${analysisId}`,
    );

    const response = await firstValueFrom(
      this.http.post<N8nWebhookResponseItem[]>(webhookUrl, payload, {
        timeout: 300_000,
        headers: { 'Content-Type': 'application/json' },
      }),
    );

    const data = response.data;

    if (!Array.isArray(data)) {
      throw new Error(
        `n8n webhook returned unexpected response type: ${typeof data}`,
      );
    }

    this.logger.log(
      `n8n webhook returned ${data.length} results for analysis ${analysisId}`,
    );

    const resultMap = new Map<string, MarketPriceResult>();
    for (const entry of data) {
      if (!entry || typeof entry.id !== 'string') continue;
      const item = items.find((i) => i.id === entry.id);
      resultMap.set(entry.id, {
        itemName: item?.itemName ?? entry.id,
        marketPrice:
          typeof entry.market_avg === 'number' && isFinite(entry.market_avg)
            ? entry.market_avg
            : null,
        marketPriceMin:
          typeof entry.market_min === 'number' && isFinite(entry.market_min)
            ? entry.market_min
            : null,
        marketPriceMax:
          typeof entry.market_max === 'number' && isFinite(entry.market_max)
            ? entry.market_max
            : null,
        source: typeof entry.source === 'string' ? entry.source : null,
      });
    }

    // Warn for any items that got no result
    for (const item of items) {
      if (!resultMap.has(item.id)) {
        this.logger.warn(
          `n8n did not return a result for item id=${item.id} "${item.itemName.substring(0, 60)}"`,
        );
      }
    }

    return resultMap;
  }
}
