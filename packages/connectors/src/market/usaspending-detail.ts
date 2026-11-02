import type { FederalAwardDetail, MarketRun } from "@radar/core";
import { z } from "zod";
import type { HttpClient } from "../http.js";
import { contentHash } from "../util.js";

/**
 * USAspending award page data: `GET https://api.usaspending.gov/api/v2/awards/<generated_unique_award_id>/`, no key.
 * One request per award, so it runs on awards that are new or changed since their details were last read, up to a
 * per-run cap. Verified Oct 31, 2026 (fixture usaspending-award-detail.2026-10-31.subset).
 *
 * This replaces the SAM.gov Contract Awards API for these fields: both come from FPDS, but SAM's API allows a
 * personal key 10 requests a day, shared with every other SAM call on that key.
 */
export const USASPENDING_AWARD = "https://api.usaspending.gov/api/v2/awards/";

const str = z.string().nullable().optional();
export const UsaspendingAwardDetail = z
  .object({
    generated_unique_award_id: z.string(),
    total_obligation: z.number().nullable().optional(),
    base_and_all_options: z.number().nullable().optional(),
    period_of_performance: z.object({ potential_end_date: str }).passthrough().nullable().optional(),
    parent_award: z.object({ generated_unique_award_id: str }).passthrough().nullable().optional(),
    latest_transaction_contract_data: z
      .object({
        solicitation_identifier: str,
        number_of_offers_received: z.union([z.string(), z.number()]).nullable().optional(),
        extent_competed: str,
        extent_competed_description: str,
        type_set_aside: str,
        type_set_aside_description: str,
        type_of_contract_pricing_description: str,
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

const clean = (s: string | null | undefined) => (s && s.trim() ? s.trim() : null);
const day = (s: string | null | undefined) => (s && /^\d{4}-\d{2}-\d{2}/.test(s) ? s.slice(0, 10) : null);

export function normalizeAwardDetail(raw: unknown): FederalAwardDetail {
  const r = UsaspendingAwardDetail.parse(raw);
  const t = r.latest_transaction_contract_data ?? {};
  const offers = t.number_of_offers_received;
  const n = offers === null || offers === undefined || offers === "" ? null : Number(offers);
  const d: Omit<FederalAwardDetail, "contentHash"> = {
    key: r.generated_unique_award_id,
    solicitationId: clean(t.solicitation_identifier),
    offersReceived: n !== null && Number.isInteger(n) && n >= 0 ? n : null,
    extentCompeted: clean(t.extent_competed),
    extentCompetedName: clean(t.extent_competed_description),
    setAside: clean(t.type_set_aside),
    setAsideName: clean(t.type_set_aside_description),
    pricingType: clean(t.type_of_contract_pricing_description),
    baseAndAllOptions: r.base_and_all_options ?? null,
    totalObligation: r.total_obligation ?? null,
    potentialEndDate: day(r.period_of_performance?.potential_end_date),
    parentAwardKey: clean(r.parent_award?.generated_unique_award_id),
  };
  return { ...d, contentHash: contentHash(d) };
}

export interface UsaspendingDetailOptions {
  http: HttpClient;
  now?: () => string;
}

export class UsaspendingDetailCollector {
  readonly id = "usaspending-detail" as const;
  constructor(private readonly opts: UsaspendingDetailOptions) {}

  /** Reads the award page data for each key. A 404 (award withdrawn) is noted, not a failure. */
  async fetchFor(keys: string[]): Promise<MarketRun<FederalAwardDetail>> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    const fetchedAt = now();
    const run: MarketRun<FederalAwardDetail> = {
      source: this.id,
      records: [],
      captures: [],
      rejected: [],
      fetchedAt,
      window: { since: fetchedAt, until: fetchedAt },
      complete: true,
      notes: [],
    };
    let missing = 0;
    for (const key of keys) {
      const url = `${USASPENDING_AWARD}${encodeURIComponent(key)}/`;
      let raw: string;
      try {
        raw = await this.opts.http.text(url, { headers: { accept: "application/json" } });
      } catch (err) {
        if ((err as { status?: number }).status === 404) {
          missing++;
          continue;
        }
        throw err;
      }
      run.captures.push({ source: this.id, url, request: null, retrievedAt: now(), body: raw });
      try {
        run.records.push({ ...normalizeAwardDetail(JSON.parse(raw)), captureIndex: run.captures.length - 1 });
      } catch (err) {
        run.rejected.push({ sourceRecordId: key, error: (err as Error).message.slice(0, 300) });
      }
    }
    if (missing) run.notes.push(`${missing} award(s) no longer on USAspending`);
    return run;
  }
}
