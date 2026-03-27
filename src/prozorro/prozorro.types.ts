/** Types for Prozorro public API v2.5 responses */

export interface ProzorroValue {
  amount?: string | number;
  currency?: string;
  valueAddedTaxIncluded?: boolean;
  amountNet?: string | number;
}

export interface ProzorroIdentifier {
  id?: string;
  legalName?: string;
  scheme?: string;
}

export interface ProzorroAddress {
  region?: string;
  locality?: string;
  streetAddress?: string;
  postalCode?: string;
  countryName?: string;
}

export interface ProzorroProcuringEntity {
  name?: string;
  identifier?: ProzorroIdentifier;
  address?: ProzorroAddress;
}

export interface ProzorroPeriod {
  startDate?: string;
  endDate?: string;
}

export interface ProzorroClassification {
  id?: string;
  description?: string;
  scheme?: string;
}

export interface ProzorroUnit {
  name?: string;
  code?: string;
}

export interface ProzorroItem {
  id: string;
  description?: string;
  quantity?: number | string;
  unit?: ProzorroUnit;
  classification?: ProzorroClassification;
  deliveryAddress?: ProzorroAddress;
}

export interface ProzorroSupplier {
  name?: string;
  identifier?: ProzorroIdentifier;
}

export interface ProzorroComplaint {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  type?: string;
  dateSubmitted?: string;
  complaintID?: string;
  author?: {
    name?: string;
    identifier?: ProzorroIdentifier;
  };
}

export interface ProzorroAward {
  id: string;
  status?: string;
  complaints?: ProzorroComplaint[];
}

export interface ProzorroBid {
  id: string;
  date?: string;
  status?: string;
  value?: ProzorroValue;
  tenderers?: ProzorroSupplier[];
}

export interface ProzorroLot {
  id: string;
  title?: string;
  description?: string;
  status?: string;
  value?: ProzorroValue;
}

export interface ProzorroContractRef {
  id: string;
}

export interface ProzorroTenderDetails {
  id: string;
  tenderID?: string;
  title?: string;
  description?: string;
  status?: string;
  value?: ProzorroValue;
  dateModified?: string;
  dateCreated?: string;
  procuringEntity?: ProzorroProcuringEntity;
  tenderPeriod?: ProzorroPeriod;
  enquiryPeriod?: ProzorroPeriod;
  auctionPeriod?: ProzorroPeriod;
  awardPeriod?: ProzorroPeriod;
  mainProcurementCategory?: string;
  procurementMethod?: string;
  procurementMethodType?: string;
  lots?: ProzorroLot[];
  bids?: ProzorroBid[];
  complaints?: ProzorroComplaint[];
  awards?: ProzorroAward[];
  contracts?: ProzorroContractRef[];
}

export interface ProzorroContractDetails {
  id: string;
  contractID?: string;
  contractNumber?: string;
  description?: string;
  status?: string;
  value?: ProzorroValue;
  amount?: string | number;
  currency?: string;
  valueAddedTaxIncluded?: boolean;
  amountNet?: string | number;
  dateSigned?: string;
  date?: string;
  dateModified?: string;
  dateCreated?: string;
  period?: ProzorroPeriod;
  suppliers?: ProzorroSupplier[];
  items?: ProzorroItem[];
}

/** Tender list item from /tenders endpoint */
export interface ProzorroTenderListItem {
  id: string;
  dateModified?: string;
}

/** Response from /tenders endpoint */
export interface ProzorroTendersPageResponse {
  data: ProzorroTenderListItem[];
  next_page?: {
    offset?: string;
  };
}
