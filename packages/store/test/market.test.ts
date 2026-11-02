import { gunzipSync } from "node:zlib";
import { PGlite } from "@electric-sql/pglite";
import type {
  FederalAward,
  FederalAwardDetail,
  MarketCapture,
  PaApplicant,
  PaProject,
  StateContract,
} from "@radar/core";
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

const contract = (id: string, over: Partial<StateContract> = {}): StateContract => ({
  key: `FL|EXECUTIVE OFFICE OF THE GOVERNOR|Memorandum of Agreement|${id}`,
  state: "FL",
  agency: "EXECUTIVE OFFICE OF THE GOVERNOR",
  vendor: "GARNER ENVIRONMENTAL SERVICES, INC.",
  type: "Memorandum of Agreement",
  contractId: id,
  poNumber: null,
  grantAwardId: null,
  flairContractId: id,
  title: "Garner00394",
  shortTitle: "PO-010766",
  status: "Active",
  originalAmount: 1751680.15,
  totalAmount: 1751680.15,
  amountType: "award_fixed",
  commodityCode: "93131800",
  commodityDescription: "Disaster preparedness and relief",
  procurementMethod: "Emergency procurement per Executive Order [s. 252.36(2), F.S.]",
  stateTermContractId: null,
  agencyReference: id,
  serviceArea: null,
  recipientType: "FOR PROFIT ORGANIZATION INCLUDES SOLE PROPRIETOR",
  beginDate: "2025-10-30",
  originalEndDate: null,
  newEndDate: null,
  executedDate: "2025-09-22",
  cfda: null,
  csfa: null,
  sourceUrl: "https://facts.fldfs.com/Search/ContractSearch.aspx",
  contentHash: `c-${id}`,
  captureIndex: 0,
  ...over,
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

  it("upserts state contracts by key and content", async () => {
    const store = await make();
    const [id] = await store.saveCaptures([{ ...cap("Agency Name,..."), source: "fl-facts" }]);
    expect(await store.upsertStateContracts([contract("E6108"), contract("E6078")], [id!], NOW)).toEqual({
      inserted: 2,
      updated: 0,
    });
    expect(await store.upsertStateContracts([contract("E6108")], [id!], LATER)).toEqual({
      inserted: 0,
      updated: 0,
    });
    expect(
      await store.upsertStateContracts(
        [
          contract("E6108", {
            totalAmount: 1900000,
            newEndDate: "2026-12-31",
            contentHash: "c-v2",
            vendor: null,
          }),
        ],
        [id!],
        LATER,
      ),
    ).toEqual({ inserted: 0, updated: 1 });
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
    // The latest run stopped at a request budget: its cursor is where the next run resumes.
    const cursor = { since: "2026-10-01T00:00:00.000Z", until: "2026-10-31T10:00:00.000Z", offset: 2 };
    await store.recordMarketRun({
      source: "sam-awards",
      startedAt: NOW,
      finishedAt: NOW,
      windowSince: cursor.since,
      windowUntil: cursor.until,
      fetched: 200,
      inserted: 200,
      updated: 0,
      rejected: 0,
      captures: 2,
      complete: false,
      notes: [],
      error: null,
      cursor,
    });
    expect(await store.lastMarketCursor("sam-awards")).toEqual(cursor);
    expect(await store.lastMarketCursor("openfema-pa")).toBeNull();
  });
});

const detail = (key: string, over: Partial<FederalAwardDetail> = {}): FederalAwardDetail => ({
  key,
  solicitationId: "SOL-1",
  offersReceived: 3,
  extentCompeted: "A",
  extentCompetedName: "FULL AND OPEN COMPETITION",
  setAside: null,
  setAsideName: null,
  pricingType: "FIRM FIXED PRICE",
  baseAndAllOptions: 500000,
  totalObligation: 125000,
  potentialEndDate: "2029-06-30",
  parentAwardKey: null,
  contentHash: `d-${key}`,
  captureIndex: 0,
  ...over,
});

describe.each([
  ["memory", async (): Promise<MarketStore> => new MemoryMarketStore()],
  ["postgres (PGlite)", async (): Promise<MarketStore> => (await pg()).store],
])("market store award details: %s", (_name, make) => {
  it("queues awards for details, prefers live contracts, and re-queues an award when it changes", async () => {
    const store = await make();
    const [id] = await store.saveCaptures([cap("{}")]);
    await store.upsertFederalAwards(
      [award("OLD", { endDate: "2019-01-01" }), award("LIVE", { endDate: "2027-06-30" })],
      [id!],
      NOW,
    );
    expect(await store.awardsNeedingDetail(10, NOW)).toEqual(["LIVE", "OLD"]);
    expect(await store.awardsNeedingDetail(1, NOW)).toEqual(["LIVE"]);
    expect(await store.saveAwardDetails([detail("LIVE"), detail("OLD"), detail("MISSING")], [id!], NOW)).toBe(
      2,
    );
    expect(await store.awardsNeedingDetail(10, NOW)).toEqual([]);
    // A changed award (new obligation) needs its details read again.
    await store.upsertFederalAwards([award("LIVE", { amount: 9, contentHash: "h-LIVE-2" })], [id!], LATER);
    expect(await store.awardsNeedingDetail(10, LATER)).toEqual(["LIVE"]);
  });
});

describe("market store: postgres details", () => {
  it("stores award details next to the award", async () => {
    const { store, db } = await pg();
    const [id] = await store.saveCaptures([cap("{}")]);
    await store.upsertFederalAwards([award("A1")], [id!], NOW);
    await store.saveAwardDetails([detail("A1")], [id!], NOW);
    const r = (
      await db.query<{ offers_received: number; base_and_all_options: string; potential_end_date: unknown }>(
        `SELECT offers_received, base_and_all_options, potential_end_date FROM market.federal_awards`,
      )
    ).rows[0]!;
    expect(r.offers_received).toBe(3);
    expect(Number(r.base_and_all_options)).toBe(500000);
  });

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
    expect(tables).toEqual([
      "captures",
      "federal_actions",
      "federal_awards",
      "pa_applicants",
      "pa_projects",
      "runs",
      "state_contracts",
    ]);
  });
});

describe("market store: postgres state contracts", () => {
  it("stores the columns Flight Deck reads", async () => {
    const { store, db } = await pg();
    const [id] = await store.saveCaptures([{ ...cap("csv"), source: "fl-facts" }]);
    await store.upsertStateContracts([contract("E6108", { newEndDate: "2026-12-31" })], [id!], NOW);
    const r = await db.query<Record<string, unknown>>(
      `SELECT vendor, total_amount, amount_type, begin_date::text AS begin, new_end_date::text AS end_date,
              procurement_method, capture_id FROM market.state_contracts`,
    );
    expect(r.rows[0]).toMatchObject({
      vendor: "GARNER ENVIRONMENTAL SERVICES, INC.",
      amount_type: "award_fixed",
      begin: "2025-10-30",
      end_date: "2026-12-31",
      capture_id: id,
    });
    expect(Number(r.rows[0]!.total_amount)).toBe(1751680.15);
  });
});
