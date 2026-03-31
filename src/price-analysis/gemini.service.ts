import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import {
  ContractItemReference,
  ExtractedItem,
  MarketPriceResult,
  MarketSearchItem,
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

const MARKET_PRICE_PROMPT = `For each of the following items from a Ukrainian public procurement contract,
find the current average market price {REGION_CONTEXT}(in UAH per contract unit).

Items:
{ITEMS}

Critical unit-matching rules:
- The returned price must match the contract unit, not just the product name.
- Carefully distinguish "шт/штука" from "упаковка/пачка/блістер/коробка/комплект".
- For medicines and medical supplies, item names may contain pack-size markers like "№10", "№30", "№100". Market listings often show prices for the whole pack.
- If the contract unit is a single piece and the market listing is a package price, convert to one piece only when the number of pieces in the package is explicit and reliable.
- If the contract unit is a package and the market listing is a price per piece, convert to one package only when the package size is explicit and reliable.
- If reliable conversion is not possible, set marketPrice to null and explain the unit mismatch in the source.
- Do not compare different dosage forms, strengths, package sizes, or non-equivalent units.

For each item, return a JSON array where each element has:
- "itemName": string (same as input)
- "marketPrice": number or null (average price in UAH per contract unit)
- "marketPriceMin": number or null
- "marketPriceMax": number or null
- "pricingUnit": string or null (unit from the market listing before normalization, e.g. "упаковка №30", "1 шт", "блістер")
- "unitsPerPackage": number or null (only when explicit and reliable)
- "normalizedToContractUnit": boolean
- "source": string (brief explanation in Ukrainian; mention if the price was normalized to the contract unit)

Use current Ukrainian market data{REGION_SEARCH_HINT}. If you cannot find a reliable price for an item,
set marketPrice to null and explain why in the source field.
Return ONLY the JSON array, no other text.`;

const ITEMS_PER_BATCH = 10;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 2_000;
const MAX_INPUT_TEXT_LENGTH = 30_000;

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

    const results: MarketPriceResult[] = [];

    // Process in batches of ITEMS_PER_BATCH
    for (let i = 0; i < items.length; i += ITEMS_PER_BATCH) {
      const batch = items.slice(i, i + ITEMS_PER_BATCH);
      const batchResults = await this.searchMarketPricesBatch(batch, region);
      results.push(...batchResults);
    }

    return results;
  }

  private async searchMarketPricesBatch(
    items: MarketSearchItem[],
    region?: string | null,
  ): Promise<MarketPriceResult[]> {
    const itemsJson = JSON.stringify(
      items.map((item) => {
        const context = buildMarketSearchContext(item);
        return {
          itemName: context.itemName,
          contractUnit: context.unit || 'шт',
          contractUnitKind: context.contractUnitKind,
          declaredPackSize: context.declaredPackSize,
          packagingHint: context.packagingHint,
        };
      }),
    );

    const regionContext = region ? `в регіоні "${region}" ` : '';
    const regionSearchHint = region
      ? `, пріоритизуй ціни для регіону "${region}", але якщо регіональні дані відсутні — використовуй загальноукраїнські`
      : '';

    const prompt = MARKET_PRICE_PROMPT.replace(
      '{REGION_CONTEXT}',
      regionContext,
    )
      .replace('{REGION_SEARCH_HINT}', regionSearchHint)
      .replace('{ITEMS}', itemsJson);
    const result = await this.callWithRetry(
      () => this.searchModel.generateContent(prompt),
      'searchMarketPrices',
    );
    const text = result.response.text();

    try {
      const parsed = this.parseJsonArray<any>(text);
      return items.map((inputItem, index) => {
        const item = parsed[index] ?? {};
        const result: MarketPriceResult = {
          itemName:
            typeof item.itemName === 'string'
              ? item.itemName
              : inputItem.itemName,
          marketPrice:
            typeof item.marketPrice === 'number' && isFinite(item.marketPrice)
              ? item.marketPrice
              : null,
          marketPriceMin:
            typeof item.marketPriceMin === 'number' &&
            isFinite(item.marketPriceMin)
              ? item.marketPriceMin
              : null,
          marketPriceMax:
            typeof item.marketPriceMax === 'number' &&
            isFinite(item.marketPriceMax)
              ? item.marketPriceMax
              : null,
          source: typeof item.source === 'string' ? item.source : null,
          pricingUnit:
            typeof item.pricingUnit === 'string' ? item.pricingUnit : null,
          unitsPerPackage:
            typeof item.unitsPerPackage === 'number' &&
            isFinite(item.unitsPerPackage) &&
            item.unitsPerPackage > 1
              ? item.unitsPerPackage
              : null,
          normalizedToContractUnit:
            typeof item.normalizedToContractUnit === 'boolean'
              ? item.normalizedToContractUnit
              : null,
        };

        return normalizeMarketPriceResult(inputItem, result);
      });
    } catch {
      this.logger.error(
        `Failed to parse Gemini market price response: ${text.substring(0, 200)}`,
      );
      // Return empty results for this batch rather than failing entirely
      return items.map((item) => ({
        itemName: item.itemName,
        marketPrice: null,
        marketPriceMin: null,
        marketPriceMax: null,
        source: 'Не вдалося отримати ринкову ціну',
      }));
    }
  }
}
