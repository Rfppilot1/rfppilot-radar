import type { SourceConnector } from "@radar/connectors";
import { FirmProfile, type Opportunity } from "@radar/core";
import { MemoryRepository, rescoreProfile, type Repository } from "@radar/store";
import { describe, expect, it } from "vitest";
import {
  deliverDigests,
  deliveryKey,
  healthProblems,
  ingestSources,
  maskEmail,
  scoreProfiles,
  sendAlert,
  type DeliveryOptions,
  type SourceResult,
} from "../src/daily.js";
import type { Mail, Mailer } from "../src/mailer.js";

const DAY1 = "2026-10-20T10:45:00.000Z";
const DAY2 = "2026-10-21T10:45:00.000Z";
const SCORED = "2026-10-20T10:40:00.000Z";
const quiet = () => {};

function opp(id: string, over: Partial<Opportunity> = {}): Opportunity {
  return {
    id: `fl-mfmp:${id}`,
    source: "fl-mfmp",
    sourceRecordId: id,
    solicitationNumber: `ITN-${id}`,
    title: "Independent Verification and Validation Services",
    description: null,
    kind: "itn",
    kindLabel: null,
    status: "open",
    buyer: { name: "Department of Revenue", id: "73", level: "state" },
    state: "FL",
    postedAt: "2026-10-19T13:00:00.000Z",
    dueAt: "2026-12-01T19:00:00.000Z",
    dueTimezone: "America/New_York",
    codes: [{ system: "UNSPSC", code: "80101500", description: null }],
    setAside: null,
    contact: null,
    documents: [],
    version: null,
    hasAddendum: false,
    keyDates: [],
    estimatedValue: null,
    provenance: {
      source: "fl-mfmp",
      sourceUrl: `https://vendor.myfloridamarketplace.com/search/bids/detail/${id}`,
      fetchedAt: DAY1,
      contentHash: id.padEnd(64, "0"),
      basis: "fl-mfmp",
    },
    ...over,
  };
}

const profile = (tenantId: string, id: string, email: string[] = []) =>
  FirmProfile.parse({
    id,
    tenantId,
    name: `${tenantId} ${id}`,
    states: ["FL"],
    codes: [{ system: "UNSPSC", prefix: "801015" }],
    capabilities: [{ phrase: "independent verification and validation" }],
    delivery: { email },
  });

/** Records every email; fails for the listed addresses. */
class FakeMailer implements Mailer {
  sent: Mail[] = [];
  constructor(public failFor = new Set<string>()) {}
  async send(mail: Mail) {
    if (mail.to.some((t) => this.failFor.has(t))) throw new Error("Resend API 500: try later");
    this.sent.push(mail);
    return { id: `em_${this.sent.length}` };
  }
}

const opts = (over: Partial<DeliveryOptions>): DeliveryOptions => ({
  log: quiet,
  now: DAY1,
  mailer: null,
  recipientOverrides: new Map(),
  testTo: null,
  feedback: null,
  unsubscribe: "mailto:u@rfppilot.com",
  replay: false,
  federalMinScore: 45,
  summarizer: null,
  ...over,
});

async function seeded() {
  const repo = new MemoryRepository();
  await repo.upsertOpportunities([opp("1")], DAY1);
  return repo;
}

describe("daily run: one failure never stops the others", () => {
  it("scores and emails every other profile when one profile fails", async () => {
    const repo = await seeded();
    const good = profile("isf", "isf-main", ["monica@isf.example"]);
    const bad = profile("acme", "acme-main", ["ops@acme.example"]);
    await repo.upsertProfile(bad, DAY1);
    await repo.upsertProfile(good, DAY1);
    // The bad profile's reads throw, as a corrupt profile or a broken query would.
    const broken = new Proxy(repo, {
      get(target, prop, recv) {
        const v = Reflect.get(target, prop, recv);
        if (typeof v !== "function") return v;
        return (...args: unknown[]) =>
          args[0] === "acme" && ["listMatches", "lastDigestAt"].includes(String(prop))
            ? Promise.reject(new Error("boom"))
            : v.apply(target, args);
      },
    }) as Repository;

    const scored = await scoreProfiles(broken, { log: quiet, now: DAY1 });
    expect(scored.map((r) => [r.profileId, r.ok])).toEqual([
      ["acme-main", false],
      ["isf-main", true],
    ]);
    const mailer = new FakeMailer();
    const delivered = await deliverDigests(broken, opts({ mailer }));
    expect(delivered.find((r) => r.profileId === "acme-main")).toMatchObject({ ok: false, error: "boom" });
    expect(delivered.find((r) => r.profileId === "isf-main")?.ok).toBe(true);
    expect(mailer.sent.map((m) => m.to)).toEqual([["monica@isf.example"]]);
  });

  it("keeps ingesting other sources when one throws, and records the failure", async () => {
    const repo = new MemoryRepository();
    const failing: SourceConnector = {
      id: "tx-esbd",
      basis: "tx-esbd",
      fetch: async () => {
        throw new Error("HTTP 503 from txsmartbuy");
      },
    };
    const working: SourceConnector = {
      id: "fl-mfmp",
      basis: "fl-mfmp",
      fetch: async () => ({
        source: "fl-mfmp",
        opportunities: [opp("1")],
        rejected: [],
        fetchedAt: DAY1,
        complete: true,
      }),
    };
    const res = await ingestSources(repo, [{ connector: failing }, { connector: working }], { log: quiet });
    expect(res.map((r) => [r.source, r.ok, r.inserted])).toEqual([
      ["tx-esbd", false, 0],
      ["fl-mfmp", true, 1],
    ]);
    expect(repo.runs.find((r) => r.source === "tx-esbd")?.error).toMatch(/503/);
  });

  it("stops a source at its deadline, keeps what it fetched, and never closes records on that run", async () => {
    const repo = new MemoryRepository();
    await repo.upsertOpportunities([opp("1"), opp("2")], "2026-10-19T10:00:00.000Z");
    const controller = new AbortController();
    const slow: SourceConnector = {
      id: "fl-mfmp",
      basis: "fl-mfmp",
      fetch: async () => {
        await new Promise((r) => setTimeout(r, 30));
        // The connector believes it saw the full list, but the deadline passed while it ran.
        return {
          source: "fl-mfmp",
          opportunities: [opp("1")],
          rejected: [],
          fetchedAt: DAY1,
          complete: true,
        };
      },
    };
    const [r] = await ingestSources(repo, [{ connector: slow, controller }], { log: quiet, deadlineMs: 5 });
    expect(r).toMatchObject({ ok: true, deadlineHit: true, complete: false, closed: 0 });
    expect((await repo.getOpportunity("fl-mfmp:2"))?.status).toBe("open");
  });
});

describe("daily run: email is sent once per recipient", () => {
  it("re-sends to the failed recipient the next day without repeating to the others", async () => {
    const repo = await seeded();
    const p = profile("isf", "isf-main", ["a@isf.example", "b@isf.example"]);
    await repo.upsertProfile(p, DAY1);
    await rescoreProfile(repo, p, SCORED);

    // Day 1: b's send fails.
    const day1 = new FakeMailer(new Set(["b@isf.example"]));
    const r1 = await deliverDigests(repo, opts({ mailer: day1 }));
    expect(r1[0]).toMatchObject({ ok: false });
    expect(r1[0]!.error).toContain("b***@isf.example");
    expect(r1[0]!.error).not.toContain("b@isf.example");
    expect(day1.sent.map((m) => m.to)).toEqual([["a@isf.example"]]);
    expect(await repo.lastDeliveryAt("isf", "isf-main", "a@isf.example")).toBe(DAY1);
    // b's window stays pinned at its start; the profile mark moves because a got the email.
    expect(await repo.lastDeliveryAt("isf", "isf-main", "b@isf.example")).toBe("1970-01-01T00:00:00.000Z");
    expect(await repo.lastDigestAt("isf", "isf-main")).toBe(DAY1);

    // Day 2: b gets yesterday's new match; a does not see it again.
    const day2 = new FakeMailer();
    const r2 = await deliverDigests(repo, opts({ mailer: day2, now: DAY2 }));
    expect(r2[0]!.ok).toBe(true);
    const toA = day2.sent.find((m) => m.to[0] === "a@isf.example")!;
    const toB = day2.sent.find((m) => m.to[0] === "b@isf.example")!;
    expect(toB.subject).toMatch(/1 new/);
    expect(toA.subject).toMatch(/0 new/);
    expect(toA.idempotencyKey).not.toBe(toB.idempotencyKey);
    expect(await repo.lastDigestAt("isf", "isf-main")).toBe(DAY2);
  });

  it("does not move the profile mark when every send fails", async () => {
    const repo = await seeded();
    const p = profile("isf", "isf-main", ["a@isf.example"]);
    await repo.upsertProfile(p, DAY1);
    await rescoreProfile(repo, p, SCORED);
    await deliverDigests(repo, opts({ mailer: new FakeMailer(new Set(["a@isf.example"])) }));
    expect(await repo.lastDigestAt("isf", "isf-main")).toBeNull();
  });

  it("sends one email per address whatever its capitalization", async () => {
    const repo = await seeded();
    const p = profile("isf", "isf-main", ["A@isf.example", "a@isf.example"]);
    await repo.upsertProfile(p, DAY1);
    await rescoreProfile(repo, p, SCORED);
    const mailer = new FakeMailer();
    await deliverDigests(repo, opts({ mailer }));
    expect(mailer.sent).toHaveLength(1);
  });

  it("reuses the idempotency key for a resend of the same window, and changes it after a delivery", () => {
    const p = profile("isf", "isf-main");
    expect(deliveryKey(p, "A@isf.example", DAY1, "live")).toBe(deliveryKey(p, "a@isf.example", DAY1, "live"));
    expect(deliveryKey(p, "a@isf.example", DAY1, "live")).not.toBe(
      deliveryKey(p, "a@isf.example", DAY2, "live"),
    );
    expect(deliveryKey(p, "a@isf.example", DAY1, "live")).not.toBe(
      deliveryKey(p, "a@isf.example", DAY1, "test"),
    );
  });

  it("a test send goes only to the tester and records nothing", async () => {
    const repo = await seeded();
    const p = profile("isf", "isf-main", ["a@isf.example"]);
    await repo.upsertProfile(p, DAY1);
    await rescoreProfile(repo, p, SCORED);
    const mailer = new FakeMailer();
    await deliverDigests(repo, opts({ mailer, testTo: "ben@rfppilot.com" }));
    expect(mailer.sent.map((m) => [m.to[0], m.subject.startsWith("[TEST]")])).toEqual([
      ["ben@rfppilot.com", true],
    ]);
    expect(repo.deliveries).toEqual([]);
    expect(await repo.lastDigestAt("isf", "isf-main")).toBeNull();
  });

  it("refuses a second overlapping run through the worker lock", async () => {
    const repo = new MemoryRepository();
    const lock = await repo.tryRunLock("worker");
    expect(lock).not.toBeNull();
    expect(await repo.tryRunLock("worker")).toBeNull();
    await lock!.release();
    expect(await repo.tryRunLock("worker")).not.toBeNull();
  });
});

describe("daily run: health check", () => {
  const ok = (over: Partial<SourceResult>): SourceResult => ({
    source: "fl-mfmp",
    ok: true,
    fetched: 100,
    inserted: 0,
    updated: 0,
    closed: 0,
    rejected: 0,
    complete: true,
    windowed: false,
    closeRefused: false,
    deadlineHit: false,
    error: null,
    ...over,
  });

  it("reports failed, empty, refused, slow, unreadable and stale sources, and failed profiles", async () => {
    const repo = new MemoryRepository();
    await repo.recordRun({
      source: "bonfire",
      startedAt: "2026-10-10T10:00:00.000Z",
      finishedAt: "2026-10-10T10:05:00.000Z",
      fetched: 40,
      inserted: 0,
      updated: 0,
      closed: 0,
      rejected: 0,
      complete: true,
      error: null,
    });
    const problems = await healthProblems(
      repo,
      [
        ok({ source: "tx-esbd", ok: false, fetched: 0, error: "HTTP 503" }),
        ok({ source: "opengov", fetched: 0 }),
        ok({ source: "vendorlink", closeRefused: true }),
        ok({ source: "sam-gov", deadlineHit: true }),
        ok({ source: "fl-mfmp", fetched: 10, rejected: 30 }),
        ok({ source: "bonfire", complete: false }),
      ],
      [{ tenantId: "isf", profileId: "isf-main", step: "digest", ok: false, error: "email failed" }],
      DAY2,
    );
    expect(problems).toEqual([
      "tx-esbd: failed (HTTP 503)",
      "opengov: returned 0 records",
      "vendorlink: too many open records were missing from the run, so none were closed",
      "sam-gov: stopped at its time limit",
      "fl-mfmp: 30 of 40 records could not be read",
      "bonfire: no complete run since 2026-10-10",
      "isf/isf-main: digest failed (email failed)",
    ]);
    expect(await healthProblems(repo, [ok({})], [], DAY2)).toEqual([]);
  });

  it("does not flag SAM.gov for never completing, only for no successful run in four days", async () => {
    const repo = new MemoryRepository();
    const sam = { ...ok({ source: "sam-gov" }), complete: false, windowed: true };
    const record = (finishedAt: string, error: string | null) =>
      repo.recordRun({
        source: "sam-gov",
        startedAt: finishedAt,
        finishedAt,
        fetched: error ? 0 : 50,
        inserted: 0,
        updated: 0,
        closed: 0,
        rejected: 0,
        complete: false,
        error,
      });
    await record(DAY2, null);
    expect(await healthProblems(repo, [sam], [], DAY2)).toEqual([]);
    const later = new Date(Date.parse(DAY2) + 5 * 86_400_000).toISOString();
    await record(later, "HTTP 500");
    expect(await healthProblems(repo, [sam], [], later)).toEqual([
      `sam-gov: no successful run since ${DAY2.slice(0, 10)}`,
    ]);
  });

  it("emails the operator only when something is wrong", async () => {
    const mailer = new FakeMailer();
    const o = { mailer, to: "ben@rfppilot.com", log: quiet, now: DAY2 };
    expect(await sendAlert(o, [])).toBe(false);
    expect(await sendAlert(o, ["tx-esbd: failed (<HTTP 503>)"])).toBe(true);
    expect(mailer.sent).toHaveLength(1);
    expect(mailer.sent[0]!.subject).toBe("[Radar alert] 1 problem in the 2026-10-21 run");
    expect(mailer.sent[0]!.html).toContain("&lt;HTTP 503&gt;");
    expect(await sendAlert({ ...o, mailer: new FakeMailer(new Set(["ben@rfppilot.com"])) }, ["x"])).toBe(
      false,
    );
  });

  it("masks addresses for logs", () => {
    expect(maskEmail("monica@isf.example")).toBe("m***@isf.example");
    expect(maskEmail("nope")).toBe("***");
  });
});
