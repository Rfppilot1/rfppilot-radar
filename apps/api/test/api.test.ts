import type { Opportunity } from "@radar/core";
import { MemoryRepository, rescoreProfile } from "@radar/store";
import { beforeEach, describe, expect, it } from "vitest";
import { ApiKeyAuth, buildApp, openApiDocument } from "../src/index.js";

const NOW = "2026-10-15T14:00:00.000Z";
const ISF = { authorization: "Bearer isf-key-0123456789abcdef" };
const OTHER = { authorization: "Bearer other-key-0123456789abcdef" };

const opp: Opportunity = {
  id: "fl-mfmp:990001",
  source: "fl-mfmp",
  sourceRecordId: "990001",
  solicitationNumber: "ITN 2627-011",
  title: "Organizational Assessment and Strategic Planning Services",
  description: null,
  kind: "itn",
  kindLabel: "Invitation to Negotiate",
  status: "open",
  buyer: { name: "Agency for Health Care Administration (AHCA)", id: "30000099", level: "state" },
  state: "FL",
  postedAt: "2026-10-14T13:00:00.000Z",
  dueAt: "2026-11-24T19:00:00.000Z",
  dueTimezone: "America/New_York",
  codes: [
    {
      system: "UNSPSC",
      code: "80101500",
      description: "Business and corporate management consultation services",
    },
  ],
  setAside: null,
  contact: null,
  documents: [
    {
      filename: "ITN 2627-011.pdf",
      url: "https://vendor.myfloridamarketplace.com/doc/1",
      description: null,
      postedAt: null,
    },
  ],
  version: 2,
  hasAddendum: true,
  provenance: {
    source: "fl-mfmp",
    sourceUrl: "https://vendor.myfloridamarketplace.com/search/bids/detail/990001",
    fetchedAt: NOW,
    contentHash: "d".repeat(64),
    basis: "fl-mfmp",
  },
};

const profileBody = {
  name: "ISF",
  states: ["FL", "TX"],
  codes: [{ system: "UNSPSC", prefix: "801015" }],
  capabilities: [{ phrase: "strategic planning" }, { phrase: "organizational assessment" }],
  exclusions: ["janitorial"],
  knownBuyers: ["Agency for Health Care Administration"],
};

describe("Radar API", () => {
  let repo: MemoryRepository;
  let app: ReturnType<typeof buildApp>;

  beforeEach(async () => {
    repo = new MemoryRepository();
    await repo.upsertOpportunities([opp], NOW);
    app = buildApp({
      repo,
      auth: new ApiKeyAuth([
        { tenantId: "isf", key: "isf-key-0123456789abcdef" },
        { tenantId: "other", key: "other-key-0123456789abcdef" },
      ]),
      now: () => NOW,
    });
  });

  it("rejects requests without a valid key", async () => {
    expect((await app.inject({ url: "/v1/profiles" })).statusCode).toBe(401);
    expect(
      (await app.inject({ url: "/v1/profiles", headers: { authorization: "Bearer nope" } })).statusCode,
    ).toBe(401);
    expect((await app.inject({ url: "/healthz" })).statusCode).toBe(200);
  });

  it("validates input and returns 400 with issues", async () => {
    const r = await app.inject({
      method: "PUT",
      url: "/v1/profiles/isf-main",
      headers: ISF,
      payload: { name: "x" },
    });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toBe("invalid_request");
  });

  it("runs the full flow: profile → matches → decision → second look → digest → handoff", async () => {
    const put = await app.inject({
      method: "PUT",
      url: "/v1/profiles/isf-main",
      headers: ISF,
      payload: profileBody,
    });
    expect(put.statusCode).toBe(200);
    expect(put.json().tenantId).toBe("isf");

    const profile = (await repo.getProfile("isf", "isf-main"))!;
    await rescoreProfile(repo, profile, NOW);

    const matches = (await app.inject({ url: "/v1/profiles/isf-main/matches", headers: ISF })).json().matches;
    expect(matches).toHaveLength(1);
    expect(matches[0].match.band).toBe("strong");
    expect(matches[0].opportunity.title).toBe(opp.title);

    const md = await app.inject({
      url: `/v1/profiles/isf-main/digest?format=markdown&since=2026-10-15T00:00:00.000Z`,
      headers: ISF,
    });
    expect(md.headers["content-type"]).toContain("text/markdown");
    expect(md.body).toContain(opp.title);

    const dec = await app.inject({
      method: "POST",
      url: "/v1/profiles/isf-main/decisions",
      headers: ISF,
      payload: {
        opportunityId: opp.id,
        decision: "pass",
        reason: "No capacity this quarter",
        decidedBy: "reviewer",
      },
    });
    expect(dec.statusCode).toBe(200);
    const sl = (await app.inject({ url: "/v1/profiles/isf-main/second-look", headers: ISF })).json().items;
    expect(sl[0].why).toBe("passed");
    expect(sl[0].note).toContain("No capacity");

    const h = await app.inject({
      url: `/v1/profiles/isf-main/opportunities/${encodeURIComponent(opp.id)}/handoff`,
      headers: ISF,
    });
    expect(h.statusCode).toBe(200);
    expect(h.json().documents[0].originalFilename).toBe("ITN 2627-011.pdf");
  });

  it("never exposes one tenant's data to another, and allows the same profile id in both", async () => {
    await app.inject({ method: "PUT", url: "/v1/profiles/isf-main", headers: ISF, payload: profileBody });
    await rescoreProfile(repo, (await repo.getProfile("isf", "isf-main"))!, NOW);
    await app.inject({
      method: "POST",
      url: "/v1/profiles/isf-main/decisions",
      headers: ISF,
      payload: { opportunityId: opp.id, decision: "pass", reason: "secret reason" },
    });
    const asOther = (url: string) => app.inject({ url, headers: OTHER });
    for (const url of [
      "/v1/profiles/isf-main",
      "/v1/profiles/isf-main/matches",
      "/v1/profiles/isf-main/digest",
      "/v1/profiles/isf-main/second-look",
      `/v1/profiles/isf-main/opportunities/${encodeURIComponent(opp.id)}/handoff`,
    ]) {
      expect((await asOther(url)).statusCode, url).toBe(404);
    }
    const decide = await app.inject({
      method: "POST",
      url: "/v1/profiles/isf-main/decisions",
      headers: OTHER,
      payload: { opportunityId: opp.id, decision: "pursue" },
    });
    expect(decide.statusCode).toBe(404);
    expect((await asOther("/v1/profiles")).json().profiles).toEqual([]);

    // The other tenant can create its own "isf-main"; ISF's profile and decisions are untouched.
    const put = await app.inject({
      method: "PUT",
      url: "/v1/profiles/isf-main",
      headers: OTHER,
      payload: { ...profileBody, name: "Other Co" },
    });
    expect(put.statusCode).toBe(200);
    expect((await app.inject({ url: "/v1/profiles/isf-main", headers: ISF })).json().name).toBe("ISF");
    expect((await asOther("/v1/profiles/isf-main/second-look")).json().items).toEqual([]);
  });

  it("cannot be bypassed with percent-encoded or odd paths", async () => {
    await app.inject({ method: "PUT", url: "/v1/profiles/isf-main", headers: ISF, payload: profileBody });
    for (const url of [
      "/%761/profiles",
      "/v%31/profiles",
      "//v1/profiles",
      "/V1/profiles",
      "/v1//profiles",
    ]) {
      const r = await app.inject({ url });
      expect([401, 404], url).toContain(r.statusCode);
      expect(r.body, url).not.toContain("isf-main");
    }
  });

  it("stops listing matches once the opportunity is past due", async () => {
    await app.inject({ method: "PUT", url: "/v1/profiles/isf-main", headers: ISF, payload: profileBody });
    await rescoreProfile(repo, (await repo.getProfile("isf", "isf-main"))!, NOW);
    const later = buildApp({
      repo,
      auth: new ApiKeyAuth([{ tenantId: "isf", key: "isf-key-0123456789abcdef" }]),
      now: () => "2026-12-01T00:00:00.000Z",
    });
    expect(
      (await later.inject({ url: "/v1/profiles/isf-main/matches", headers: ISF })).json().matches,
    ).toEqual([]);
  });

  it("publishes an OpenAPI document generated from the validation schemas", async () => {
    const doc = openApiDocument();
    expect(doc.openapi).toBe("3.1.0");
    expect(Object.keys(doc.paths)).toContain(
      "/v1/profiles/{profileId}/opportunities/{opportunityId}/handoff",
    );
    expect(
      (await app.inject({ url: "/openapi.json" })).json().components.schemas.RfpPilotHandoff,
    ).toBeDefined();
  });
});

describe("ApiKeyAuth", () => {
  it("parses env config and rejects weak keys or bad tenant ids", () => {
    expect(ApiKeyAuth.fromEnv("isf:abcdefghijklmnop").tenantFor("abcdefghijklmnop")).toBe("isf");
    expect(() => ApiKeyAuth.fromEnv("isf:short")).toThrow(/16/);
    expect(() => ApiKeyAuth.fromEnv("Bad Tenant:abcdefghijklmnop")).toThrow(/tenant/);
  });
});
