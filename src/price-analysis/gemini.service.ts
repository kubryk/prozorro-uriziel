import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { GoogleGenerativeAI, GenerativeModel } from '@google/generative-ai';
import { ExtractedItem, MarketPriceResult } from './price-analysis.types';

const EXTRACTION_PROMPT = `You are analyzing a Ukrainian public procurement contract specification.
Extract all items with their prices from the following text.

Return a JSON array where each element has:
- "itemName": string (item name in Ukrainian, as written)
- "unitPrice": number (price per unit in UAH, without VAT if specified separately)
- "quantity": number or null
- "unit": string or null (e.g., "шт", "кг", "л", "м", "послуга", "комплект")

Only include items where you can identify both a name and a unit price.
If the text contains a table, extract each row as a separate item.
Return ONLY the JSON array, no other text.

Text:
`;

const MARKET_PRICE_PROMPT = `For each of the following items from a Ukrainian public procurement contract,
find the current average market price in Ukraine (in UAH per unit).

Items:
{ITEMS}

For each item, return a JSON array where each element has:
- "itemName": string (same as input)
- "marketPrice": number or null (average price in UAH per unit)
- "marketPriceMin": number or null
- "marketPriceMax": number or null
- "source": string (brief explanation of where you found this price, in Ukrainian)

Use current Ukrainian market data. If you cannot find a reliable price for an item,
set marketPrice to null and explain why in the source field.
Return ONLY the JSON array, no other text.`;

const ITEMS_PER_BATCH = 10;

@Injectable()
export class GeminiService implements OnModuleInit {
  private readonly logger = new Logger(GeminiService.name);
  private model: GenerativeModel;
  private searchModel: GenerativeModel;

  onModuleInit() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      this.logger.warn('GEMINI_API_KEY not set — price analysis will not work');
      return;
    }

    const genAI = new GoogleGenerativeAI(apiKey);

    this.model = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
    });

    this.searchModel = genAI.getGenerativeModel({
      model: 'gemini-2.0-flash',
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
      },
      tools: [{ googleSearch: {} } as any],
    });
  }

  async extractItemsFromText(specificationText: string): Promise<ExtractedItem[]> {
    if (!this.model) throw new Error('Gemini not configured');

    const result = await this.model.generateContent(
      EXTRACTION_PROMPT + specificationText,
    );
    const text = result.response.text();

    try {
      const items: any[] = JSON.parse(text);
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
    } catch {
      this.logger.error(`Failed to parse Gemini extraction response: ${text.substring(0, 200)}`);
      throw new Error('Failed to parse item extraction response from Gemini');
    }
  }

  async searchMarketPrices(
    items: { itemName: string; unit: string | null }[],
  ): Promise<MarketPriceResult[]> {
    if (!this.searchModel) throw new Error('Gemini not configured');

    const results: MarketPriceResult[] = [];

    // Process in batches of ITEMS_PER_BATCH
    for (let i = 0; i < items.length; i += ITEMS_PER_BATCH) {
      const batch = items.slice(i, i + ITEMS_PER_BATCH);
      const batchResults = await this.searchMarketPricesBatch(batch);
      results.push(...batchResults);
    }

    return results;
  }

  private async searchMarketPricesBatch(
    items: { itemName: string; unit: string | null }[],
  ): Promise<MarketPriceResult[]> {
    const itemsJson = JSON.stringify(
      items.map((item) => ({
        itemName: item.itemName,
        unit: item.unit || 'шт',
      })),
    );

    const prompt = MARKET_PRICE_PROMPT.replace('{ITEMS}', itemsJson);
    const result = await this.searchModel.generateContent(prompt);
    const text = result.response.text();

    try {
      const parsed: any[] = JSON.parse(text);
      return parsed.map((item) => ({
        itemName: typeof item.itemName === 'string' ? item.itemName : '',
        marketPrice:
          typeof item.marketPrice === 'number' && isFinite(item.marketPrice)
            ? item.marketPrice
            : null,
        marketPriceMin:
          typeof item.marketPriceMin === 'number' && isFinite(item.marketPriceMin)
            ? item.marketPriceMin
            : null,
        marketPriceMax:
          typeof item.marketPriceMax === 'number' && isFinite(item.marketPriceMax)
            ? item.marketPriceMax
            : null,
        source:
          typeof item.source === 'string' ? item.source : null,
      }));
    } catch {
      this.logger.error(`Failed to parse Gemini market price response: ${text.substring(0, 200)}`);
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
