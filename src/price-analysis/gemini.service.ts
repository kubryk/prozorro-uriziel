import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import {
  ContractItemReference,
  ExtractedItem,
  MarketPriceResult,
  MarketSearchItem,
  MarketSearchItemWithId,
} from './price-analysis.types';
import {
  buildMarketSearchContext,
  normalizeMarketPriceResult,
} from './market-unit-normalizer';

const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash-lite';

const EXTRACTION_PROMPT = `You are analyzing a Ukrainian public procurement contract specification.
Extract all items with their prices from the following text.

Return a JSON array where each element has:
- "itemName": string (item name in Ukrainian, as written)
- "unitPrice": number (price per unit in UAH, without VAT if specified separately)
- "quantity": number or null
- "unit": string or null (e.g., "шт", "кг", "л", "м", "послуга", "комплект")

Only include items where you can identify both a name and a unit price.
If the text contains a table, extract each row as a separate item.
Do NOT use the general subject or title of the contract as an item.
Do NOT treat the total contract amount as a unit price unless the document explicitly shows a per-unit price for a specific row.
Preserve the most specific wording visible in the document row.
Preserve brands, trade names, manufacturers, model codes, article numbers, dosage, and package markers like "№30" whenever they are visible in the PDF.
Use official contract items from Prozorro only as weak validation when the PDF row is partially unreadable.
Never replace a more detailed PDF item name with a shorter or more generic official item name from Prozorro.
If the text does not contain a clear specification or a line-item table with explicit pricing, return an empty JSON array.
{REFERENCE_ITEMS_BLOCK}
Return ONLY the JSON array, no other text.

Text:
`;

// Single-item search prompt — one Gemini call per contract item
const SINGLE_ITEM_SEARCH_PROMPT = `Знайди поточну середню ринкову ціну в Україні{REGION_CONTEXT} для товару з держзакупівлі.

Товар: {ITEM_NAME}
Одиниця: {CONTRACT_UNIT}{PACKAGING_HINT}

Знайди найближчу ринкову ціну для цього товару. Якщо точно такий не знайдено — використай ціну найбільш схожого аналогу.
Якщо одиниця відрізняється — поверни ціну в знайденій одиниці і поясни в source.

Поверни JSON об'єкт:
- "marketPrice": number або null (null тільки якщо взагалі нічого не знайдено)
- "marketPriceMin": number або null
- "marketPriceMax": number або null
- "pricingUnit": string або null (одиниця з ринкового лістингу)
- "unitsPerPackage": number або null
- "normalizedToContractUnit": boolean
- "source": string (1-2 речення Ukrainian; що знайдено і де)

Використовуй поточні українські ринкові дані{REGION_SEARCH_HINT}.
Поверни ТІЛЬКИ JSON об'єкт, без іншого тексту.`;

const MARKET_SEARCH_CONCURRENCY = 3;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const MAX_INPUT_TEXT_LENGTH = 60_000;

@Injectable()
export class GeminiService implements OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private model: GenerativeModel;
  private searchModel: GenerativeModel;

  get isAvailable(): boolean {
    return !!this.model;
  }

  private async callWithRetry<T>(
    fn: () => Promise<T>,
    label: string,
  ): Promise<T> {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error: unknown) {
        const msg = error instanceof Error ? error.message : String(error);
        const isRetryable =
          msg.includes('429') ||
          msg.includes('503') ||
          msg.includes('RESOURCE_EXHAUSTED');

        if (!isRetryable || attempt === MAX_RETRIES) throw error;

        const delay = RETRY_BASE_DELAY_MS * 2 ** (attempt - 1);
        this.logger.warn(
          `${label}: attempt ${attempt}/${MAX_RETRIES} failed (${msg.substring(0, 80)}), retrying in ${delay}ms`,
        );
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error('unreachable');
  }

  private parseJsonArray<T>(text: string): T[] {
    const trimmedText = text.trim();
    const fencedMatch = trimmedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fencedMatch?.[1]?.trim() || trimmedText;

    const parsed: unknown = JSON.parse(candidate);
    if (!Array.isArray(parsed)) {
      throw new Error(`Expected JSON array but got ${typeof parsed}`);
    }
    return parsed as T[];
  }

  private parseJsonObject<T>(text: string): T {
    const trimmedText = text.trim();
    const fencedMatch = trimmedText.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
    const candidate = fencedMatch?.[1]?.trim() || trimmedText;

    const parsed: unknown = JSON.parse(candidate);

    // Accept single-element arrays — Gemini sometimes wraps object in array
    if (Array.isArray(parsed)) {
      if (
        parsed.length === 1 &&
        typeof parsed[0] === 'object' &&
        parsed[0] !== null
      ) {
        return parsed[0] as T;
      }
      throw new Error(`Expected JSON object but got array with ${parsed.length} elements`);
    }

    if (typeof parsed !== 'object' || parsed === null) {
      throw new Error(`Expected JSON object but got ${typeof parsed}`);
    }
    return parsed as T;
  }

  private normalizeExtractedItems(items: any[]): ExtractedItem[] {
    return items
      .filter(
        (item) =>
          typeof item.itemName === 'string' &&
          item.itemName.length > 0 &&
          typeof item.unitPrice === 'number' &&
          item.unitPrice > 0,
      )
      .map((item) => ({
        itemName: item.itemName,
        unitPrice: item.unitPrice,
        quantity:
          typeof item.quantity === 'number' && item.quantity > 0
            ? item.quantity
            : null,
        unit:
          typeof item.unit === 'string' && item.unit.length > 0
            ? item.unit
            : null,
      }));
  }

  private buildReferenceItemsBlock(
    referenceItems: ContractItemReference[],
  ): string {
    if (referenceItems.length === 0) {
      return '';
    }

    const lines = referenceItems.map((item, index) => {
      const details = [
        item.quantity != null ? `кількість: ${item.quantity}` : null,
        item.unit ? `одиниця: ${item.unit}` : null,
        item.classificationDescription
          ? `класифікація: ${item.classificationDescription}`
          : null,
      ].filter(Boolean);

      return `${index + 1}. ${item.itemName}${details.length > 0 ? ` (${details.join(', ')})` : ''}`;
    });

    return [
      '',
      'Official contract items from Prozorro are coarse metadata and may omit trade names, brands, article numbers, dosage, packaging, or model codes.',
      'Use them only as weak grounding when a PDF row is partially unreadable:',
      ...lines,
      'Never replace a more detailed PDF row with a simpler Prozorro item name.',
      'If no clear match exists, rely only on the visible specification rows.',
      '',
    ].join('\n');
  }

  onModuleInit() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set — price analysis will not work');
      return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);
    const extractionModelName =
      process.env.GEMINI_MODEL?.trim() || DEFAULT_GEMINI_MODEL;
    const searchModelName =
      process.env.GEMINI_SEARCH_MODEL?.trim() || extractionModelName;

    this.model = genAI.getGenerativeModel({
      model: extractionModelName,
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    this.searchModel = genAI.getGenerativeModel({
      model: searchModelName,
      generationConfig: {
        temperature: 0,
      },
      tools: [{ googleSearch: {} } as any],
    });

    this.logger.log(
      `Gemini configured: extraction=${extractionModelName}, search=${searchModelName}`,
    );
  }

  async extractItemsFromText(
    specificationText: string,
    referenceItems: ContractItemReference[] = [],
  ): Promise<ExtractedItem[]> {
    if (!this.model) throw new Error('Gemini not configured');
    const prompt = EXTRACTION_PROMPT.replace(
      '{REFERENCE_ITEMS_BLOCK}',
      this.buildReferenceItemsBlock(referenceItems),
    );

    const truncatedText =
      specificationText.length > MAX_INPUT_TEXT_LENGTH
        ? specificationText.slice(-MAX_INPUT_TEXT_LENGTH)
        : specificationText;

    const result = await this.callWithRetry(
      () => this.model.generateContent(prompt + truncatedText),
      'extractItems',
    );
    const text = result.response.text();

    try {
      return this.normalizeExtractedItems(this.parseJsonArray<any>(text));
    } catch {
      this.logger.error(
        `Failed to parse Gemini extraction response: ${text.substring(0, 200)}`,
      );
      throw new Error('Failed to parse item extraction response from Gemini');
    }
  }

  async searchMarketPrices(
    items: MarketSearchItem[],
    region?: string | null,
  ): Promise<MarketPriceResult[]> {
    if (!this.searchModel) throw new Error('Gemini not configured');

    const results: MarketPriceResult[] = new Array(items.length);

    for (let i = 0; i < items.length; i += MARKET_SEARCH_CONCURRENCY) {
      const chunk = items.slice(i, i + MARKET_SEARCH_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (item) => {
          try {
            return await this.searchSingleItem(item, region);
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Market price search failed for "${item.itemName.substring(0, 50)}": ${msg}`,
            );
            return {
              itemName: item.itemName,
              marketPrice: null,
              marketPriceMin: null,
              marketPriceMax: null,
              source: 'Помилка при пошуку ринкової ціни',
            };
          }
        }),
      );
      for (let j = 0; j < chunkResults.length; j++) {
        results[i + j] = chunkResults[j];
      }
    }

    return results;
  }

  async searchMarketPricesById(
    items: MarketSearchItemWithId[],
    region?: string | null,
  ): Promise<Map<string, MarketPriceResult>> {
    if (!this.searchModel) throw new Error('Gemini not configured');

    const resultMap = new Map<string, MarketPriceResult>();

    for (let i = 0; i < items.length; i += MARKET_SEARCH_CONCURRENCY) {
      const chunk = items.slice(i, i + MARKET_SEARCH_CONCURRENCY);
      const chunkResults = await Promise.all(
        chunk.map(async (item) => {
          try {
            const result = await this.searchSingleItem(
              { itemName: item.itemName, unit: item.unit },
              region,
            );
            return [item.id, result] as [string, MarketPriceResult];
          } catch (error: unknown) {
            const msg = error instanceof Error ? error.message : String(error);
            this.logger.warn(
              `Market price search failed for id=${item.id.substring(0, 8)} "${item.itemName.substring(0, 50)}": ${msg}`,
            );
            return [
              item.id,
              {
                itemName: item.itemName,
                marketPrice: null,
                marketPriceMin: null,
                marketPriceMax: null,
                source: null,
              },
            ] as [string, MarketPriceResult];
          }
        }),
      );
      for (const [id, result] of chunkResults) {
        resultMap.set(id, result);
      }
    }

    return resultMap;
  }

  private async searchSingleItem(
    item: MarketSearchItem,
    region?: string | null,
  ): Promise<MarketPriceResult> {
    const context = buildMarketSearchContext(item);

    const regionContext = region ? ` в регіоні "${region}"` : '';
    const regionSearchHint = region
      ? `, пріоритизуй ціни для регіону "${region}", але якщо регіональні дані відсутні — використовуй загальноукраїнські`
      : '';
    const packagingHint = context.packagingHint
      ? `\nПримітка: ${context.packagingHint}`
      : '';

    const prompt = SINGLE_ITEM_SEARCH_PROMPT.replace(
      '{REGION_CONTEXT}',
      regionContext,
    )
      .replace('{REGION_SEARCH_HINT}', regionSearchHint)
      .replace('{ITEM_NAME}', context.itemName)
      .replace('{CONTRACT_UNIT}', context.unit || 'шт')
      .replace('{PACKAGING_HINT}', packagingHint);

    const response = await this.callWithRetry(
      () => this.searchModel.generateContent(prompt),
      `searchItem:${item.itemName.substring(0, 40)}`,
    );
    const text = response.response.text();
    this.logger.debug(
      `searchSingleItem raw response for "${item.itemName.substring(0, 50)}": ${text.substring(0, 300)}`,
    );

    try {
      const parsed = this.parseJsonObject<any>(text);
      const result: MarketPriceResult = {
        itemName: item.itemName,
        marketPrice:
          typeof parsed.marketPrice === 'number' && isFinite(parsed.marketPrice)
            ? parsed.marketPrice
            : null,
        marketPriceMin:
          typeof parsed.marketPriceMin === 'number' &&
          isFinite(parsed.marketPriceMin)
            ? parsed.marketPriceMin
            : null,
        marketPriceMax:
          typeof parsed.marketPriceMax === 'number' &&
          isFinite(parsed.marketPriceMax)
            ? parsed.marketPriceMax
            : null,
        source: typeof parsed.source === 'string' ? parsed.source : null,
        pricingUnit:
          typeof parsed.pricingUnit === 'string' ? parsed.pricingUnit : null,
        unitsPerPackage:
          typeof parsed.unitsPerPackage === 'number' &&
          isFinite(parsed.unitsPerPackage) &&
          parsed.unitsPerPackage > 1
            ? parsed.unitsPerPackage
            : null,
        normalizedToContractUnit:
          typeof parsed.normalizedToContractUnit === 'boolean'
            ? parsed.normalizedToContractUnit
            : null,
      };
      return normalizeMarketPriceResult(item, result);
    } catch {
      this.logger.warn(
        `Failed to parse search response for "${item.itemName.substring(0, 40)}": ${text.substring(0, 300)}`,
      );
      return {
        itemName: item.itemName,
        marketPrice: null,
        marketPriceMin: null,
        marketPriceMax: null,
        source: 'Не вдалося отримати ринкову ціну',
      };
    }
  }

}
