import { PGlite } from "@electric-sql/pglite";
import { FirmProfile, type Opportunity } from "@radar/core";
import { beforeEach, describe, expect, it } from "vitest";
import {
  buildDigest,
  ingestRun,
  MemoryRepository,
  migrate,
  PostgresRepository,
  rescoreProfile,
  type Repository,
} from "../src/index.js";

const NOW = "2026-10-15T14:00:00.000Z";

function opp(id: string, over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: `tx-esbd:${id}`,
    source: "tx-esbd",
    sourceRecordId: id,
    solicitationNumber: `RFP-${id}`,
    title: "Independent Verification and Validation Services",
    description: null,
    kind: "rfp",
    kindLabel: null,
    status: "open",
    buyer: { name: "Health and Human Services Commission", id: "529", level: "state" },
    state: "TX",
    postedAt: "2026-10-14T05:00:00.000Z",
    dueAt: "2026-11-20T20:00:00.000Z",
    dueTimezone: "America/Chicago",
    codes: [{ system: "NIGP", code: "91875", description: null }],
    setAside: null,
    contact: null,
    documents: [],
    version: null,
    hasAddendum: false,
    keyDates: [],
    estimatedValue: null,
    provenance: {
      source: "tx-esbd",
      sourceUrl: `https://www.txsmartbuy.gov/esbd/RFP-${id}`,
      fetchedAt: NOW,
      contentHash: "a".repeat(64),
      basis: "tx-esbd",
    },
    ...over,
  };
}

const profile = (tenantId = "isf", id = "isf-main") =>
  FirmProfile.parse({
    id,
    tenantId,
    name: "ISF",
    states: ["TX", "FL"],
    codes: [{ system: "NIGP", prefix: "918" }],
    capabilities: [{ phrase: "independent verification and validation" }],
  });

const impls: [string, () => Promise<Repository>][] = [
  ["memory", async () => new MemoryRepository()],
  [
    "postgres (PGlite)",
    async () => {
      const db = new PGlite();
      await migrate(db as never);
      return new PostgresRepository(db as never);
    },
  ],
];

describe.each(impls)("%s repository", (_name, make) => {
  let repo: Repository;
  beforeEach(async () => {
    repo = await make();
  });

  it("inserts, detects changes by content hash, and counts unchanged records", async () => {
    let r = await repo.upsertOpportunities([opp("1"), opp("2")], NOW);
    expect(r.inserted).toEqual(["tx-esbd:1", "tx-esbd:2"]);
    const changed = opp("1", {
      provenance: { ...opp("1").provenance, contentHash: "b".repeat(64) },
      hasAddendum: true,
    });
    r = await repo.upsertOpportunities([changed, opp("2")], NOW);
    expect(r).toEqual({ inserted: [], updated: ["tx-esbd:1"], unchanged: 1 });
    expect((await repo.getOpportunity("tx-esbd:1"))?.hasAddendum).toBe(true);
  });

  it("filters opportunities by state and open status", async () => {
    await repo.upsertOpportunities(
      [opp("1"), opp("2", { state: "GA" }), opp("3", { status: "closed" })],
      NOW,
    );
    const list = await repo.listOpportunities({ states: ["TX"], openOnly: true });
    expect(list.map((o) => o.id)).toEqual(["tx-esbd:1"]);
  });

  it("isolates tenants: same profile id in two tenants, no cross reads or writes", async () => {
    await repo.upsertProfile(profile(), NOW);
    expect(await repo.getProfile("other", "isf-main")).toBeNull();
    await expect(repo.listMatches("other", "isf-main")).rejects.toThrow(/not found/);
    await expect(repo.saveMatches("other", [])).resolves.toBeUndefined();
    await repo.upsertOpportunities([opp("1")], NOW);
    await rescoreProfile(repo, profile(), NOW);
    const m = (await repo.listMatches("isf", "isf-main"))[0]!;
    await expect(repo.saveMatches("other", [m])).rejects.toThrow(/not found/);

    // Another tenant may create its own profile with the same id; both stay independent.
    await repo.upsertProfile(FirmProfile.parse({ ...profile("other"), name: "Other Co" }), NOW);
    expect((await repo.getProfile("isf", "isf-main"))?.name).toBe("ISF");
    expect((await repo.getProfile("other", "isf-main"))?.name).toBe("Other Co");
    expect(await repo.listMatches("other", "isf-main")).toEqual([]);
    expect((await repo.listProfiles("isf")).map((p) => p.tenantId)).toEqual(["isf"]);
    await expect(repo.listProfiles("")).rejects.toThrow(/tenantId/);
  });

  it("closes records missing from a complete run, and only from a complete run", async () => {
    const six = ["1", "2", "3", "4", "5", "6"].map((id) => opp(id));
    await repo.upsertOpportunities(six, "2026-10-14T10:00:00.000Z");
    const seen = six.slice(0, 5);
    const run = (complete: boolean) => ({
      source: "tx-esbd",
      opportunities: seen,
      rejected: [],
      fetchedAt: NOW,
      complete,
    });
    expect((await ingestRun(repo, run(false), NOW)).closed).toEqual([]);
    const full = await ingestRun(repo, run(true), NOW);
    expect(full.closed).toEqual(["tx-esbd:6"]);
    expect((await repo.getOpportunity("tx-esbd:6"))?.status).toBe("closed");

    // It reappears upstream unchanged: it reopens.
    const back = await ingestRun(
      repo,
      { ...run(false), opportunities: [opp("6")], fetchedAt: "2026-10-16T00:00:00.000Z" },
      NOW,
    );
    expect(back.updated).toEqual(["tx-esbd:6"]);
    expect((await repo.getOpportunity("tx-esbd:6"))?.status).toBe("open");
  });

  it("refuses to close by absence on an empty run or when too much would close at once", async () => {
    await repo.upsertOpportunities(
      ["1", "2", "3"].map((id) => opp(id)),
      "2026-10-14T10:00:00.000Z",
    );
    const empty = await ingestRun(
      repo,
      { source: "tx-esbd", opportunities: [], rejected: [], fetchedAt: NOW, complete: true },
      NOW,
    );
    expect(empty.closed).toEqual([]);
    const glitch = await ingestRun(
      repo,
      { source: "tx-esbd", opportunities: [opp("1")], rejected: [], fetchedAt: NOW, complete: true },
      NOW,
    );
    expect(glitch.closed).toEqual([]);
    expect(glitch.closeRefused).toEqual({ wouldClose: 2, open: 3 });
    expect((await repo.getOpportunity("tx-esbd:2"))?.status).toBe("open");
  });

  it("hides matches whose opportunity closed or passed its due date", async () => {
    await repo.upsertProfile(profile(), NOW);
    await repo.upsertOpportunities([opp("1"), opp("2")], NOW);
    await rescoreProfile(repo, profile(), NOW);
    // Opportunity 2 disappears upstream; the 0.5 limit lets one of two close in this small fixture.
    await repo.upsertOpportunities([opp("1")], "2026-10-16T00:00:00.000Z");
    await repo.closeMissing("tx-esbd", "2026-10-16T00:00:00.000Z", 0.5);
    expect(
      (await repo.listMatches("isf", "isf-main", { activeAt: NOW })).map((m) => m.opportunityId),
    ).toEqual(["tx-esbd:1"]);
    expect(await repo.listMatches("isf", "isf-main", { activeAt: "2026-12-01T00:00:00.000Z" })).toEqual([]);
    expect(await repo.listMatches("isf", "isf-main")).toHaveLength(2); // administrative read keeps history
  });

  it("counts a match as new when it first becomes good, not when first scored", async () => {
    const p = profile();
    await repo.upsertProfile(p, NOW);
    await repo.upsertOpportunities([opp("5", { title: "Fleet Vehicles", codes: [] })], NOW);
    await rescoreProfile(repo, p, NOW);
    expect((await repo.getMatch("isf", "isf-main", "tx-esbd:5"))?.firstGoodAt).toBeNull();
    const later = "2026-10-16T14:00:00.000Z";
    await repo.upsertOpportunities(
      [
        opp("5", {
          codes: [{ system: "NIGP", code: "91875", description: null }],
          provenance: { ...opp("5").provenance, contentHash: "9".repeat(64) },
        }),
      ],
      later,
    );
    await rescoreProfile(repo, p, later);
    const m = await repo.getMatch("isf", "isf-main", "tx-esbd:5");
    expect(m?.firstGoodAt).toBe(later);
    expect(m?.firstMatchedAt).toBe(NOW);
    const d = await buildDigest(repo, "isf", "isf-main", { since: "2026-10-16T00:00:00.000Z", now: later });
    expect(d.newMatches.map((e) => e.opportunity.id)).toEqual(["tx-esbd:5"]);
  });

  it("lists strong matches from earlier emails that are still open and not closing this week", async () => {
    const p = profile();
    await repo.upsertProfile(p, NOW);
    await repo.upsertOpportunities([opp("1")], NOW);
    await rescoreProfile(repo, p, NOW);
    const m = await repo.getMatch("isf", "isf-main", "tx-esbd:1");
    const later = "2026-10-17T14:00:00.000Z";
    const d = await buildDigest(repo, "isf", "isf-main", { since: "2026-10-16T00:00:00.000Z", now: later });
    expect(d.newMatches).toEqual([]);
    const listed = (d.strongOpen ?? []).map((e) => e.opportunity.id);
    const closing = d.closingSoon.map((e) => e.opportunity.id);
    expect({ band: m?.band, closing, listed }).toEqual({
      band: "strong",
      closing: [],
      listed: ["tx-esbd:1"],
    });
    expect(listed.some((id) => closing.includes(id))).toBe(false);
  });

  it("shows federal notices only at or above the federal fit bar, and counts the rest as screened out", async () => {
    const p = profile();
    await repo.upsertProfile(p, NOW);
    const fed = (id: string) =>
      opp(id, {
        id: `sam-gov:${id}`,
        source: "sam-gov",
        buyer: { name: "DEPT OF DEFENSE / DEPT OF THE NAVY", id: null, level: "federal" },
        provenance: { ...opp(id).provenance, source: "sam-gov" },
      });
    await repo.upsertOpportunities([opp("1"), fed("2")], NOW);
    await rescoreProfile(repo, p, NOW);
    const state = await repo.getMatch("isf", "isf-main", "tx-esbd:1");
    const federal = await repo.getMatch("isf", "isf-main", "sam-gov:2");
    expect(federal?.score).toBe(state?.score);
    const since = "2026-10-14T00:00:00.000Z";
    const open = await buildDigest(repo, "isf", "isf-main", { since, now: NOW, federalMinScore: 0 });
    expect(open.newMatches.map((e) => e.opportunity.id).sort()).toEqual(["sam-gov:2", "tx-esbd:1"]);
    const barred = await buildDigest(repo, "isf", "isf-main", { since, now: NOW, federalMinScore: 101 });
    expect(barred.newMatches.map((e) => e.opportunity.id)).toEqual(["tx-esbd:1"]);
    expect(barred.glance!.notFit).toBe(open.glance!.notFit + 1);
  });

  it("remembers the last delivered digest per tenant profile", async () => {
    await repo.upsertProfile(profile(), NOW);
    expect(await repo.lastDigestAt("isf", "isf-main")).toBeNull();
    await repo.recordDigest("isf", "isf-main", NOW);
    expect(await repo.lastDigestAt("isf", "isf-main")).toBe(NOW);
    await expect(repo.lastDigestAt("other", "isf-main")).rejects.toThrow(/not found/);
  });

  it("scores, keeps first-matched time across rescoring, and records decisions with the hash at decision time", async () => {
    await repo.upsertProfile(profile(), NOW);
    await repo.upsertOpportunities([opp("1")], NOW);
    expect(await rescoreProfile(repo, profile(), NOW)).toBe(1);
    await rescoreProfile(repo, profile(), "2026-10-16T14:00:00.000Z");
    const [m] = await repo.listMatches("isf", "isf-main");
    expect(m?.firstMatchedAt).toBe(NOW);
    expect(m?.band).toBe("strong");
    const d = await repo.saveDecision("isf", {
      opportunityId: "tx-esbd:1",
      profileId: "isf-main",
      decision: "pass",
      reason: "capacity",
      decidedBy: "monica",
      decidedAt: NOW,
    });
    expect(d.hashAtDecision).toBe("a".repeat(64));
  });

  it("builds a digest with new matches and a second look at passes that later changed", async () => {
    await repo.upsertProfile(profile(), NOW);
    await ingestRun(
      repo,
      {
        source: "tx-esbd",
        opportunities: [opp("1"), opp("2")],
        rejected: [],
        fetchedAt: NOW,
        complete: false,
      },
      NOW,
    );
    await rescoreProfile(repo, profile(), NOW);
    await repo.saveDecision("isf", {
      opportunityId: "tx-esbd:2",
      profileId: "isf-main",
      decision: "pass",
      reason: null,
      decidedBy: null,
      decidedAt: NOW,
    });
    await repo.upsertOpportunities(
      [opp("2", { provenance: { ...opp("2").provenance, contentHash: "c".repeat(64) } })],
      NOW,
    );

    const d = await buildDigest(repo, "isf", "isf-main", { since: "2026-10-15T00:00:00.000Z", now: NOW });
    expect(d.newMatches.map((e) => e.opportunity.id)).toEqual(["tx-esbd:1"]);
    expect(d.secondLook.map((s) => [s.opportunity.id, s.why])).toEqual([["tx-esbd:2", "changed"]]);
  });

  it("alerts on tracked bids that changed since the last digest, including ones pulled early", async () => {
    await repo.upsertProfile(profile(), NOW);
    await ingestRun(
      repo,
      {
        source: "tx-esbd",
        opportunities: ["1", "2", "3", "4", "5", "6"].map((i) => opp(i)),
        rejected: [],
        fetchedAt: NOW,
        complete: true,
      },
      NOW,
    );
    await rescoreProfile(repo, profile(), NOW);
    const later = "2026-10-16T14:00:00.000Z";
    // Next run: 1 is extended, 3 is gone from the source before its deadline, the rest are unchanged.
    await ingestRun(
      repo,
      {
        source: "tx-esbd",
        opportunities: [
          opp("1", {
            dueAt: "2026-11-30T20:00:00.000Z",
            provenance: { ...opp("1").provenance, contentHash: "d".repeat(64) },
          }),
          ...["2", "4", "5", "6"].map((i) => opp(i)),
        ],
        rejected: [],
        fetchedAt: later,
        complete: true,
      },
      later,
    );
    await rescoreProfile(repo, profile(), later);
    const d = await buildDigest(repo, "isf", "isf-main", { since: "2026-10-16T00:00:00.000Z", now: later });
    expect(d.changed?.map((c) => [c.opportunity.id, c.changes.map((x) => x.kind)])).toEqual([
      ["tx-esbd:1", ["due_moved"]],
      ["tx-esbd:3", ["withdrawn"]],
    ]);
    expect(d.newMatches).toEqual([]);
  });

  it("applies a reviewer to weak matches, reuses the review while unchanged, and survives reviewer errors", async () => {
    const p = profile();
    await repo.upsertProfile(p, NOW);
    await repo.upsertOpportunities(
      [
        opp("9", { title: "Random Moment Sampling", codes: [] }),
        opp("10", { title: "Time Study", codes: [] }),
      ],
      NOW,
    );
    let calls = 0;
    const reviewer = {
      id: "fake",
      review: async (o: Opportunity) => {
        calls++;
        if (o.id.endsWith(":10")) throw new Error("rate limited");
        return { verdict: "fit" as const, rationale: "Program evaluation work.", reviewer: "fake" };
      },
    };
    const errors: string[] = [];
    await rescoreProfile(repo, p, NOW, { reviewer, onReviewError: (id) => errors.push(id) });
    await rescoreProfile(repo, p, NOW, { reviewer, onReviewError: (id) => errors.push(id) });
    expect(calls).toBe(3); // 9 reviewed once then reused; 10 retried after its error
    expect(errors).toEqual(["tx-esbd:10", "tx-esbd:10"]);
    const m = await repo.getMatch("isf", "isf-main", "tx-esbd:9");
    expect(m?.review?.verdict).toBe("fit");
    expect(m?.reasons.filter((r) => r.factor === "semantic")).toHaveLength(1);

    // Editing the profile's capabilities invalidates the cached review.
    const edited = FirmProfile.parse({ ...p, capabilities: [...p.capabilities, { phrase: "time study" }] });
    await repo.upsertProfile(edited, NOW);
    await rescoreProfile(repo, edited, NOW, { reviewer, onReviewError: () => {} });
    expect(calls).toBe(5);
  });

  it("tracks deliveries per recipient and falls back to the profile's last digest", async () => {
    await repo.upsertProfile(profile(), NOW);
    expect(await repo.lastDeliveryAt("isf", "isf-main", "a@x.co")).toBeNull();
    await repo.recordDigest("isf", "isf-main", "2026-10-14T10:00:00.000Z");
    expect(await repo.lastDeliveryAt("isf", "isf-main", "a@x.co")).toBe("2026-10-14T10:00:00.000Z");
    await repo.recordDelivery({
      tenantId: "isf",
      profileId: "isf-main",
      recipient: "A@X.co",
      generatedAt: NOW,
      messageId: "em_1",
    });
    expect(await repo.lastDeliveryAt("isf", "isf-main", "a@x.co")).toBe(NOW);
    expect(await repo.lastDeliveryAt("isf", "isf-main", "b@x.co")).toBe("2026-10-14T10:00:00.000Z");
    await expect(repo.lastDeliveryAt("other", "isf-main", "a@x.co")).rejects.toThrow(/not found/);
    await expect(
      repo.recordDelivery({
        tenantId: "other",
        profileId: "isf-main",
        recipient: "a@x.co",
        generatedAt: NOW,
        messageId: null,
      }),
    ).rejects.toThrow(/not found/);
  });

  it("reports a source's last complete run", async () => {
    const run = (finishedAt: string, complete: boolean) => ({
      source: "tx-esbd",
      startedAt: finishedAt,
      finishedAt,
      fetched: 1,
      inserted: 0,
      updated: 0,
      closed: 0,
      rejected: 0,
      complete,
      error: null,
    });
    expect(await repo.lastCompleteRunAt("tx-esbd")).toBeNull();
    await repo.recordRun(run("2026-10-13T10:00:00.000Z", true));
    await repo.recordRun(run("2026-10-14T10:00:00.000Z", false));
    expect(await repo.lastCompleteRunAt("tx-esbd")).toBe("2026-10-13T10:00:00.000Z");
    // Error-free runs count for windowed sources, complete or not; a failed run does not.
    expect(await repo.lastSuccessfulRunAt("tx-esbd")).toBe("2026-10-14T10:00:00.000Z");
    await repo.recordRun({ ...run("2026-10-15T10:00:00.000Z", false), error: "HTTP 503" });
    expect(await repo.lastSuccessfulRunAt("tx-esbd")).toBe("2026-10-14T10:00:00.000Z");
    expect(await repo.lastSuccessfulRunAt("sam-gov")).toBeNull();
  });

  it("returns every row when asked for all, past the default cap of 500", async () => {
    const many = Array.from({ length: 620 }, (_, i) => opp(String(i).padStart(4, "0")));
    const r = await repo.upsertOpportunities(many, NOW);
    expect(r.inserted).toHaveLength(620);
    expect(await repo.listOpportunities({ openOnly: true })).toHaveLength(500);
    expect(await repo.listOpportunities({ openOnly: true, limit: "all" })).toHaveLength(620);
    await repo.upsertProfile(profile(), NOW);
    expect(await rescoreProfile(repo, profile(), NOW)).toBe(620);
    expect(
      await repo.listMatches("isf", "isf-main", { bands: ["strong", "possible", "weak"], limit: "all" }),
    ).toHaveLength(620);
  });

  it("takes and releases the worker lock and answers a health ping", async () => {
    const lock = await repo.tryRunLock("worker");
    expect(lock).not.toBeNull();
    await lock!.release();
    expect(await repo.tryRunLock("worker")).not.toBeNull();
    await expect(repo.ping()).resolves.toBeUndefined();
  });

  it("keeps the stored version of a partially fetched record instead of overwriting it", async () => {
    const full = opp("7", { codes: [{ system: "NIGP", code: "91875", description: null }] });
    await repo.upsertOpportunities([full], "2026-10-14T10:00:00.000Z");
    const thin = opp("7", { codes: [], provenance: { ...full.provenance, contentHash: "e".repeat(64) } });
    const r = await ingestRun(
      repo,
      {
        source: "tx-esbd",
        opportunities: [thin],
        rejected: [],
        fetchedAt: NOW,
        complete: false,
        partialIds: ["tx-esbd:7"],
      },
      NOW,
    );
    expect(r.updated).toEqual([]);
    expect((await repo.getOpportunity("tx-esbd:7"))?.codes).toHaveLength(1);
  });
});

describe("feedback-informed review", () => {
  it("passes the firm's own calls to the reviewer and redoes a cached review when that feedback changes", async () => {
    const { MemoryRepository: Repo, rescoreProfile: rescore } = await import("../src/index.js");
    const { FirmProfile: FP } = await import("@radar/core");
    const repo = new Repo();
    const NOW2 = "2026-10-15T14:00:00.000Z";
    const mk = (id: string, title: string) => ({
      id,
      source: "tx-esbd" as const,
      sourceRecordId: id,
      solicitationNumber: id,
      title,
      description: null,
      kind: "rfp" as const,
      kindLabel: null,
      status: "open" as const,
      buyer: { name: "Some Agency", id: null, level: "state" as const },
      state: "TX",
      postedAt: NOW2,
      dueAt: "2026-12-01T20:00:00.000Z",
      dueTimezone: "America/Chicago",
      codes: [],
      setAside: null,
      contact: null,
      documents: [],
      version: 1,
      hasAddendum: false,
      keyDates: [],
      estimatedValue: null,
      provenance: {
        source: "tx-esbd" as const,
        sourceUrl: `https://www.txsmartbuy.gov/esbd/${id}`,
        fetchedAt: NOW2,
        contentHash: id.padEnd(64, "0"),
        basis: "tx-esbd",
      },
    });
    await repo.upsertOpportunities(
      [mk("tx-esbd:a", "Program evaluation"), mk("tx-esbd:b", "Grant management")],
      NOW2,
    );
    const p = FP.parse({
      id: "isf-main",
      tenantId: "isf",
      name: "ISF",
      states: ["TX"],
      codes: [],
      capabilities: [{ phrase: "program evaluation" }],
      exclusions: [],
    });
    await repo.upsertProfile(p, NOW2);
    const seen: number[] = [];
    const reviewer = {
      id: "fake",
      review: async (_o: unknown, _p: unknown, fb?: unknown[]) => {
        seen.push(fb?.length ?? 0);
        return { verdict: "maybe" as const, rationale: "ok", reviewer: "fake" };
      },
    };
    await rescore(repo, p, NOW2, { reviewer });
    const first = seen.length;
    await rescore(repo, p, NOW2, { reviewer });
    expect(seen.length).toBe(first); // cached
    await repo.saveDecision("isf", {
      opportunityId: "tx-esbd:b",
      profileId: "isf-main",
      decision: "pass",
      reason: "Not our work",
      decidedBy: "x@y.z",
      decidedAt: NOW2,
    });
    await rescore(repo, p, NOW2, { reviewer });
    expect(seen.length).toBeGreaterThan(first); // feedback changed, so reviews are redone
    expect(seen.at(-1)).toBe(1);
  });
});

describe("postgres transactions", () => {
  it("rolls back a whole chunk when one record fails, leaving no record without its version", async () => {
    const db = new PGlite();
    await migrate(db as never);
    const repo = new PostgresRepository(db as never);
    // A record whose version insert fails: a trigger rejects version rows for one id.
    await db.exec(`
      CREATE FUNCTION reject_v() RETURNS trigger AS $$ BEGIN
        IF NEW.opportunity_id = 'tx-esbd:2' THEN RAISE EXCEPTION 'version write failed'; END IF;
        RETURN NEW; END $$ LANGUAGE plpgsql;
      CREATE TRIGGER reject_v BEFORE INSERT ON opportunity_versions FOR EACH ROW EXECUTE FUNCTION reject_v();`);
    await expect(repo.upsertOpportunities([opp("1"), opp("2")], NOW)).rejects.toThrow(/version write failed/);
    expect(await repo.getOpportunity("tx-esbd:1")).toBeNull();
    expect(await repo.getOpportunity("tx-esbd:2")).toBeNull();
  });

  it("applies migrations in a transaction and records each once", async () => {
    const db = new PGlite();
    expect(await migrate(db as never)).toEqual([
      "001_init.sql",
      "002_versions_seen_idx.sql",
      "003_deliveries.sql",
      "004_market.sql",
      "005_market_award_detail.sql",
      "006_market_cursor.sql",
    ]);
    expect(await migrate(db as never)).toEqual([]);
  });
});
