export interface ExtractedItem {
  itemName: string;
  unitPrice: number;
  quantity: number | null;
  unit: string | null;
}

export interface MarketPriceResult {
  itemName: string;
  marketPrice: number | null;
  marketPriceMin: number | null;
  marketPriceMax: number | null;
  source: string | null;
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
