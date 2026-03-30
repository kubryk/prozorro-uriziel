export interface ExtractedItem {
  itemName: string;
  unitPrice: number;
  quantity: number | null;
  unit: string | null;
}

export interface MarketSearchItem {
  itemName: string;
  unit: string | null;
  quantity?: number | null;
}

export interface ContractItemReference {
  itemName: string;
  quantity: number | null;
  unit: string | null;
  classificationDescription?: string | null;
}

export interface MarketPriceResult {
  itemName: string;
  marketPrice: number | null;
  marketPriceMin: number | null;
  marketPriceMax: number | null;
  source: string | null;
  pricingUnit?: string | null;
  unitsPerPackage?: number | null;
  normalizedToContractUnit?: boolean | null;
}

export interface AnalysisJobData {
  analysisId: string;
}

export interface TenderAnalysisRequest {
  tenderId: string;
  chatId: string;
  messageId?: number;
}

export interface BulkAnalysisRequest {
  tenderIds: string[];
  chatId: string;
}

export interface SkippedAnalysisContract {
  tenderId: string;
  contractId: string;
  contractID?: string | null;
  contractNumber?: string | null;
  reason: string;
}

export interface StartedAnalysisContract {
  tenderId: string;
  contractId: string;
  contractID?: string | null;
  contractNumber?: string | null;
  state: 'QUEUED' | 'IN_PROGRESS';
}

export interface TriggerTenderAnalysisResult {
  count: number;
  analysisIds: string[];
  startedContracts: StartedAnalysisContract[];
  skippedContracts: SkippedAnalysisContract[];
}

export interface TriggerBulkAnalysisResult {
  totalCount: number;
  analysisIds: string[];
  skippedContracts: SkippedAnalysisContract[];
  startedTenderIds: string[];
}
