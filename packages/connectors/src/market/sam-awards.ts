import type { FederalAction, MarketRun, MarketWindow } from "@radar/core";
import { HttpError, type HttpClient } from "../http.js";
import { contentHash } from "../util.js";

/**
 * SAM.gov Contract Awards API (GSA), the replacement for FPDS: https://open.gsa.gov/api/contract-awards/.
 * Needs the SAM.gov public API key (SAM_API_KEY, the same key the opportunity connector uses).
 *
 * Request budget: a personal key without a SAM.gov role gets 10 requests a day across every SAM API, shared with
 * Radar's opportunity pull and any other tool on the key; with a role it gets 1,000. Every run is capped at
 * `maxRequests` (RADAR_SAM_AWARDS_MAX_REQUESTS, default 2) and stops early on 429. A window it could not finish is
 * marked incomplete, so the next run starts from the same point.
 *
 * Built from GSA's documentation (parameters and response paths); the first live run on staging confirms the
 * response shape. Unknown shapes are rejected per record and reported, never guessed.
 */
export const SAM_AWARDS_SEARCH = "https://api.sam.gov/contract-awards/v1/search";
const PAGE_SIZE = 100;

const mmddyyyy = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;
};

/** Query string in the form GSA documents: brackets, commas, slashes and `~` (OR) left as written. */
export function samAwardsQuery(params: Record<string, string>): string {
  return Object.entries(params)
    .map(
      ([k, v]) =>
        `${k}=${encodeURIComponent(v).replace(/%5B/g, "[").replace(/%5D/g, "]").replace(/%2C/g, ",").replace(/%2F/g, "/").replace(/%7E/g, "~")}`,
    )
    .join("&");
}

type Obj = Record<string, unknown>;
const at = (o: unknown, path: string): unknown =>
  path
    .split(".")
    .reduce<unknown>((cur, k) => (cur && typeof cur === "object" ? (cur as Obj)[k] : undefined), o);
const str = (v: unknown): string | null => {
  if (Array.isArray(v)) return str(v[0]);
  if (typeof v === "number") return String(v);
  return typeof v === "string" && v.trim() ? v.trim() : null;
};
const num = (v: unknown): number | null => {
  const n =
    typeof v === "number" ? v : typeof v === "string" && v.trim() ? Number(v.replace(/[$,]/g, "")) : NaN;
  return Number.isFinite(n) ? n : null;
};
const day = (v: unknown) => {
  const s = str(v);
  if (!s) return null;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  if (iso) return iso[1]!;
  const us = /^(\d{2})\/(\d{2})\/(\d{4})/.exec(s);
  return us ? `${us[3]}-${us[1]}-${us[2]}` : null;
};
/** A code that may be a plain value, an object with `code`, or an array of either. */
const code = (v: unknown): string | null => {
  const first = Array.isArray(v) ? v[0] : v;
  return first && typeof first === "object" ? str((first as Obj).code) : str(first);
};

export function normalizeSamAward(raw: unknown): FederalAction {
  const piid = str(at(raw, "contractId.piid"));
  if (!piid) throw new Error("record has no contractId.piid");
  const mod = str(at(raw, "contractId.modificationNumber"));
  const idv = str(at(raw, "contractId.referencedIDVPiid")) ?? str(at(raw, "contractId.referencedIdvPiid"));
  const a: Omit<FederalAction, "contentHash"> = {
    key: [piid, mod ?? "0", idv ?? ""].join("|"),
    piid,
    modificationNumber: mod,
    referencedIdvPiid: idv,
    contractingDepartment: str(
      at(raw, "coreData.federalOrganization.contractingInformation.contractingDepartment.name"),
    ),
    contractingOffice: str(
      at(raw, "coreData.federalOrganization.contractingInformation.contractingOffice.name"),
    ),
    awardeeName: str(at(raw, "awardDetails.awardeeData.awardeeHeader.awardeeName")),
    awardeeUei: str(at(raw, "awardDetails.awardeeData.awardeeUEIInformation.uniqueEntityId")),
    naics: code(at(raw, "coreData.productOrServiceInformation.principalNaics")),
    psc: code(at(raw, "coreData.productOrServiceInformation.productOrService")),
    popState: code(at(raw, "coreData.principalPlaceOfPerformance.state")),
    actionObligation: num(at(raw, "awardDetails.dollars.actionObligation")),
    totalObligation: num(at(raw, "awardDetails.totalContractDollars.totalActionObligation")),
    baseAndAllOptions: num(at(raw, "awardDetails.dollars.baseAndAllOptionsValue")),
    dateSigned: day(at(raw, "awardDetails.dates.dateSigned")),
    currentCompletionDate: day(at(raw, "awardDetails.dates.currentCompletionDate")),
    ultimateCompletionDate: day(at(raw, "awardDetails.dates.ultimateCompletionDate")),
    offersReceived: num(at(raw, "awardDetails.competitionInformation.numberOfOffersReceived")),
    extentCompeted: code(at(raw, "coreData.competitionInformation.extentCompeted")),
    extentCompetedName: str(at(raw, "coreData.competitionInformation.extentCompeted.name")),
    solicitationId: str(at(raw, "coreData.solicitationId")),
  };
  return { ...a, contentHash: contentHash(a) };
}

export interface SamAwardsOptions {
  http: HttpClient;
  apiKey: string;
  states: string[];
  naics: string[];
  /** Most requests one run may make (the key's daily quota is shared). Default 2. */
  maxRequests?: number;
  now?: () => string;
}

export class SamAwardsCollector {
  readonly id = "sam-awards" as const;
  constructor(private readonly opts: SamAwardsOptions) {
    if (!opts.apiKey) throw new Error("SAM_API_KEY is required for SAM.gov contract awards");
  }

  async fetch(window: MarketWindow): Promise<MarketRun<FederalAction>> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    const fetchedAt = now();
    const until = window.until ?? fetchedAt;
    const max = this.opts.maxRequests ?? 2;
    const run: MarketRun<FederalAction> = {
      source: this.id,
      records: [],
      captures: [],
      rejected: [],
      fetchedAt,
      window: { since: window.since, until },
      complete: true,
      notes: [],
    };
    const params: Record<string, string> = {
      lastModifiedDate: `[${mmddyyyy(window.since)},${mmddyyyy(until)}]`,
      placeOfPerformStateCode: this.opts.states.join("~"),
      limit: String(PAGE_SIZE),
    };
    if (this.opts.naics.length) params.naicsCode = this.opts.naics.slice(0, 100).join("~");
    const seen = new Set<string>();
    let requests = 0;
    // GSA documents `offset` as the page index.
    for (let page = window.offset ?? 0; ; page++) {
      if (requests >= max) {
        run.complete = false;
        run.cursor = { since: window.since, until, offset: page };
        run.notes.push(`stopped at the ${max}-request budget at page ${page}; the next run resumes there`);
        break;
      }
      const q = samAwardsQuery({ ...params, offset: String(page) });
      const shown = `${SAM_AWARDS_SEARCH}?${q}`;
      let raw: string;
      try {
        requests++;
        raw = await this.opts.http.text(`${shown}&api_key=${encodeURIComponent(this.opts.apiKey)}`, {
          headers: { accept: "application/json" },
        });
      } catch (err) {
        if (err instanceof HttpError && err.status === 429) {
          run.complete = false;
          run.cursor = { since: window.since, until, offset: page };
          run.notes.push(`SAM.gov daily request limit reached at page ${page}; the next run resumes there`);
          break;
        }
        throw err;
      }
      run.captures.push({ source: this.id, url: shown, request: null, retrievedAt: now(), body: raw });
      const body = JSON.parse(raw) as { totalRecords?: number; awardSummary?: unknown[] };
      const rows = Array.isArray(body.awardSummary) ? body.awardSummary : [];
      let fresh = 0;
      for (const row of rows) {
        try {
          const a = { ...normalizeSamAward(row), captureIndex: run.captures.length - 1 };
          if (seen.has(a.key)) continue;
          seen.add(a.key);
          fresh++;
          run.records.push(a);
        } catch (err) {
          run.rejected.push({ sourceRecordId: null, error: (err as Error).message.slice(0, 300) });
        }
      }
      if (rows.length < PAGE_SIZE) break;
      if (fresh === 0) {
        // A full page of records already seen means `offset` is not a page index; stop rather than loop.
        run.complete = false;
        run.notes.push("a page repeated earlier records; paging stopped (check the offset convention)");
        break;
      }
      if (typeof body.totalRecords === "number" && (page + 1) * PAGE_SIZE >= body.totalRecords) break;
    }
    return run;
  }
}
