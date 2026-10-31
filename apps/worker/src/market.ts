import type { FederalAward, FederalAwardDetail, MarketRun, MarketSourceId, MarketWindow } from "@radar/core";
import type { PaRecords } from "@radar/connectors";
import { HttpError } from "@radar/connectors";
import type { MarketStore } from "@radar/store";

type Log = (e: Record<string, unknown>) => void;

/** A market collector, as the job sees it: fetch a window, get records and raw captures back. */
export type MarketJob =
  | {
      id: "usaspending" | "openfema-pa";
      fetch(window: MarketWindow): Promise<MarketRun<FederalAward> | MarketRun<PaRecords>>;
    }
  | { id: "usaspending-detail"; fetchFor(keys: string[]): Promise<MarketRun<FederalAwardDetail>> };

export interface MarketResult {
  source: MarketSourceId;
  ok: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  rejected: number;
  complete: boolean;
  window: { since: string; until: string } | null;
  error: string | null;
}

/** Days re-read at the start of each window, so late-arriving updates on the boundary are not missed. */
export const OVERLAP_DAYS = 3;
/** A source with no successful run for this long is reported. */
export const MARKET_STALE_AFTER_MS = 4 * 86_400_000;

/**
 * Collects public market data. Each source picks up where its last complete run ended (minus a short overlap),
 * or at `backfillSince` the first time. One source failing never stops the others; each run is recorded.
 * Nothing here touches opportunities, matches or digests.
 */
export async function collectMarket(
  store: MarketStore,
  jobs: MarketJob[],
  o: { log: Log; now: string; backfillSince: string; since?: string; detailMax?: number },
): Promise<MarketResult[]> {
  const out: MarketResult[] = [];
  for (const job of jobs) {
    const started = new Date().toISOString();
    let window: { since: string; until: string } | null = null;
    try {
      if (job.id === "usaspending-detail") {
        // Details for awards that are new or changed since their details were last read, capped per run; the rest
        // are picked up by later runs. Runs after the award search so today's changes are included.
        const keys = await store.awardsNeedingDetail(o.detailMax ?? 1000, o.now);
        const run = await job.fetchFor(keys);
        const ids = await store.saveCaptures(run.captures);
        const saved = await store.saveAwardDetails(run.records, ids, o.now);
        const remaining = (await store.awardsNeedingDetail(1, o.now)).length > 0;
        if (remaining) run.notes.push("more awards are waiting for details; the next run continues");
        await store.recordMarketRun({
          source: job.id,
          startedAt: started,
          finishedAt: new Date().toISOString(),
          windowSince: null,
          windowUntil: null,
          fetched: run.records.length,
          inserted: 0,
          updated: saved,
          rejected: run.rejected.length,
          captures: run.captures.length,
          complete: run.complete,
          notes: run.notes,
          error: null,
        });
        const res: MarketResult = {
          source: job.id,
          ok: true,
          fetched: run.records.length,
          inserted: 0,
          updated: saved,
          rejected: run.rejected.length,
          complete: run.complete,
          window: null,
          error: null,
        };
        out.push(res);
        o.log({ event: "market", ...res, requested: keys.length, notes: run.notes });
        continue;
      }
      const last = await store.lastMarketWindowEnd(job.id);
      const since =
        o.since ??
        (last ? new Date(Date.parse(last) - OVERLAP_DAYS * 86_400_000).toISOString() : o.backfillSince);
      window = { since, until: o.now };
      o.log({ event: "market_start", source: job.id, ...window });
      const run = await job.fetch(window);
      const ids = await store.saveCaptures(run.captures);
      let fetched = 0;
      let inserted = 0;
      let updated = 0;
      if (job.id === "usaspending") {
        const awards = run.records as FederalAward[];
        fetched = awards.length;
        ({ inserted, updated } = await store.upsertFederalAwards(awards, ids, o.now));
      } else {
        for (const r of run.records as PaRecords[]) {
          fetched += r.projects.length + r.applicants.length;
          const p = await store.upsertPaProjects(r.projects, ids, o.now);
          const a = await store.upsertPaApplicants(r.applicants, o.now);
          inserted += p.inserted + a.inserted;
          updated += p.updated + a.updated;
        }
      }
      await store.recordMarketRun({
        source: job.id,
        startedAt: started,
        finishedAt: new Date().toISOString(),
        windowSince: window.since,
        windowUntil: window.until,
        fetched,
        inserted,
        updated,
        rejected: run.rejected.length,
        captures: run.captures.length,
        complete: run.complete,
        notes: run.notes,
        error: null,
      });
      const res: MarketResult = {
        source: job.id,
        ok: true,
        fetched,
        inserted,
        updated,
        rejected: run.rejected.length,
        complete: run.complete,
        window,
        error: null,
      };
      out.push(res);
      o.log({ event: "market", ...res, notes: run.notes, rejectedSample: run.rejected.slice(0, 3) });
    } catch (err) {
      const error = describe(err);
      await store
        .recordMarketRun({
          source: job.id,
          startedAt: started,
          finishedAt: new Date().toISOString(),
          windowSince: window?.since ?? null,
          windowUntil: window?.until ?? null,
          fetched: 0,
          inserted: 0,
          updated: 0,
          rejected: 0,
          captures: 0,
          complete: false,
          notes: [],
          error,
        })
        .catch((e) => o.log({ event: "market_record_failed", source: job.id, error: (e as Error).message }));
      out.push({
        source: job.id,
        ok: false,
        fetched: 0,
        inserted: 0,
        updated: 0,
        rejected: 0,
        complete: false,
        window,
        error,
      });
      o.log({ event: "market_failed", source: job.id, error });
    }
  }
  return out;
}

/** Plain-language error; an expired or rejected API key says so (SAM.gov keys expire every 90 days). */
function describe(err: unknown): string {
  if (err instanceof HttpError && (err.status === 401 || err.status === 403))
    return `${err.message}: the API key was rejected (expired or revoked?)`;
  return ((err as Error)?.message ?? String(err)).slice(0, 500);
}

/** Problems worth an operator email: failures, rejected rows, and sources gone stale. */
export async function marketProblems(
  store: MarketStore,
  results: MarketResult[],
  now: string,
): Promise<string[]> {
  const problems: string[] = [];
  for (const r of results) {
    if (!r.ok) problems.push(`market ${r.source}: failed (${r.error})`);
    else if (r.rejected >= 5 && r.rejected > (r.fetched + r.rejected) * 0.25)
      problems.push(`market ${r.source}: ${r.rejected} records could not be read`);
    if (r.ok && !r.complete)
      problems.push(`market ${r.source}: some records were not read (see the run notes)`);
    const last = await store.lastMarketSuccessAt(r.source).catch(() => null);
    if (last && Date.parse(now) - Date.parse(last) > MARKET_STALE_AFTER_MS)
      problems.push(`market ${r.source}: no successful run since ${last.slice(0, 10)}`);
  }
  return problems;
}
