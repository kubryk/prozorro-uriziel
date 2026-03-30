import {
  buildMarketSearchContext,
  extractDeclaredPackSize,
  normalizeMarketPriceResult,
} from './market-unit-normalizer';

describe('market-unit-normalizer', () => {
  it('витягує фасування з позначення №30', () => {
    expect(extractDeclaredPackSize('ОМЕПРАЗОЛ, капсули 40 мг, №30')).toBe(30);
  });

  it('нормалізує ринкову ціну з упаковки до штуки, коли фасування явне', () => {
    const result = normalizeMarketPriceResult(
      {
        itemName: 'ОМЕПРАЗОЛ, капсули 40 мг, №30',
        unit: 'штука',
      },
      {
        itemName: 'ОМЕПРАЗОЛ, капсули 40 мг, №30',
        marketPrice: 231,
        marketPriceMin: 210,
        marketPriceMax: 297,
        pricingUnit: 'упаковка №30',
        unitsPerPackage: 30,
        normalizedToContractUnit: false,
        source:
          'Ціни на Омепразол капсули 40 мг №30 стартують від 231 грн за упаковку.',
      },
    );

    expect(result.marketPrice).toBeCloseTo(7.7, 5);
    expect(result.marketPriceMin).toBeCloseTo(7, 5);
    expect(result.marketPriceMax).toBeCloseTo(9.9, 5);
    expect(result.source).toContain(
      'Нормалізовано з ціни за упаковку до 1 штуки',
    );
  });

  it('скидає ринкову ціну, якщо знайдено лише упаковку без надійного фасування', () => {
    const result = normalizeMarketPriceResult(
      {
        itemName: 'Омепразол 40 мг',
        unit: 'штука',
      },
      {
        itemName: 'Омепразол 40 мг',
        marketPrice: 231,
        marketPriceMin: 210,
        marketPriceMax: 297,
        pricingUnit: 'упаковка',
        unitsPerPackage: null,
        normalizedToContractUnit: false,
        source: 'Знайдено ціну за упаковку без уточнення кількості.',
      },
    );

    expect(result.marketPrice).toBeNull();
    expect(result.marketPriceMin).toBeNull();
    expect(result.marketPriceMax).toBeNull();
    expect(result.source).toContain('немає надійного переведення');
  });

  it('додає підказку для пошуку, коли в назві є фасування і договірна одиниця штучна', () => {
    const context = buildMarketSearchContext({
      itemName: 'ОМЕПРАЗОЛ, капсули 40 мг, №30',
      unit: 'шт',
    });

    expect(context.contractUnitKind).toBe('piece');
    expect(context.declaredPackSize).toBe(30);
    expect(context.packagingHint).toContain('30');
  });
});
