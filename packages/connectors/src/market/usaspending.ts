import { z } from "zod";
import type { HttpClient } from "../http.js";
import { contentHash } from "../util.js";
import type { FederalAward, MarketCapture, MarketRun, MarketWindow } from "@radar/core";

/**
 * USAspending.gov award search (Treasury). Official, documented, no key: https://api.usaspending.gov.
 * Pulls federal contract awards (types A–D) performed in the configured states and NAICS codes, by the award's
 * last-modified date. Verified Oct 31, 2026 with live requests (see fixture usaspending-awards.2026-10-31).
 *
 * Search returns at most 10,000 rows per query, so windows are split by month and by state; a month that still
 * hits the ceiling is marked incomplete and reported rather than silently truncated.
 */
export const USASPENDING_SEARCH = "https://api.usaspending.gov/api/v2/search/spending_by_award/";
export const USASPENDING_AWARD_PAGE = "https://www.usaspending.gov/award/";
const PAGE_SIZE = 100;
const MAX_PAGES = 100; // 100 × 100 = the API's 10,000-row ceiling
/** Contract award types: BPA call, purchase order, delivery order, definitive contract. */
export const CONTRACT_TYPES = ["A", "B", "C", "D"];

export const USASPENDING_FIELDS = [
  "Award ID",
  "Recipient Name",
  "Recipient UEI",
  "Award Amount",
  "Description",
  "Start Date",
  "End Date",
  "Awarding Agency",
  "Awarding Sub Agency",
  "Contract Award Type",
  "NAICS",
  "PSC",
  "Place of Performance State Code",
  "Last Modified Date",
  "generated_internal_id",
];

const Coded = z.object({
  code: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

export const UsaspendingRow = z
  .object({
    "Award ID": z.string(),
    "Recipient Name": z.string().nullable().optional(),
    "Recipient UEI": z.string().nullable().optional(),
    "Award Amount": z.number().nullable().optional(),
    Description: z.string().nullable().optional(),
    "Start Date": z.string().nullable().optional(),
    "End Date": z.string().nullable().optional(),
    "Awarding Agency": z.string().nullable().optional(),
    "Awarding Sub Agency": z.string().nullable().optional(),
    "Contract Award Type": z.string().nullable().optional(),
    NAICS: z.union([Coded, z.string()]).nullable().optional(),
    PSC: z.union([Coded, z.string()]).nullable().optional(),
    "Place of Performance State Code": z.string().nullable().optional(),
    "Last Modified Date": z.string().nullable().optional(),
    generated_internal_id: z.string(),
  })
  .passthrough();

const Page = z
  .object({
    results: z.array(z.unknown()),
    page_metadata: z.object({ hasNext: z.boolean().optional() }).passthrough().optional(),
  })
  .passthrough();

const coded = (v: z.infer<typeof Coded> | string | null | undefined) =>
  typeof v === "string"
    ? { code: v, description: null }
    : { code: v?.code ?? null, description: v?.description ?? null };
const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);
const text = (s: string | null | undefined) => (s && s.trim() ? s.replace(/\s+/g, " ").trim() : null);

/** "2026-10-27 12:27:06" → ISO. The API states no time zone; it is stored as UTC (used for ordering only). */
function modified(s: string | null | undefined): string | null {
  if (!s) return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(s);
  return m ? `${m[1]}T${m[2]}Z` : s;
}

export function normalizeUsaspending(raw: unknown): FederalAward {
  const r = UsaspendingRow.parse(raw);
  const naics = coded(r.NAICS);
  const psc = coded(r.PSC);
  const award: Omit<FederalAward, "contentHash"> = {
    key: r.generated_internal_id,
    awardId: r["Award ID"],
    recipientName: text(r["Recipient Name"]) ?? "Unknown recipient",
    recipientUei: text(r["Recipient UEI"]),
    amount: typeof r["Award Amount"] === "number" ? r["Award Amount"] : null,
    // For contracts, USAspending's "Award Amount" is the obligated amount to date, not the ceiling.
    amountType: "obligated",
    startDate: day(r["Start Date"]),
    endDate: day(r["End Date"]),
    awardingAgency: text(r["Awarding Agency"]),
    awardingSubAgency: text(r["Awarding Sub Agency"]),
    awardType: text(r["Contract Award Type"]),
    naics: naics.code,
    naicsDescription: naics.description,
    psc: psc.code,
    pscDescription: psc.description,
    popState: text(r["Place of Performance State Code"]),
    description: text(r.Description)?.slice(0, 2000) ?? null,
    lastModified: modified(r["Last Modified Date"]),
    sourceUrl: `${USASPENDING_AWARD_PAGE}${encodeURIComponent(r.generated_internal_id)}`,
  };
  return { ...award, contentHash: contentHash(award) };
}

export interface UsaspendingOptions {
  http: HttpClient;
  states: string[];
  /** NAICS codes to pull; empty pulls every code (large). */
  naics: string[];
  now?: () => string;
}

/** Month boundaries [from, to) covering the window, as YYYY-MM-DD; the API takes whole days. */
export function monthSlices(since: string, until: string): { start: string; end: string }[] {
  const out: { start: string; end: string }[] = [];
  let cur = new Date(`${since.slice(0, 10)}T00:00:00Z`);
  const stop = new Date(`${until.slice(0, 10)}T00:00:00Z`);
  while (cur <= stop) {
    const next = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    const end = next > stop ? stop : new Date(next.getTime() - 86_400_000);
    out.push({ start: cur.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) });
    cur = next;
  }
  return out;
}

export class UsaspendingCollector {
  readonly id = "usaspending" as const;
  constructor(private readonly opts: UsaspendingOptions) {}

  async fetch(window: MarketWindow): Promise<MarketRun<FederalAward>> {
    const fetchedAt = (this.opts.now ?? (() => new Date().toISOString()))();
    const until = window.until ?? fetchedAt;
    const run: MarketRun<FederalAward> = {
      source: this.id,
      records: [],
      captures: [],
      rejected: [],
      fetchedAt,
      window: { since: window.since, until },
      complete: true,
      notes: [],
    };
    const seen = new Set<string>();
    for (const slice of monthSlices(window.since, until)) {
      for (const state of this.opts.states) {
        const filters: Record<string, unknown> = {
          award_type_codes: CONTRACT_TYPES,
          // "USA" (not "US"): the API silently returns nothing for "US".
          place_of_performance_locations: [{ country: "USA", state }],
          time_period: [{ start_date: slice.start, end_date: slice.end, date_type: "last_modified_date" }],
        };
        if (this.opts.naics.length) filters.naics_codes = { require: this.opts.naics };
        for (let page = 1; ; page++) {
          const body = {
            filters,
            fields: USASPENDING_FIELDS,
            page,
            limit: PAGE_SIZE,
            sort: "Award ID",
            order: "asc",
          };
          const raw = await this.opts.http.text(USASPENDING_SEARCH, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json" },
            body: JSON.stringify(body),
          });
          run.captures.push(capture(body, raw, this.opts.now?.() ?? new Date().toISOString()));
          const parsed = Page.parse(JSON.parse(raw));
          for (const row of parsed.results) {
            try {
              const a = { ...normalizeUsaspending(row), captureIndex: run.captures.length - 1 };
              if (seen.has(a.key)) continue;
              seen.add(a.key);
              run.records.push(a);
            } catch (err) {
              const id = (row as { generated_internal_id?: string } | null)?.generated_internal_id ?? null;
              run.rejected.push({ sourceRecordId: id, error: (err as Error).message.slice(0, 300) });
            }
          }
          if (!parsed.page_metadata?.hasNext) break;
          if (page >= MAX_PAGES) {
            run.complete = false;
            run.notes.push(`${state} ${slice.start}..${slice.end}: hit the 10,000-row search ceiling`);
            break;
          }
        }
      }
    }
    return run;
  }
}

function capture(request: unknown, body: string, retrievedAt: string): MarketCapture {
  return { source: "usaspending", url: USASPENDING_SEARCH, request, retrievedAt, body };
}
