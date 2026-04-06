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
const DEFAULT_GEMINI_SEARCH_MODEL = 'gemini-2.5-pro';

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

// Step 1: Market price search — expert audit prompt, Google Search grounding
const MARKET_SEARCH_QUERY = `Ти — експерт із ринкового аналізу та аудиту закупівель. Твоє завдання — перевірити адекватність ціни в договорі порівняно з актуальними ринковими даними.

Товар: {ITEM_NAME}
Одиниця виміру: {CONTRACT_UNIT}{PACKAGING_HINT}

Інструкція з виконання:
Пошук даних: Проведи пошук у мережі Інтернет (використовуючи маркетплейси, прайс-агрегатори та офіційні сайти постачальників), щоб знайти актуальну ціну на аналогічний товар або послугу. Враховуй дату підписання договору {DATE} та регіон {REGION}.

Порівняння: Знайди мінімальну, середню та максимальну ринкову ціну. Враховуй характеристики товару (якщо вони вказані) та одиниці виміру.
Якщо знайшов ціну за упаковку — перерахуй до {CONTRACT_UNIT}.
Якщо препарат контрольований — використовуй оптову/держзакупівельну ціну.
Якщо не знайдено точно — дай приблизну оцінку на основі аналогів.

ВАЖЛИВО: Ти ЗОБОВ'ЯЗАНИЙ повернути три числа. Навіть якщо точної інформації немає — дай приблизну оцінку на основі аналогічних товарів, загальних знань про ринок медикаментів або суміжних категорій. Відповідь "не знайдено" або відсутність чисел — НЕПРИПУСТИМА.

Відповідь: три числа через кому: мінімальна середня максимальна (тільки числа, без тексту).`;

// Step 2: Extract structured JSON from the numbers returned by search
const PRICE_EXTRACTION_PROMPT = `З наступного тексту витягни ринкові ціни для товару.

Товар: {ITEM_NAME}
Одиниця договору: {CONTRACT_UNIT}

Текст відповіді:
{SEARCH_RESULT}

У тексті мають бути числа — мінімальна, середня та максимальна ціна за одиницю.
Якщо числа є — витягни їх. Якщо є тільки одне число — використай його як середню ціну.
Якщо в тексті числа відсутні або нечіткі — самостійно оціни приблизну ринкову ціну для цього товару в Україні і постав її як marketPrice.

ВАЖЛИВО: "marketPrice" НІКОЛИ не може бути null. Завжди постав хоча б приблизне число.

Поверни ТІЛЬКИ JSON об'єкт, без іншого тексту:
{"marketPrice": number, "marketPriceMin": number|null, "marketPriceMax": number|null, "source": string|null}

де "source" — коротко що знайдено або на чому базується оцінка (1 речення).`;

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
      process.env.GEMINI_SEARCH_MODEL?.trim() || DEFAULT_GEMINI_SEARCH_MODEL;

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
    dateSigned?: Date | null,
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
              dateSigned,
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
    dateSigned?: Date | null,
  ): Promise<MarketPriceResult> {
    const context = buildMarketSearchContext(item);
    const packagingHint = context.packagingHint
      ? `\nПримітка: ${context.packagingHint}`
      : '';
    const regionStr = region || 'Україна';
    const dateStr = dateSigned
      ? dateSigned.toLocaleDateString('uk-UA', { year: 'numeric', month: 'long', day: 'numeric' })
      : new Date().toLocaleDateString('uk-UA', { year: 'numeric', month: 'long' });

    // Step 1: Expert market search with Google Search grounding
    const unit = context.unit || 'шт';
    const searchQuery = MARKET_SEARCH_QUERY
      .replaceAll('{ITEM_NAME}', context.itemName)
      .replaceAll('{CONTRACT_UNIT}', unit)
      .replaceAll('{PACKAGING_HINT}', packagingHint)
      .replaceAll('{REGION}', regionStr)
      .replaceAll('{DATE}', dateStr);

    const searchResponse = await this.callWithRetry(
      () => this.searchModel.generateContent(searchQuery),
      `searchItem:${item.itemName.substring(0, 40)}`,
    );
    const searchText = searchResponse.response.text();
    this.logger.debug(
      `searchSingleItem search response for "${item.itemName.substring(0, 50)}": ${searchText.substring(0, 400)}`,
    );

    // Step 2: Extract structured JSON from the natural search response
    const extractionPrompt = PRICE_EXTRACTION_PROMPT
      .replaceAll('{ITEM_NAME}', context.itemName)
      .replaceAll('{CONTRACT_UNIT}', unit)
      .replace('{SEARCH_RESULT}', searchText);

    const extractionResponse = await this.callWithRetry(
      () => this.model.generateContent(extractionPrompt),
      `extractPrice:${item.itemName.substring(0, 40)}`,
    );
    const extractionText = extractionResponse.response.text();
    this.logger.debug(
      `extractPrice result for "${item.itemName.substring(0, 50)}": ${extractionText.substring(0, 300)}`,
    );

    try {
      const parsed = this.parseJsonObject<any>(extractionText);
      return {
        itemName: item.itemName,
        marketPrice:
          typeof parsed.marketPrice === 'number' && isFinite(parsed.marketPrice)
            ? parsed.marketPrice
            : null,
        marketPriceMin:
          typeof parsed.marketPriceMin === 'number' && isFinite(parsed.marketPriceMin)
            ? parsed.marketPriceMin
            : null,
        marketPriceMax:
          typeof parsed.marketPriceMax === 'number' && isFinite(parsed.marketPriceMax)
            ? parsed.marketPriceMax
            : null,
        source: typeof parsed.source === 'string' ? parsed.source : null,
      };
    } catch {
      this.logger.warn(
        `Failed to parse extraction response for "${item.itemName.substring(0, 40)}": ${extractionText.substring(0, 300)}, trying fallback estimate`,
      );
      // Fallback: ask model to just give a number
      try {
        const fallbackPrompt = `Яка приблизна роздрібна або оптова ціна в Україні за одиницю (${context.unit || 'шт'}) для товару "${context.itemName}"? Відповідь: тільки одне число в гривнях, без тексту.`;
        const fallbackResponse = await this.callWithRetry(
          () => this.model.generateContent(fallbackPrompt),
          `fallbackPrice:${item.itemName.substring(0, 40)}`,
        );
        const fallbackText = fallbackResponse.response.text().trim();
        const fallbackPrice = parseFloat(fallbackText.replace(/[^\d.,]/g, '').replace(',', '.'));
        if (isFinite(fallbackPrice) && fallbackPrice > 0) {
          return {
            itemName: item.itemName,
            marketPrice: fallbackPrice,
            marketPriceMin: null,
            marketPriceMax: null,
            source: '⚠️ Приблизна оцінка моделі',
          };
        }
      } catch {
        // ignore fallback error
      }
      return {
        itemName: item.itemName,
        marketPrice: null,
        marketPriceMin: null,
        marketPriceMax: null,
        source: null,
      };
    }
  }

}
