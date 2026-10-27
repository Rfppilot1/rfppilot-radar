import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  BonfireConnector,
  HttpClient,
  OpenGovConnector,
  bonfireDateToIso,
  normalizeBonfire,
  normalizeOpenGov,
} from "../src/index.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const AT = "2026-10-27T18:00:00.000Z";
const noSleep = async () => {};

/** An HttpClient whose fetch answers from a router, so connectors run end to end without the network. */
function fakeHttp(route: (url: string, init?: RequestInit) => unknown) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push({ url: u, init });
    const body = route(u, init);
    if (body instanceof Response) return body;
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
  return { http: new HttpClient({ userAgent: "test", minIntervalMs: 0, fetchImpl, sleep: noSleep }), calls };
}

describe("OpenGov", () => {
  it("normalizes the captured live City of Tampa record", () => {
    const { rows } = fx("opengov-projects.2026-10-27.verbatim.json");
    const o = normalizeOpenGov(rows[0], AT);
    expect(o.id).toBe("opengov:cityoftampa/316374");
    expect(o.source).toBe("opengov");
    expect(o.title).toBe("Overhead Door Services (Bid Discount)");
    expect(o.solicitationNumber).toBe("27-P-00016");
    expect(o.kind).toBe("itb");
    expect(o.kindLabel).toBe("Invitation to Bid");
    expect(o.buyer).toEqual({ name: "City of Tampa", id: "cityoftampa", level: "local" });
    expect(o.state).toBe("FL");
    expect(o.dueAt).toBe("2026-11-16T20:00:00.000Z");
    expect(o.dueTimezone).toBe("America/New_York");
    expect(o.hasAddendum).toBe(true);
    expect(o.description).toMatch(/overhead doors/i);
    expect(o.provenance.sourceUrl).toBe("https://procurement.opengov.com/portal/cityoftampa/projects/316374");
    expect(normalizeOpenGov(rows[1], AT).hasAddendum).toBe(false);
  });

  it("routes notices of intent and pre-solicitation notices to intel kinds", () => {
    const { rows } = fx("opengov-projects.2026-10-27.verbatim.json");
    expect(normalizeOpenGov({ ...rows[0], template: { title: "Notice of Intent to Award" } }, AT).kind).toBe(
      "award_decision",
    );
    expect(normalizeOpenGov({ ...rows[0], template: null, title: "Public Notice: Road Plan" }, AT).kind).toBe(
      "presolicitation",
    );
    expect(normalizeOpenGov({ ...rows[0], template: { title: "Request for Proposals" } }, AT).kind).toBe(
      "rfp",
    );
  });

  it("discovers governments in the configured states and reads each portal's open projects", async () => {
    const govs = fx("opengov-governments.2026-10-27.verbatim.json");
    const fl = {
      ...govs[0],
      name: "City of Tampa",
      state: "FL",
      timezone: "America/New_York",
      government: { ...govs[0].government, code: "cityoftampa" },
    };
    const inactive = { ...fl, isActive: false, government: { code: "oldportal" } };
    const projects = fx("opengov-projects.2026-10-27.verbatim.json");
    const { http, calls } = fakeHttp((url) => {
      if (url.endsWith("/government")) return [...govs, fl, inactive];
      if (url.includes("/government/cityoftampa/project/public")) return projects;
      return new Response("not found", { status: 404 });
    });
    const run = await new OpenGovConnector({ http, states: ["FL"], now: () => AT }).fetch();
    const portals = calls.filter((c) => c.url.includes("/project/public"));
    expect(portals.map((c) => c.url)).toEqual([
      "https://api.procurement.opengov.com/api/v1/government/cityoftampa/project/public",
    ]);
    expect(JSON.parse(String(portals[0]!.init?.body))).toMatchObject({
      filters: [{ type: "status", value: "open" }],
      page: 1,
    });
    expect(run.opportunities).toHaveLength(3);
    expect(run.complete).toBe(true);
    expect(run.rejected).toEqual([]);
  });

  it("keeps going when one portal fails, but marks the run incomplete", async () => {
    const govs = fx("opengov-governments.2026-10-27.verbatim.json");
    const projects = fx("opengov-projects.2026-10-27.verbatim.json");
    const codes = govs.map((g: { government: { code: string } }) => g.government.code);
    const { http } = fakeHttp((url) => {
      if (url.endsWith("/government")) return govs;
      if (url.includes(`/government/${codes[0]}/`)) return new Response("bad", { status: 400 });
      return { count: 1, rows: [projects.rows[0]] };
    });
    const run = await new OpenGovConnector({ http, states: ["TX"], now: () => AT }).fetch();
    expect(run.complete).toBe(false);
    expect(run.rejected[0]!.sourceRecordId).toBe(codes[0]);
    expect(run.opportunities.length).toBe(codes.length - 1);
  });
});

describe("Bonfire", () => {
  const portal = { org: "broward", name: "Broward County", state: "FL", timezone: "America/New_York" };

  it("reads Bonfire's UTC close time", () => {
    expect(bonfireDateToIso("2026-10-30 18:00:00")).toBe("2026-10-30T18:00:00.000Z");
    expect(bonfireDateToIso("not a date")).toBeNull();
  });

  it("normalizes the captured live Broward County list", () => {
    const res = fx("bonfire-broward.2026-10-27.verbatim.json");
    const o = normalizeBonfire(res.payload.projects["239116"], AT, portal, "FASD - Purchasing");
    expect(o.id).toBe("bonfire:broward/239116");
    expect(o.title).toBe("Environmental Planning and Consulting Services at FLL and HWO");
    expect(o.solicitationNumber).toBe("PNC2131299P1");
    expect(o.buyer).toEqual({ name: "Broward County", id: "broward", level: "local" });
    expect(o.state).toBe("FL");
    expect(o.dueAt).toBe("2026-10-30T18:00:00.000Z");
    expect(o.description).toBe("Department: FASD - Purchasing");
    expect(o.provenance.sourceUrl).toBe("https://broward.bonfirehub.com/opportunities/239116");
    expect(normalizeBonfire(res.payload.projects["243763"], AT, portal).kind).toBe("presolicitation");
    expect(normalizeBonfire(res.payload.projects["257719"], AT, portal).kind).toBe("rfi");
  });

  it("reads every configured portal and skips non-public projects", async () => {
    const res = fx("bonfire-broward.2026-10-27.verbatim.json");
    res.payload.projects["259480"].ProjectVisibilityID = "2";
    const { http, calls } = fakeHttp((url) =>
      url.startsWith("https://broward.") ? res : new Response("gone", { status: 404 }),
    );
    const run = await new BonfireConnector({
      http,
      portals: [portal, { ...portal, org: "missing", name: "Missing" }],
      now: () => AT,
    }).fetch();
    expect(calls.map((c) => c.url)).toEqual([
      "https://broward.bonfirehub.com/PublicPortal/getOpenPublicOpportunitiesSectionData",
      "https://missing.bonfirehub.com/PublicPortal/getOpenPublicOpportunitiesSectionData",
    ]);
    expect(run.opportunities.map((o) => o.sourceRecordId).sort()).toEqual([
      "broward/239116",
      "broward/243763",
      "broward/257719",
    ]);
    expect(run.complete).toBe(false);
    expect(run.rejected[0]!.sourceRecordId).toBe("missing");
  });
});
