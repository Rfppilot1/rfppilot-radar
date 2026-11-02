import { HttpError } from "@radar/connectors";
import type { FederalAward, MarketRun, MarketWindow, StateContract } from "@radar/core";
import { MemoryMarketStore } from "@radar/store";
import { describe, expect, it } from "vitest";
import { collectMarket, marketProblems, type MarketJob } from "../src/market.js";

const NOW = "2026-10-31T15:00:00.000Z";
const quiet = () => {};

const award = (key: string): FederalAward => ({
  key,
  awardId: key,
  recipientName: "ACME LLC",
  recipientUei: null,
  amount: 1000,
  amountType: "obligated",
  startDate: null,
  endDate: "2027-06-30",
  awardingAgency: null,
  awardingSubAgency: null,
  awardType: null,
  naics: "541511",
  naicsDescription: null,
  psc: null,
  pscDescription: null,
  popState: "TX",
  description: null,
  lastModified: null,
  sourceUrl: `https://www.usaspending.gov/award/${key}`,
  contentHash: key,
  captureIndex: 0,
});

function job(records: FederalAward[], windows: MarketWindow[] = [], fail?: Error): MarketJob {
  return {
    id: "usaspending",
    async fetch(w) {
      windows.push(w);
      if (fail) throw fail;
      return {
        source: "usaspending",
        records,
        captures: [{ source: "usaspending", url: "u", request: null, retrievedAt: NOW, body: "{}" }],
        rejected: [],
        fetchedAt: NOW,
        window: { since: w.since, until: w.until ?? NOW },
        complete: true,
        notes: [],
      } satisfies MarketRun<FederalAward>;
    },
  };
}

describe("award detail job", () => {
  it("reads details for queued awards up to the cap and notes the backlog", async () => {
    const store = new MemoryMarketStore();
    await store.upsertFederalAwards([award("A"), award("B"), award("C")], [], NOW);
    const asked: string[][] = [];
    const detailJob: MarketJob = {
      id: "usaspending-detail",
      async fetchFor(keys) {
        asked.push(keys);
        return {
          source: "usaspending-detail",
          records: keys.map((key) => ({
            key,
            solicitationId: null,
            offersReceived: 2,
            extentCompeted: null,
            extentCompetedName: null,
            setAside: null,
            setAsideName: null,
            pricingType: null,
            baseAndAllOptions: null,
            totalObligation: null,
            potentialEndDate: null,
            parentAwardKey: null,
            contentHash: key,
          })),
          captures: [],
          rejected: [],
          fetchedAt: NOW,
          window: { since: NOW, until: NOW },
          complete: true,
          notes: [],
        };
      },
    };
    const [r] = await collectMarket(store, [detailJob], {
      log: quiet,
      now: NOW,
      backfillSince: NOW,
      detailMax: 2,
    });
    expect(asked[0]).toHaveLength(2);
    expect(r).toMatchObject({ ok: true, fetched: 2, updated: 2 });
    expect(store.runs[0]!.notes).toEqual(["more awards are waiting for details; the next run continues"]);
    await collectMarket(store, [detailJob], { log: quiet, now: NOW, backfillSince: NOW, detailMax: 2 });
    expect(asked[1]).toHaveLength(1);
    expect(store.runs[1]!.notes).toEqual([]);
  });
});

describe("resuming a window", () => {
  it("finishes a window from its cursor before moving on, and does not alert for a planned stop", async () => {
    const store = new MemoryMarketStore();
    const seen: MarketWindow[] = [];
    const sam = (stopAt: number | null): MarketJob => ({
      id: "sam-awards",
      async fetch(w) {
        seen.push(w);
        return {
          source: "sam-awards",
          records: [],
          captures: [],
          rejected: [],
          fetchedAt: NOW,
          window: { since: w.since, until: w.until ?? NOW },
          complete: stopAt === null,
          notes: [],
          cursor: stopAt === null ? null : { since: w.since, until: w.until ?? NOW, offset: stopAt },
        };
      },
    });
    const first = await collectMarket(store, [sam(2)], {
      log: quiet,
      now: NOW,
      backfillSince: "2023-10-01T00:00:00.000Z",
      backfillSinceFor: { "sam-awards": "2026-10-01T00:00:00.000Z" },
    });
    expect(seen[0]!.since).toBe("2026-10-01T00:00:00.000Z");
    expect(await marketProblems(store, first, NOW)).toEqual([]);
    await collectMarket(store, [sam(null)], {
      log: quiet,
      now: "2026-11-01T15:00:00.000Z",
      backfillSince: "2026-10-01T00:00:00.000Z",
    });
    expect(seen[1]).toEqual({ since: "2026-10-01T00:00:00.000Z", until: NOW, offset: 2 });
    await collectMarket(store, [sam(null)], {
      log: quiet,
      now: "2026-11-02T15:00:00.000Z",
      backfillSince: "2026-10-01T00:00:00.000Z",
    });
    expect(seen[2]).toEqual({ since: "2026-10-28T15:00:00.000Z", until: "2026-11-02T15:00:00.000Z" });
  });
});

describe("market collection job", () => {
  it("backfills the first time, then continues from the last window minus a 3-day overlap", async () => {
    const store = new MemoryMarketStore();
    const windows: MarketWindow[] = [];
    const first = await collectMarket(store, [job([award("A"), award("B")], windows)], {
      log: quiet,
      now: NOW,
      backfillSince: "2023-10-01T00:00:00.000Z",
    });
    expect(first[0]).toMatchObject({ ok: true, fetched: 2, inserted: 2, updated: 0 });
    expect(windows[0]).toEqual({ since: "2023-10-01T00:00:00.000Z", until: NOW });
    await collectMarket(store, [job([award("A")], windows)], {
      log: quiet,
      now: "2026-11-01T15:00:00.000Z",
      backfillSince: "2023-10-01T00:00:00.000Z",
    });
    expect(windows[1]!.since).toBe("2026-10-28T15:00:00.000Z");
    expect(store.awards.size).toBe(2);
    expect(store.runs).toHaveLength(2);
  });

  it("records a failed source, keeps going, and names a rejected API key", async () => {
    const store = new MemoryMarketStore();
    const results = await collectMarket(
      store,
      [job([], [], new HttpError(403, "https://api.sam.gov/x?api_key=secret", "")), job([award("A")])],
      { log: quiet, now: NOW, backfillSince: "2026-10-01T00:00:00.000Z" },
    );
    expect(results[0]).toMatchObject({ ok: false });
    expect(results[0]!.error).toMatch(/API key was rejected/);
    expect(results[0]!.error).not.toContain("secret");
    expect(results[1]).toMatchObject({ ok: true, inserted: 1 });
    expect(store.runs[0]!.error).toMatch(/HTTP 403/);
    // A failed run does not move the resume point.
    expect(await store.lastMarketWindowEnd("usaspending")).toBe(NOW);
  });

  it("reports failures, incomplete windows and sources with no recent success", async () => {
    const store = new MemoryMarketStore();
    await store.recordMarketRun({
      source: "openfema-pa",
      startedAt: "2026-10-20T10:00:00.000Z",
      finishedAt: "2026-10-20T10:00:00.000Z",
      windowSince: null,
      windowUntil: "2026-10-20T10:00:00.000Z",
      fetched: 1,
      inserted: 1,
      updated: 0,
      rejected: 0,
      captures: 1,
      complete: true,
      notes: [],
      error: null,
    });
    const problems = await marketProblems(
      store,
      [
        {
          source: "usaspending",
          ok: true,
          fetched: 10,
          inserted: 0,
          updated: 0,
          rejected: 0,
          complete: false,
          window: null,
          error: null,
        },
        {
          source: "openfema-pa",
          ok: false,
          fetched: 0,
          inserted: 0,
          updated: 0,
          rejected: 0,
          complete: false,
          window: null,
          error: "HTTP 500",
        },
      ],
      NOW,
    );
    expect(problems).toEqual([
      "market usaspending: some records were not read (see the run notes)",
      "market openfema-pa: failed (HTTP 500)",
      "market openfema-pa: no successful run since 2026-10-20",
    ]);
  });
});

describe("weekly sources", () => {
  const facts = (calls: string[]): MarketJob => ({
    id: "fl-facts",
    minIntervalDays: 7,
    async fetch(w) {
      calls.push(w.until ?? "");
      return {
        source: "fl-facts",
        records: [{ key: "FL|A|T|1", contentHash: "x", captureIndex: 0 } as StateContract],
        captures: [{ source: "fl-facts", url: "u", request: null, retrievedAt: NOW, body: "csv" }],
        rejected: [],
        fetchedAt: NOW,
        window: { since: w.since, until: w.until ?? NOW },
        complete: true,
        notes: [],
      } satisfies MarketRun<StateContract>;
    },
  });
  const at = (day: string) => ({
    log: quiet,
    now: `${day}T11:15:00.000Z`,
    backfillSince: "2023-10-01T00:00:00.000Z",
  });

  it("runs the first time, skips until the interval has passed, then runs again", async () => {
    const store = new MemoryMarketStore();
    const calls: string[] = [];
    const logs: Record<string, unknown>[] = [];
    // The memory store stamps finishedAt with the wall clock; pin it to the run day.
    const record = store.recordMarketRun.bind(store);
    let day = "2026-11-02";
    store.recordMarketRun = (r) => record({ ...r, finishedAt: `${day}T11:20:00.000Z` });
    expect(await collectMarket(store, [facts(calls)], at(day))).toHaveLength(1);
    expect(store.stateContracts.size).toBe(1);
    day = "2026-11-05";
    expect(await collectMarket(store, [facts(calls)], { ...at(day), log: (e) => logs.push(e) })).toEqual([]);
    expect(logs[0]).toMatchObject({ event: "market_skipped", source: "fl-facts" });
    day = "2026-11-09";
    expect(await collectMarket(store, [facts(calls)], at(day))).toHaveLength(1);
    expect(calls).toHaveLength(2);
    // An explicit --since always runs.
    expect(
      await collectMarket(store, [facts(calls)], { ...at(day), since: "2025-01-01T00:00:00.000Z" }),
    ).toHaveLength(1);
  });
});
