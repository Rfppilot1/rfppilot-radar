import { describe, expect, it } from "vitest";
import { placeBuyer, type County } from "../lib/counties";
import { applyView, parseView, tabCounts, viewHref, type FilterContext } from "../lib/filters";
import { countiesOf, stateMap } from "../lib/geo";
import { localDay, marketStats, shadeStep } from "../lib/market";
import type { MatchItem } from "../lib/radar";

const NOW = "2026-10-20T14:00:00.000Z";
const FL = countiesOf("FL");
const TX = countiesOf("TX");

function item(
  id: string,
  o: Partial<MatchItem["opportunity"]> & { band?: "strong" | "possible"; score?: number; first?: string },
): MatchItem {
  return {
    match: {
      opportunityId: id,
      profileId: "p",
      score: o.score ?? 60,
      band: o.band ?? "possible",
      lane: "bid",
      reasons: [],
      scoredAt: NOW,
      scorerVersion: "t",
      firstMatchedAt: o.first ?? "2026-10-10T00:00:00.000Z",
    },
    opportunity: {
      id,
      source: "fl-mfmp",
      sourceRecordId: id,
      solicitationNumber: o.solicitationNumber ?? null,
      title: o.title ?? "Strategic planning",
      description: null,
      kind: o.kind ?? "rfp",
      kindLabel: null,
      status: "open",
      buyer: o.buyer ?? { name: "City of Orlando", id: null, level: "local" },
      state: o.state === undefined ? "FL" : o.state,
      postedAt: null,
      dueAt: o.dueAt === undefined ? "2026-10-25T19:00:00.000Z" : o.dueAt,
      dueTimezone: null,
      codes: [],
      setAside: null,
      contact: null,
      documents: [],
      version: null,
      hasAddendum: false,
      keyDates: [],
      estimatedValue: o.estimatedValue ?? null,
      provenance: {
        source: "fl-mfmp",
        sourceUrl: "https://example.gov",
        fetchedAt: NOW,
        contentHash: "a".repeat(64),
        basis: "t",
      },
    },
  } as MatchItem;
}

const place = (counties: County[], name: string, level: "state" | "local" = "local", state = "FL") =>
  placeBuyer({ buyerName: name, buyerLevel: level, state, counties });

describe("county shapes", () => {
  it("has every Florida and Texas county", () => {
    expect(FL).toHaveLength(67);
    expect(TX).toHaveLength(254);
    const m = stateMap("FL")!;
    expect(m.counties).toHaveLength(67);
    expect(m.counties.every((c) => c.d.startsWith("M"))).toBe(true);
    expect(stateMap("ZZ")).toBeNull();
  });
});

describe("placing a buyer on a county", () => {
  it.each([
    ["Orange County Board of County Commissioners", "Orange"],
    ["School District of Palm Beach County", "Palm Beach"],
    ["Miami-Dade County", "Miami-Dade"],
    ["Broward County Public Schools", "Broward"],
    ["City of Orlando", "Orange"],
    ["University of Central Florida", "Orange"],
    ["JEA", "Duval"],
    ["Saint Johns County", "St. Johns"],
    ["City of Port St. Lucie", "St. Lucie"],
  ])("%s is in %s County, FL", (buyer, county) => {
    const p = place(FL, buyer);
    expect(p.kind).toBe("county");
    expect(p.kind === "county" && p.county.name).toBe(county);
  });

  it("puts Texas cities and ISDs in their counties", () => {
    const h = place(TX, "City of Houston", "local", "TX");
    expect(h.kind === "county" && h.county.name).toBe("Harris");
    const d = place(TX, "Dallas County", "local", "TX");
    expect(d.kind === "county" && d.county.name).toBe("Dallas");
  });

  it("does not read a city out of another place's name", () => {
    const at = (buyer: string, state = "FL") => {
      const p = place(state === "FL" ? FL : TX, buyer, "local", state);
      return p.kind === "county" ? p.county.name : p.kind;
    };
    expect(at("Key Largo Fire Rescue")).toBe("Monroe");
    expect(at("Orlando Sanford International Airport")).toBe("Seminole");
    expect(at("City of Largo")).toBe("Pinellas");
    expect(at("Greater Orlando Aviation Authority")).toBe("unplaced");
    expect(at("Stephen F. Austin State University", "TX")).toBe("Nacogdoches");
    expect(at("Austin Independent School District", "TX")).toBe("Travis");
    expect(at("Temple ISD", "TX")).toBe("Bell");
  });

  it("never places a state agency on a county, and never guesses", () => {
    expect(place(FL, "Orange County Sheriff", "state").kind).toBe("statewide");
    expect(place(FL, "Regional Mobility Authority").kind).toBe("unplaced");
    // "Orange" as a word in a name is not Orange County without the word "County".
    expect(place(FL, "Orange Blossom Water District").kind).toBe("unplaced");
    expect(place(FL, "Department of Transportation District 4").kind).toBe("unplaced");
  });
});

describe("filters", () => {
  const ctx = (over: Partial<FilterContext> = {}): FilterContext => ({
    now: NOW,
    previousVisit: null,
    passed: new Set(),
    countyOf: () => null,
    ...over,
  });
  const items = [
    item("a", { band: "strong", score: 90, dueAt: "2026-11-15T19:00:00.000Z" }),
    item("b", { score: 50, state: "TX", buyer: { name: "City of Houston", id: null, level: "local" } }),
    item("c", { score: 70, buyer: { name: "VA", id: null, level: "federal" }, dueAt: null }),
    item("d", { score: 40, kind: "itn", first: "2026-10-19T00:00:00.000Z" }),
  ];

  it("reads the URL safely and writes short URLs", () => {
    const v = parseView({ tab: "TX", due: "999", county: "12095'", sort: "nope", q: "x".repeat(200) }, [
      "FL",
      "TX",
    ]);
    expect(v).toMatchObject({ tab: "tx", due: null, county: null, sort: "fit" });
    expect(v.q).toHaveLength(80);
    expect(parseView({ tab: "ca" }, ["FL"]).tab).toBe("all");
    const d = parseView({}, ["FL"]);
    expect(viewHref("/o", d)).toBe("/o");
    expect(viewHref("/o", d, { tab: "fl", due: 14 })).toBe("/o?tab=fl&due=14");
  });

  it("splits federal onto its own tab and counts each tab under the current filters", () => {
    const v = parseView({ fit: "all" }, ["FL", "TX"]);
    expect(tabCounts(items, v, ["FL", "TX"], ctx()).map((t) => [t.tab, t.count])).toEqual([
      ["all", 4],
      ["fl", 2],
      ["tx", 1],
      ["federal", 1],
    ]);
    expect(applyView(items, { ...v, tab: "federal" }, ctx()).map((i) => i.opportunity.id)).toEqual(["c"]);
  });

  it("applies due window, type, passed, new-since-visit and sort", () => {
    const v = parseView({}, ["FL", "TX"]);
    expect(applyView(items, v, ctx()).map((i) => i.opportunity.id)).toEqual(["a", "c", "b", "d"]);
    expect(applyView(items, { ...v, due: 7 }, ctx()).map((i) => i.opportunity.id)).toEqual(["b", "d"]);
    expect(applyView(items, { ...v, type: "itn" }, ctx()).map((i) => i.opportunity.id)).toEqual(["d"]);
    expect(applyView(items, v, ctx({ passed: new Set(["a"]) })).map((i) => i.opportunity.id)).not.toContain(
      "a",
    );
    expect(applyView(items, { ...v, hidePassed: false }, ctx({ passed: new Set(["a"]) })).length).toBe(4);
    expect(
      applyView(items, { ...v, fresh: true }, ctx({ previousVisit: "2026-10-18T00:00:00.000Z" })).map(
        (i) => i.opportunity.id,
      ),
    ).toEqual(["d"]);
    expect(applyView(items, { ...v, sort: "due" }, ctx()).map((i) => i.opportunity.id)).toEqual([
      "b",
      "d",
      "a",
      "c",
    ]);
  });
});

describe("market numbers", () => {
  it("counts by county, statewide and unplaced, with value coverage and a 30-day timeline", () => {
    const orange = FL.find((c) => c.name === "Orange")!;
    const list = [
      item("a", {
        estimatedValue: { amount: 100_000, basis: "agency_estimate", text: null },
        dueAt: "2026-10-21T03:30:00.000Z",
      }),
      item("b", { buyer: { name: "AHCA", id: null, level: "state" }, dueAt: "2026-11-30T19:00:00.000Z" }),
      item("c", { buyer: { name: "Mystery Authority", id: null, level: "local" }, dueAt: null }),
      item("d", { buyer: { name: "VA", id: null, level: "federal" }, dueAt: null }),
    ];
    const s = marketStats(
      list,
      (i) =>
        i.opportunity.id === "a"
          ? { kind: "county", county: orange }
          : i.opportunity.id === "b"
            ? { kind: "statewide" }
            : i.opportunity.id === "d"
              ? { kind: "federal" }
              : { kind: "unplaced" },
      NOW,
      "America/New_York",
    );
    expect(s.open).toBe(4);
    expect(s.federal).toBe(1);
    expect(s.byCounty.get(orange.fips)?.count).toBe(1);
    expect(s.statewide).toBe(1);
    expect(s.unplaced).toEqual({ count: 1, buyers: ["Mystery Authority"] });
    expect(s.value).toEqual({ total: 100_000, covered: 1, of: 4 });
    expect(s.dueIn14).toBe(1);
    expect(s.closing).toHaveLength(30);
    expect(s.closing[0]!.day).toBe("2026-10-20");
    // 03:30 UTC on Oct 21 is 11:30 PM Oct 20 in Eastern time, so it lands on day 0.
    expect(s.closing[0]!.count).toBe(1);
    expect(s.closing.reduce((n, d) => n + d.count, 0)).toBe(1);
  });

  it("shades counties in four steps and keeps zero empty", () => {
    expect([0, 1, 3, 6, 8].map((n) => shadeStep(n, 8))).toEqual([0, 1, 2, 3, 4]);
    expect(shadeStep(3, 0)).toBe(0);
    expect(localDay("2026-03-08T06:30:00.000Z", "America/New_York")).toBe("2026-03-08");
  });
});
