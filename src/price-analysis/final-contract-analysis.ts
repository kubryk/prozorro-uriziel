export type ConsistencyStatus = 'ТАК' | 'НІ' | 'НЕДОСТАТНЬО ДАНИХ';
export type OverallAssessment =
  | 'ЗАНИЖЕНО'
  | 'РИНКОВО'
  | 'ПОТЕНЦІЙНО ЗАВИЩЕНО'
  | 'НЕДОСТАТНЬО ДАНИХ';
export type OverpricingStatus = 'ТАК' | 'НІ' | 'НЕДОСТАТНЬО ДАНИХ';

const AMOUNT_MATCH_TOLERANCE_RATIO = 0.05;
const AMOUNT_MATCH_TOLERANCE_ABSOLUTE = 1;
const MIN_MARKET_COVERAGE_PERCENT = 60;
const OVERPRICED_AVERAGE_DEVIATION_PERCENT = 15;
const UNDERPRICED_AVERAGE_DEVIATION_PERCENT = -15;

interface FinalAnalysisItemInput {
  itemName: string;
  unitPrice: number;
  quantity?: number | null;
  unit?: string | null;
  marketPrice?: number | null;
  priceDeviation?: number | null;
}

export interface FinalContractAnalysisInput {
  contractAmount?: number | null;
  currency?: string | null;
  totalItems?: number | null;
  itemsAboveMarket?: number | null;
  extractedItems: FinalAnalysisItemInput[];
}

export interface FinalContractAnalysisResult {
  itemsTotalAmount: number | null;
  contractAmount: number | null;
  consistency: ConsistencyStatus;
  averageDeviationPercent: number | null;
  marketCoveragePercent: number | null;
  overallAssessment: OverallAssessment;
  overpricingSigns: OverpricingStatus;
  comment: string;
}

function round(value: number, digits = 2): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function formatAmountForComment(amount: number | null, currency = 'UAH'): string {
  if (amount == null) return 'н/д';
  return `${amount.toLocaleString('uk-UA', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })} ${currency}`;
}

function formatPercentForComment(value: number | null): string {
  if (value == null) return 'н/д';
  const sign = value > 0 ? '+' : '';
  return `${sign}${value.toFixed(1)}%`;
}

export function buildFinalContractAnalysis(
  input: FinalContractAnalysisInput,
): FinalContractAnalysisResult {
  const lineItems = input.extractedItems.map((item) => {
    const hasQuantity =
      typeof item.quantity === 'number' && Number.isFinite(item.quantity) && item.quantity > 0;
    const hasMarketPrice =
      typeof item.marketPrice === 'number' && Number.isFinite(item.marketPrice) && item.marketPrice > 0;
    const contractLineAmount = hasQuantity ? item.unitPrice * item.quantity! : null;
    const marketLineAmount =
      hasQuantity && hasMarketPrice ? item.marketPrice! * item.quantity! : null;

    return {
      hasQuantity,
      hasMarketPrice,
      contractLineAmount,
      marketLineAmount,
      priceDeviation:
        typeof item.priceDeviation === 'number' && Number.isFinite(item.priceDeviation)
          ? item.priceDeviation
          : null,
    };
  });

  const hasAllQuantities =
    lineItems.length > 0 && lineItems.every((item) => item.hasQuantity);
  const itemsTotalAmount = hasAllQuantities
    ? round(
        lineItems.reduce(
          (sum, item) => sum + (item.contractLineAmount ?? 0),
          0,
        ),
      )
    : null;

  const coveredItems = lineItems.filter(
    (item) =>
      item.contractLineAmount != null &&
      item.marketLineAmount != null &&
      item.priceDeviation != null,
  );
  const coveredAmount =
    coveredItems.length > 0
      ? coveredItems.reduce((sum, item) => sum + (item.contractLineAmount ?? 0), 0)
      : 0;

  const coverageBase =
    typeof input.contractAmount === 'number' && Number.isFinite(input.contractAmount) && input.contractAmount > 0
      ? input.contractAmount
      : itemsTotalAmount;

  const marketCoveragePercent =
    coverageBase && coverageBase > 0
      ? round((coveredAmount / coverageBase) * 100, 1)
      : null;

  const weightedDeviationBase = coveredItems.reduce(
    (sum, item) => sum + (item.contractLineAmount ?? 0),
    0,
  );
  const averageDeviationPercent =
    weightedDeviationBase > 0
      ? round(
          (coveredItems.reduce(
            (sum, item) =>
              sum + (item.priceDeviation ?? 0) * (item.contractLineAmount ?? 0),
            0,
          ) /
            weightedDeviationBase) *
            100,
          1,
        )
      : null;

  let consistency: ConsistencyStatus = 'НЕДОСТАТНЬО ДАНИХ';
  if (
    typeof input.contractAmount === 'number' &&
    Number.isFinite(input.contractAmount) &&
    input.contractAmount >= 0 &&
    itemsTotalAmount != null
  ) {
    const diff = Math.abs(input.contractAmount - itemsTotalAmount);
    const allowedDiff = Math.max(
      AMOUNT_MATCH_TOLERANCE_ABSOLUTE,
      input.contractAmount * AMOUNT_MATCH_TOLERANCE_RATIO,
    );
    consistency = diff <= allowedDiff ? 'ТАК' : 'НІ';
  }

  let overallAssessment: OverallAssessment = 'НЕДОСТАТНЬО ДАНИХ';
  if (
    hasAllQuantities &&
    marketCoveragePercent != null &&
    averageDeviationPercent != null &&
    marketCoveragePercent >= MIN_MARKET_COVERAGE_PERCENT
  ) {
    if (averageDeviationPercent >= OVERPRICED_AVERAGE_DEVIATION_PERCENT) {
      overallAssessment = 'ПОТЕНЦІЙНО ЗАВИЩЕНО';
    } else if (averageDeviationPercent <= UNDERPRICED_AVERAGE_DEVIATION_PERCENT) {
      overallAssessment = 'ЗАНИЖЕНО';
    } else {
      overallAssessment = 'РИНКОВО';
    }
  }

  let overpricingSigns: OverpricingStatus = 'НЕДОСТАТНЬО ДАНИХ';
  if (overallAssessment !== 'НЕДОСТАТНЬО ДАНИХ' && consistency !== 'НІ') {
    overpricingSigns =
      overallAssessment === 'ПОТЕНЦІЙНО ЗАВИЩЕНО' &&
      (input.itemsAboveMarket ?? 0) > 0
        ? 'ТАК'
        : 'НІ';
  }

  const commentParts: string[] = [];

  if (itemsTotalAmount != null && input.contractAmount != null) {
    commentParts.push(
      `Сума позицій становить ${formatAmountForComment(itemsTotalAmount, input.currency ?? 'UAH')}, сума договору — ${formatAmountForComment(input.contractAmount, input.currency ?? 'UAH')}; узгодженість — ${consistency}.`,
    );
  } else {
    commentParts.push(
      'Повна звірка суми договору з позиціями неможлива через неповні дані по кількості або сумі договору.',
    );
  }

  if (marketCoveragePercent != null) {
    commentParts.push(
      `Ринковими даними покрито ${marketCoveragePercent.toFixed(1)}% суми договору або зіставного обсягу позицій.`,
    );
  } else {
    commentParts.push('Частку покриття ринковими даними визначити неможливо.');
  }

  if (averageDeviationPercent != null) {
    commentParts.push(
      `Середнє зважене відхилення становить ${formatPercentForComment(averageDeviationPercent)}.`,
    );
  } else {
    commentParts.push('Середній рівень відхилення визначити неможливо.');
  }

  if (
    typeof input.itemsAboveMarket === 'number' &&
    typeof input.totalItems === 'number' &&
    input.totalItems > 0
  ) {
    commentParts.push(
      `Позицій вище ринку понад 20%: ${input.itemsAboveMarket} з ${input.totalItems}.`,
    );
  }

  return {
    itemsTotalAmount,
    contractAmount:
      typeof input.contractAmount === 'number' && Number.isFinite(input.contractAmount)
        ? round(input.contractAmount)
        : null,
    consistency,
    averageDeviationPercent,
    marketCoveragePercent,
    overallAssessment,
    overpricingSigns,
    comment: commentParts.join(' '),
  };
}
