import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  HttpClient,
  VendorLinkConnector,
  formFields,
  normalizeVendorLink,
  parseVendorLinkGrid,
  stateForAgency,
  vlDate,
} from "../src/index.js";

const html = (name: string) => readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8");
const FORM = html("vendorlink-osceola-form.2026-10-28.verbatim.html");
const RESULTS = html("vendorlink-osceola-results.2026-10-28.verbatim.html");
const AT = "2026-10-28T12:00:00.000Z";
const SITE = { host: "vendorlink.osceola.org", defaultState: "FL" };

describe("VendorLink", () => {
  it("reads the captured live Osceola results grid", () => {
    const g = parseVendorLinkGrid(RESULTS);
    expect(g.rows.length).toBe(10);
    expect(g.agencies.get("Osceola County School Board")).toBe("8");
    const net = g.rows.find((r) => r.number === "SDOC-27-018-B-DM")!;
    expect(net).toMatchObject({
      agency: "Osceola County School Board",
      agencyId: "8",
      title: "Network Infrastructure Equipment",
      status: "Active",
      broadcast: "10/13/2026 4:00 PM",
      questionEnd: "10/30/2026 12:00 PM",
      due: "12/10/2026 2:00 PM",
    });
  });

  it("normalizes a row with Eastern due times, the question deadline and a stable id", () => {
    const row = parseVendorLinkGrid(RESULTS).rows.find((r) => r.number === "SDOC-27-018-B-DM")!;
    const o = normalizeVendorLink(row, AT, SITE);
    expect(o.id).toBe("vendorlink:vendorlink.osceola.org/8/SDOC-27-018-B-DM");
    expect(o.source).toBe("vendorlink");
    expect(o.buyer).toEqual({ name: "Osceola County School Board", id: "8", level: "local" });
    expect(o.state).toBe("FL");
    expect(o.dueAt).toBe("2026-12-10T19:00:00.000Z");
    expect(o.postedAt).toBe("2026-10-13T20:00:00.000Z");
    expect(o.keyDates).toContainEqual(
      expect.objectContaining({ kind: "questions_due", date: "2026-10-30", time: "12:00 PM" }),
    );
    expect(o.provenance.sourceUrl).toBe("https://vendorlink.osceola.org/external/bids?a=8");
    expect(normalizeVendorLink(row, AT, SITE).provenance.contentHash).toBe(o.provenance.contentHash);
  });

  it("labels sole-source notices and standing registrations, and places out-of-state agencies", () => {
    const base = parseVendorLinkGrid(RESULTS).rows[0]!;
    expect(normalizeVendorLink({ ...base, title: "Single/Sole Source - Chipco Choice" }, AT, SITE).kind).toBe(
      "single_source",
    );
    expect(
      normalizeVendorLink(
        { ...base, title: "Preferred Contractor Network - Registration", due: null },
        AT,
        SITE,
      ).kind,
    ).toBe("informational");
    expect(stateForAgency("City of Madison, Georgia", "FL")).toBe("GA");
    expect(stateForAgency("Cape Hatteras Electric Cooperative", "FL")).toBe("NC");
    expect(stateForAgency("City of Ocala", "FL")).toBe("FL");
    expect(vlDate("11/16/2026 10:00 AM")).toBe("2026-11-16T15:00:00.000Z");
    expect(vlDate("")).toBeNull();
  });

  it("posts the form back as a browser does: all agencies, Active, 100 per page, no buttons", () => {
    const f = formFields(FORM);
    expect(f.has("__VIEWSTATE")).toBe(true);
    expect(f.has("ctl00$RegionMiddle$btnSearch")).toBe(false);
    expect([...f.keys()]).toContain("ctl00$RegionMiddle$ddlAgency");
  });

  it("runs end to end: GET the form, POST the search, follow the pager, and survive a failing site", async () => {
    const page2 = RESULTS.replace("SDOC-27-018-B-DM", "SDOC-27-999-B-XX").replace(`<table`, `<table`);
    const pagerRow = `<tr><td colspan="10"><table><tr><td><span>1</span></td><td><a href="javascript:__doPostBack('ctl00$RegionMiddle$grvSolicitations','Page$2')">2</a></td></tr></table></td></tr>`;
    const withPager = RESULTS.replace(
      /(<table[^>]*id="ctl00_RegionMiddle_grvSolicitations"[^>]*>[\s\S]*?)(<\/table>)/,
      (_m, head: string, close: string) => `${head}${pagerRow}${close}`,
    );
    const bodies: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.startsWith("https://down.example")) return new Response("busy", { status: 403 });
      if (!init?.method) return new Response(FORM, { status: 200 });
      const body = String(init.body);
      bodies.push(body);
      return new Response(body.includes("Page%242") ? page2 : withPager, { status: 200 });
    }) as unknown as typeof fetch;
    const http = new HttpClient({ userAgent: "test", minIntervalMs: 0, fetchImpl, sleep: async () => {} });
    const run = await new VendorLinkConnector({
      http,
      sites: [SITE, { host: "down.example", defaultState: "FL" }],
      now: () => AT,
    }).fetch();
    const search = new URLSearchParams(bodies[0]);
    expect(search.get("ctl00$RegionMiddle$ddlAgency")).toBe("");
    expect(search.get("ctl00$RegionMiddle$ddlStatus")).toBe("2");
    expect(search.get("ctl00$RegionMiddle$rblSolicitationPageCount")).toBe("100");
    expect(search.has("ctl00$RegionMiddle$cbPiggyback")).toBe(false);
    expect(new URLSearchParams(bodies[1]).get("__EVENTARGUMENT")).toBe("Page$2");
    // 10 from page 1, plus the one posting that is new on page 2 (the other 9 repeat and are not duplicated).
    expect(run.opportunities).toHaveLength(11);
    expect(run.complete).toBe(false);
    expect(run.rejected.map((r) => r.sourceRecordId)).toEqual(["down.example"]);
  });
});
