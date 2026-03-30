import { buildFinalContractAnalysis } from './final-contract-analysis';

describe('buildFinalContractAnalysis', () => {
  it('формує агрегований висновок для контракту з повними даними', () => {
    const result = buildFinalContractAnalysis({
      contractAmount: 1250,
      currency: 'UAH',
      totalItems: 2,
      itemsAboveMarket: 1,
      extractedItems: [
        {
          itemName: 'Шприц',
          unitPrice: 100,
          quantity: 10,
          unit: 'шт',
          marketPrice: 80,
          priceDeviation: 0.25,
        },
        {
          itemName: 'Рукавички',
          unitPrice: 50,
          quantity: 5,
          unit: 'уп',
          marketPrice: 50,
          priceDeviation: 0,
        },
      ],
    });

    expect(result.itemsTotalAmount).toBe(1250);
    expect(result.consistency).toBe('ТАК');
    expect(result.marketCoveragePercent).toBe(100);
    expect(result.averageDeviationPercent).toBe(20);
    expect(result.overallAssessment).toBe('ПОТЕНЦІЙНО ЗАВИЩЕНО');
    expect(result.overpricingSigns).toBe('ТАК');
  });

  it('повертає недостатність даних, коли немає повних кількостей', () => {
    const result = buildFinalContractAnalysis({
      contractAmount: 1000,
      currency: 'UAH',
      totalItems: 2,
      itemsAboveMarket: 0,
      extractedItems: [
        {
          itemName: 'Катетер',
          unitPrice: 200,
          quantity: null,
          unit: 'шт',
          marketPrice: 180,
          priceDeviation: 0.111,
        },
        {
          itemName: 'Система',
          unitPrice: 300,
          quantity: 2,
          unit: 'шт',
          marketPrice: 290,
          priceDeviation: 0.034,
        },
      ],
    });

    expect(result.itemsTotalAmount).toBeNull();
    expect(result.consistency).toBe('НЕДОСТАТНЬО ДАНИХ');
    expect(result.overallAssessment).toBe('НЕДОСТАТНЬО ДАНИХ');
    expect(result.overpricingSigns).toBe('НЕДОСТАТНЬО ДАНИХ');
  });
});
