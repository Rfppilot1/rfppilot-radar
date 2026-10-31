/**
 * Market data types (Flight Deck Market Intelligence), shared by the collectors (connectors) and the store.
 *
 * Market collectors gather public award data (who won, for how much, until when) for Flight Deck's Market
 * Intelligence views. They are separate from the opportunity connectors: they never create notices or alerts,
 * and every record keeps the raw page it came from so any figure can be traced to its source and date.
 */
export type MarketSourceId = "usaspending" | "usaspending-detail" | "sam-awards" | "openfema-pa";

/** One raw response exactly as the source returned it, kept for audit and re-parsing. */
export interface MarketCapture {
  source: MarketSourceId;
  /** Request address with any key removed. */
  url: string;
  /** Request body for POST APIs, so the capture can be replayed. */
  request: unknown | null;
  retrievedAt: string;
  body: string;
  /**
   * Identity of the content for de-duplication, when the body carries volatile metadata (OpenFEMA stamps every
   * response with its run time). Defaults to a hash of the body.
   */
  contentKey?: string;
}

export interface MarketWindow {
  /** Records changed on or after this instant. */
  since: string;
  /** Records changed before this instant (default: now). */
  until?: string;
  /** Page to start at when resuming a window an earlier run could not finish. */
  offset?: number;
}

/** Where a run stopped inside its window, so the next run resumes there instead of starting over. */
export interface MarketCursor {
  since: string;
  until: string;
  offset: number;
}

export interface MarketRun<T> {
  source: MarketSourceId;
  records: T[];
  captures: MarketCapture[];
  rejected: { sourceRecordId: string | null; error: string }[];
  fetchedAt: string;
  window: { since: string; until: string };
  /** False when a page cap or result ceiling cut the window short; the next run starts from the same point. */
  complete: boolean;
  notes: string[];
  /** Set when the run stopped early (request budget, rate limit); the next run resumes from it. */
  cursor?: MarketCursor | null;
}

/** How an amount was measured. Figures are only ever added up within one type. */
export type AmountType =
  "estimate" | "bid_total" | "award_nte" | "award_fixed" | "contract_max_with_options" | "obligated" | "paid";

/** A federal contract award performed in a state, from USAspending (FPDS data). */
export interface FederalAward {
  /** USAspending's stable award key, e.g. CONT_AWD_47QFCA21F0058_4732_GS00Q14OADU117_4732. */
  key: string;
  awardId: string;
  recipientName: string;
  recipientUei: string | null;
  amount: number | null;
  amountType: AmountType;
  startDate: string | null;
  endDate: string | null;
  awardingAgency: string | null;
  awardingSubAgency: string | null;
  awardType: string | null;
  naics: string | null;
  naicsDescription: string | null;
  psc: string | null;
  pscDescription: string | null;
  popState: string | null;
  description: string | null;
  lastModified: string | null;
  sourceUrl: string;
  contentHash: string;
  /** Index into the run's captures of the page this record came from (not part of the content hash). */
  captureIndex?: number;
}

/** One FEMA Public Assistance project: who spent federal disaster money on what. No contractor names. */
export interface PaProject {
  /** disasterNumber-pwNumber-applicantId; FEMA's identity for a project worksheet. */
  key: string;
  disasterNumber: number;
  pwNumber: number;
  applicantId: string;
  state: string;
  county: string | null;
  countyCode: string | null;
  damageCategory: string;
  damageCategoryName: string | null;
  title: string | null;
  status: string | null;
  processStep: string | null;
  projectAmount: number | null;
  federalShareObligated: number | null;
  totalObligated: number | null;
  firstObligationDate: string | null;
  lastObligationDate: string | null;
  declarationDate: string | null;
  incidentType: string | null;
  lastRefresh: string | null;
  sourceUrl: string;
  contentHash: string;
  /** Index into the run's captures of the page this record came from (not part of the content hash). */
  captureIndex?: number;
}

export interface PaApplicant {
  /** disasterNumber-applicantId */
  key: string;
  disasterNumber: number;
  applicantId: string;
  name: string;
  state: string | null;
  city: string | null;
  lastRefresh: string | null;
  contentHash: string;
  captureIndex?: number;
}

/**
 * Competition and term details for a federal award, from USAspending's award page data (the latest contract
 * transaction). Adds what the search results lack: how many offers were received, how it was competed, the
 * solicitation number, the ceiling (base + all options) and the potential end date with options.
 */
export interface FederalAwardDetail {
  key: string;
  solicitationId: string | null;
  offersReceived: number | null;
  extentCompeted: string | null;
  extentCompetedName: string | null;
  setAside: string | null;
  setAsideName: string | null;
  pricingType: string | null;
  baseAndAllOptions: number | null;
  totalObligation: number | null;
  potentialEndDate: string | null;
  parentAwardKey: string | null;
  contentHash: string;
  captureIndex?: number;
}

/**
 * One federal contract action (an award or a modification) from SAM.gov's Contract Awards API, the system that
 * replaced FPDS in 2026. Transaction-level, so one contract can have many rows.
 */
export interface FederalAction {
  /** piid | modification number | referenced IDV piid */
  key: string;
  piid: string;
  modificationNumber: string | null;
  referencedIdvPiid: string | null;
  contractingDepartment: string | null;
  contractingOffice: string | null;
  awardeeName: string | null;
  awardeeUei: string | null;
  naics: string | null;
  psc: string | null;
  popState: string | null;
  actionObligation: number | null;
  totalObligation: number | null;
  baseAndAllOptions: number | null;
  dateSigned: string | null;
  currentCompletionDate: string | null;
  ultimateCompletionDate: string | null;
  offersReceived: number | null;
  extentCompeted: string | null;
  extentCompetedName: string | null;
  solicitationId: string | null;
  contentHash: string;
  captureIndex?: number;
}
