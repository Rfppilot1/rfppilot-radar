import { FirmProfile, signFeedbackToken, type Opportunity } from "@radar/core";
import { MemoryRepository, rescoreProfile } from "@radar/store";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiKeyAuth, buildApp } from "../src/index.js";

const NOW = "2026-10-15T14:00:00.000Z";
const SECRET = "s".repeat(40);

const opp: Opportunity = {
  id: "tx-esbd:TRS000658",
  source: "tx-esbd",
  sourceRecordId: "TRS000658",
  solicitationNumber: "TRS000658",
  title: "AI and IT Technical Support and Advising <Services>",
  description: null,
  kind: "rfp",
  kindLabel: null,
  status: "open",
  buyer: { name: "Teacher Retirement System", id: "323", level: "state" },
  state: "TX",
  postedAt: "2026-10-01T13:00:00.000Z",
  dueAt: "2026-11-04T20:00:00.000Z",
  dueTimezone: "America/Chicago",
  codes: [{ system: "NIGP", code: "91871", description: null }],
  setAside: null,
  contact: null,
  documents: [],
  version: 1,
  hasAddendum: false,
  keyDates: [],
  estimatedValue: null,
  provenance: {
    source: "tx-esbd",
    sourceUrl: "https://www.txsmartbuy.gov/esbd/TRS000658",
    fetchedAt: NOW,
    contentHash: "a".repeat(64),
    basis: "tx-esbd",
  },
};

const profile = FirmProfile.parse({
  id: "isf-main",
  tenantId: "isf",
  name: "ISF, Inc.",
  states: ["TX"],
  codes: [{ system: "NIGP", prefix: "918" }],
  capabilities: [{ phrase: "technical support" }],
  exclusions: [],
});

const tok = (o = opp.id, t = "isf", now = NOW) =>
  signFeedbackToken({ t, p: "isf-main", o, r: "monica@isf.example" }, SECRET, now);

describe("email yes/no feedback", () => {
  let repo: MemoryRepository;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    repo = new MemoryRepository();
    await repo.upsertOpportunities([opp], NOW);
    await repo.upsertProfile(profile, NOW);
    await rescoreProfile(repo, profile, NOW);
    app = buildApp({ repo, auth: new ApiKeyAuth([]), now: () => NOW, feedbackSecret: SECRET });
  });

  it("opening the link shows the form, escapes the posting text, and records nothing", async () => {
    const r = await app.inject({ url: `/feedback?token=${tok()}&v=no` });
    expect(r.statusCode).toBe(200);
    expect(r.headers["content-security-policy"]).toContain("default-src 'none'");
    expect(r.body).toContain("&lt;Services&gt;");
    expect(r.body).not.toContain("<Services>");
    expect(r.body).toMatch(/value="no" required checked/);
    expect(await repo.listDecisions("isf", "isf-main")).toEqual([]);
  });

  it("pressing the button saves the vote, the reason and who answered; Yes keeps tracking, No passes", async () => {
    const post = (vote: string, reason: string) =>
      app.inject({
        method: "POST",
        url: "/feedback",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ token: tok(), vote, reason }).toString(),
      });
    let r = await post("no", "  We don't do  pension IT work.  ");
    expect(r.statusCode).toBe(200);
    let [d] = await repo.listDecisions("isf", "isf-main");
    expect(d).toMatchObject({
      opportunityId: opp.id,
      decision: "pass",
      reason: "We don't do pension IT work.",
      decidedBy: "monica@isf.example",
    });
    // Reopening shows the saved answer, and it can be changed.
    expect((await app.inject({ url: `/feedback?token=${tok()}` })).body).toContain(
      "You already answered: No",
    );
    r = await post("yes", "");
    [d] = await repo.listDecisions("isf", "isf-main");
    expect(d).toMatchObject({ decision: "watch", reason: null });
  });

  it("refuses tampered, expired, foreign-tenant and malformed tokens", async () => {
    const good = tok();
    const tampered = `${good.slice(0, -2)}xx`;
    const expired = tok(opp.id, "isf", "2026-08-01T00:00:00.000Z");
    const otherTenant = tok(opp.id, "other");
    for (const t of [tampered, expired, otherTenant, "abc", "a.b.c"]) {
      const r = await app.inject({ url: `/feedback?token=${encodeURIComponent(t)}` });
      expect(r.statusCode).toBe(400);
      const p = await app.inject({
        method: "POST",
        url: "/feedback",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        payload: new URLSearchParams({ token: t, vote: "no" }).toString(),
      });
      expect(p.statusCode).toBe(400);
    }
    expect(await repo.listDecisions("isf", "isf-main")).toEqual([]);
  });

  it("is off unless a secret is configured", async () => {
    const off = buildApp({ repo, auth: new ApiKeyAuth([]), now: () => NOW });
    expect((await off.inject({ url: `/feedback?token=${tok()}` })).statusCode).toBe(404);
  });
});
