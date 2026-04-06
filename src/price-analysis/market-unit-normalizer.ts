import { MarketPriceResult, MarketSearchItem } from './price-analysis.types';

type UnitKind = 'piece' | 'package' | 'service' | 'weight' | 'volume' | 'other';

const PACKAGE_UNIT_PATTERNS = [
  /(?:^|[\s(,.;])уп\.?(?=$|[\s),.;])/iu,
  /упак/iu,
  /пачк/iu,
  /короб/iu,
  /блістер/iu,
  /блистер/iu,
  /комплект/iu,
  /набір/iu,
  /set\b/iu,
  /pack\b/iu,
  /box\b/iu,
];

const PIECE_UNIT_PATTERNS = [
  /(?:^|[\s(,.;])шт\.?(?=$|[\s),.;])/iu,
  /штук/iu,
  /штуц/iu,
  /(?:^|[\s(,.;])pcs?(?=$|[\s),.;])/iu,
  /капсул/iu,
  /таблет/iu,
  /драж/iu,
  /ампул/iu,
  /саше/iu,
  /доз/iu,
  /флакон/iu,
  /картридж/iu,
];

const SERVICE_UNIT_PATTERNS = [/послуг/iu, /робіт/iu, /комплект/iu];
const WEIGHT_UNIT_PATTERNS = [
  /(?:^|[\s(,.;])кг(?=$|[\s),.;])/iu,
  /(?:^|[\s(,.;])г(?=$|[\s),.;])/iu,
  /(?:^|[\s(,.;])мг(?=$|[\s),.;])/iu,
];
const VOLUME_UNIT_PATTERNS = [
  /(?:^|[\s(,.;])л(?=$|[\s),.;])/iu,
  /(?:^|[\s(,.;])мл(?=$|[\s),.;])/iu,
];
const MEDICATION_FORM_PATTERN =
  /капсул|таблет|драж|ампул|саше|супозитор|порошок|суспензі|розчин/iu;
const COUNT_HINT_PATTERNS = [
  /(?:№|N|No\.?|x|х)\s*(\d{1,4})(?=[\s),.;]|$)/iu,
  /\bпо\s*(\d{1,4})\s*(?:шт|табл?\.?|таблет(?:ок|ки)?|капс(?:ул)?\.?|капсул(?:а|и)?|амп\.?|ампул(?:а|и)?|саше|доз)\b/iu,
  /\b(\d{1,4})\s*(?:шт|табл?\.?|таблет(?:ок|ки)?|капс(?:ул)?\.?|капсул(?:а|и)?|амп\.?|ампул(?:а|и)?|саше|доз)\b/iu,
];

export interface MarketSearchContext extends MarketSearchItem {
  contractUnitKind: UnitKind;
  declaredPackSize: number | null;
  packagingHint: string | null;
}

function firstMatchingNumber(patterns: RegExp[], text: string): number | null {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const value = Number(match?.[1]);
    if (Number.isFinite(value) && value > 1) {
      return value;
    }
  }

  return null;
}

function classifyUnitKind(value: string | null | undefined): UnitKind {
  const text = value?.trim();
  if (!text) {
    return 'other';
  }

  if (PACKAGE_UNIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'package';
  }
  if (PIECE_UNIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'piece';
  }
  if (SERVICE_UNIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'service';
  }
  if (WEIGHT_UNIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'weight';
  }
  if (VOLUME_UNIT_PATTERNS.some((pattern) => pattern.test(text))) {
    return 'volume';
  }

  return 'other';
}

function appendNote(source: string | null, note: string): string {
  if (!source || source.trim().length === 0) {
    return note;
  }

  return `${source.trim()} ${note}`;
}

export function extractDeclaredPackSize(
  text: string | null | undefined,
): number | null {
  if (!text) {
    return null;
  }

  return firstMatchingNumber(COUNT_HINT_PATTERNS, text);
}

export function buildMarketSearchContext(
  item: MarketSearchItem,
): MarketSearchContext {
  const contractUnitKind = classifyUnitKind(item.unit);
  const declaredPackSize = extractDeclaredPackSize(item.itemName);

  let packagingHint: string | null = null;
  if (contractUnitKind === 'piece' && declaredPackSize) {
    packagingHint = `Назва містить фасування на ${declaredPackSize} одиниць. Якщо ринок дає ціну за упаковку, її треба перевести до 1 штуки.`;
  } else if (contractUnitKind === 'package' && declaredPackSize) {
    packagingHint = `Договірна одиниця схожа на упаковку, а назва містить фасування на ${declaredPackSize} одиниць.`;
  }

  return {
    itemName: item.itemName,
    unit: item.unit,
    quantity: item.quantity ?? null,
    contractUnitKind,
    declaredPackSize,
    packagingHint,
  };
}

function inferPricingUnitKind(result: MarketPriceResult): UnitKind {
  const pricingText = [result.pricingUnit, result.source]
    .filter((value): value is string =>
      Boolean(value && value.trim().length > 0),
    )
    .join(' ');

  if (!pricingText) {
    return 'other';
  }

  const byUnit = classifyUnitKind(pricingText);
  if (byUnit !== 'other') {
    return byUnit;
  }

  if (
    MEDICATION_FORM_PATTERN.test(pricingText) &&
    /(?:№|N|No\.?)\s*\d{1,4}/iu.test(pricingText)
  ) {
    return 'package';
  }

  return 'other';
}

function normalizePriceValue(
  value: number | null | undefined,
  factor: number,
  mode: 'divide' | 'multiply',
): number | null {
  if (
    typeof value !== 'number' ||
    !Number.isFinite(value) ||
    value <= 0 ||
    factor <= 1
  ) {
    return value ?? null;
  }

  return mode === 'divide' ? value / factor : value * factor;
}

export function normalizeMarketPriceResult(
  item: MarketSearchItem,
  result: MarketPriceResult,
): MarketPriceResult {
  if (result.marketPrice == null || result.normalizedToContractUnit === true) {
    return result;
  }

  const context = buildMarketSearchContext(item);
  const pricingUnitKind = inferPricingUnitKind(result);
  const factor =
    typeof result.unitsPerPackage === 'number' &&
    Number.isFinite(result.unitsPerPackage) &&
    result.unitsPerPackage > 1
      ? result.unitsPerPackage
      : context.declaredPackSize;

  if (context.contractUnitKind === 'piece' && pricingUnitKind === 'package') {
    if (factor && factor > 1) {
      return {
        ...result,
        marketPrice: normalizePriceValue(result.marketPrice, factor, 'divide'),
        marketPriceMin: normalizePriceValue(
          result.marketPriceMin,
          factor,
          'divide',
        ),
        marketPriceMax: normalizePriceValue(
          result.marketPriceMax,
          factor,
          'divide',
        ),
        source: appendNote(
          result.source,
          `Нормалізовано з ціни за упаковку до 1 штуки через явне фасування ${factor}.`,
        ),
      };
    }

    return {
      ...result,
      normalizedToContractUnit: false,
      source: appendNote(
        result.source,
        '⚠️ Ціна за упаковку — точне переведення до штуки невідоме.',
      ),
    };
  }

  if (context.contractUnitKind === 'package' && pricingUnitKind === 'piece') {
    if (factor && factor > 1) {
      return {
        ...result,
        marketPrice: normalizePriceValue(
          result.marketPrice,
          factor,
          'multiply',
        ),
        marketPriceMin: normalizePriceValue(
          result.marketPriceMin,
          factor,
          'multiply',
        ),
        marketPriceMax: normalizePriceValue(
          result.marketPriceMax,
          factor,
          'multiply',
        ),
        source: appendNote(
          result.source,
          `Нормалізовано з ціни за 1 штуку до упаковки через явне фасування ${factor}.`,
        ),
      };
    }

    return {
      ...result,
      normalizedToContractUnit: false,
      source: appendNote(
        result.source,
        '⚠️ Ціна за штуку — точне переведення до упаковки невідоме.',
      ),
    };
  }

  return result;
}
