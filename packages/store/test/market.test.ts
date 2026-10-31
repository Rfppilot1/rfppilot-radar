import { gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import type { FederalAward, MarketCapture, PaApplicant, PaProject } from "@radar/core";
import { describe, expect, it } from "vitest";
import { MemoryMarketStore, PostgresMarketStore, migrate, type MarketStore } from "../src/index.js";

const NOW = "2026-10-31T15:00:00.000Z";
const LATER = "2026-11-01T15:00:00.000Z";

const award = (key: string, over: Partial<FederalAward> = {}): FederalAward => ({
  key,
  awardId: key,
  recipientName: "ACME LLC",
  recipientUei: "ABCDEF123456",
  amount: 125000,
  amountType: "obligated",
  startDate: "2025-01-01",
  endDate: "2027-06-30",
  awardingAgency: "Department of Homeland Security",
  awardingSubAgency: "Federal Emergency Management Agency",
  awardType: "DEFINITIVE CONTRACT",
  naics: "562111",
  naicsDescription: "SOLID WASTE COLLECTION",
  psc: "S205",
  pscDescription: null,
  popState: "FL",
  description: "Debris monitoring",
  lastModified: "2026-10-27T12:00:00Z",
  sourceUrl: `https://www.usaspending.gov/award/${key}`,
  contentHash: `h-${key}`,
  captureIndex: 0,
  ...over,
});

const project = (pw: number, over: Partial<PaProject> = {}): PaProject => ({
  key: `4844-${pw}-000-UGAGA-00`,
  disasterNumber: 4844,
  pwNumber: pw,
  applicantId: "000-UGAGA-00",
  state: "FL",
  county: "Statewide",
  countyCode: "11",
  damageCategory: "A",
  damageCategoryName: "Debris Removal",
  title: "Debris removal",
  status: "Eligible",
  processStep: "Obligated",
  projectAmount: 1000,
  federalShareObligated: 900,
  totalObligated: 900,
  firstObligationDate: "2025-06-12T00:00:00.000Z",
  lastObligationDate: "2025-08-21T00:00:00.000Z",
  declarationDate: "2024-11-05T00:00:00.000Z",
  incidentType: "Hurricane",
  lastRefresh: "2026-10-30T15:00:00.000Z",
  sourceUrl: "https://www.fema.gov/api/open/v2/PublicAssistanceFundedProjectsDetails",
  contentHash: `p-${pw}`,
  captureIndex: 0,
  ...over,
});

const applicant: PaApplicant = {
  key: "4844-000-UGAGA-00",
  disasterNumber: 4844,
  applicantId: "000-UGAGA-00",
  name: "Seminole Tribe of Florida",
  state: "Florida",
  city: "Hollywood",
  lastRefresh: null,
  contentHash: "a-1",
};

const cap = (body: string, contentKey?: string): MarketCapture => ({
  source: "usaspending",
  url: "https://api.usaspending.gov/api/v2/search/spending_by_award/",
  request: { page: 1 },
  retrievedAt: NOW,
  body,
  contentKey,
});

async function pg(): Promise<{ store: PostgresMarketStore; db: PGlite }> {
  const db = new PGlite();
  await migrate(db as never);
  return { store: new PostgresMarketStore(db as never), db };
}

describe.each([
  ["memory", async (): Promise<MarketStore> => new MemoryMarketStore()],
  ["postgres (PGlite)", async (): Promise<MarketStore> => (await pg()).store],
])("market store: %s", (_name, make) => {
  it("inserts, skips unchanged rows and updates changed ones", async () => {
    const store = await make();
    const [id] = await store.saveCaptures([cap('{"results":[]}')]);
    expect(await store.upsertFederalAwards([award("A1"), award("A2")], [id!], NOW)).toEqual({
      inserted: 2,
      updated: 0,
    });
    expect(await store.upsertFederalAwards([award("A1"), award("A2")], [id!], LATER)).toEqual({
      inserted: 0,
      updated: 0,
    });
    expect(
      await store.upsertFederalAwards(
        [award("A1", { amount: 200000, contentHash: "h-A1-v2" })],
        [id!],
        LATER,
      ),
    ).toEqual({ inserted: 0, updated: 1 });
    expect(await store.upsertPaProjects([project(1), project(2)], [id!], NOW)).toEqual({
      inserted: 2,
      updated: 0,
    });
    expect(await store.upsertPaApplicants([applicant], NOW)).toEqual({ inserted: 1, updated: 0 });
    expect(await store.upsertPaApplicants([applicant], LATER)).toEqual({ inserted: 0, updated: 0 });
  });

  it("stores identical captures once", async () => {
    const store = await make();
    const a = await store.saveCaptures([
      cap("same", "k1"),
      cap("different body, same rows", "k1"),
      cap("other"),
    ]);
    expect(a[0]).toBe(a[1]);
    expect(a[2]).not.toBe(a[0]);
  });

  it("resumes from the last complete, error-free window and reports the last success", async () => {
    const store = await make();
    const run = (until: string, complete: boolean, error: string | null) =>
      store.recordMarketRun({
        source: "openfema-pa",
        startedAt: until,
        finishedAt: until,
        windowSince: "2023-10-01T00:00:00.000Z",
        windowUntil: until,
        fetched: 1,
        inserted: 1,
        updated: 0,
        rejected: 0,
        captures: 1,
        complete,
        notes: [],
        error,
      });
    expect(await store.lastMarketWindowEnd("openfema-pa")).toBeNull();
    await run("2026-10-29T10:00:00.000Z", true, null);
    await run("2026-10-30T10:00:00.000Z", false, null);
    await run("2026-10-31T10:00:00.000Z", false, "HTTP 503");
    expect(await store.lastMarketWindowEnd("openfema-pa")).toBe("2026-10-29T10:00:00.000Z");
    expect(await store.lastMarketSuccessAt("openfema-pa")).toBe("2026-10-30T10:00:00.000Z");
    expect(await store.lastMarketWindowEnd("usaspending")).toBeNull();
  });
});

describe("market store: postgres details", () => {
  it("keeps the raw body compressed and links each record to its capture", async () => {
    const { store, db } = await pg();
    const [id] = await store.saveCaptures([cap('{"results":["raw"]}')]);
    await store.upsertFederalAwards([award("A1")], [id!], NOW);
    const c = (
      await db.query<{ body_gz: Uint8Array; bytes: number }>(`SELECT body_gz, bytes FROM market.captures`)
    ).rows[0]!;
    expect(gunzipSync(Buffer.from(c.body_gz)).toString("utf8")).toBe('{"results":["raw"]}');
    const r = (
      await db.query<{ capture_id: number; amount: string; end_date: unknown }>(
        `SELECT capture_id, amount, end_date FROM market.federal_awards WHERE award_key='A1'`,
      )
    ).rows[0]!;
    expect(Number(r.capture_id)).toBe(id);
    expect(Number(r.amount)).toBe(125000);
  });

  it("keeps market data in its own schema", async () => {
    const { db } = await pg();
    const tables = (
      await db.query<{ t: string }>(
        `SELECT table_name AS t FROM information_schema.tables WHERE table_schema='market' ORDER BY 1`,
      )
    ).rows.map((r) => r.t);
    expect(tables).toEqual(["captures", "federal_awards", "pa_applicants", "pa_projects", "runs"]);
  });
});
