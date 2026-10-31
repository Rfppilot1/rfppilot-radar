import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  HttpClient,
  OpenFemaPaCollector,
  UsaspendingCollector,
  UsaspendingDetailCollector,
  normalizeAwardDetail,
  monthSlices,
  normalizePaApplicant,
  normalizePaProject,
  normalizeUsaspending,
} from "../src/index.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const AT = "2026-10-31T15:00:00.000Z";
const http = (fetchImpl: (u: string, init?: RequestInit) => Promise<Response>) =>
  new HttpClient({
    userAgent: "t",
    minIntervalMs: 0,
    maxRetries: 0,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });

describe("USAspending awards", () => {
  it("normalizes the captured live records", () => {
    const [nasa, gsa] = fx("usaspending-awards.2026-10-31.verbatim.json").results;
    const a = normalizeUsaspending(gsa);
    expect(a).toMatchObject({
      key: "CONT_AWD_47QFCA21F0058_4732_GS00Q14OADU117_4732",
      awardId: "47QFCA21F0058",
      recipientName: "PERATON INC.",
      recipientUei: "ZBPQEJVECCT4",
      amount: 888673071.6,
      amountType: "obligated",
      startDate: "2021-07-06",
      endDate: "2027-01-05",
      awardingAgency: "General Services Administration",
      awardingSubAgency: "Federal Acquisition Service",
      naics: "541330",
      psc: "R701",
      popState: "FL",
      lastModified: "2026-10-27T12:27:06Z",
    });
    expect(a.sourceUrl).toBe(
      "https://www.usaspending.gov/award/CONT_AWD_47QFCA21F0058_4732_GS00Q14OADU117_4732",
    );
    expect(normalizeUsaspending(nasa).description!.length).toBeLessThanOrEqual(2000);
    // A change to the amount changes the hash; nothing else about the call does.
    expect(normalizeUsaspending({ ...gsa, "Award Amount": 1 }).contentHash).not.toBe(a.contentHash);
    expect(normalizeUsaspending(gsa).contentHash).toBe(a.contentHash);
  });

  it("splits a window into calendar months", () => {
    expect(monthSlices("2026-08-15T00:00:00Z", "2026-10-31T15:00:00Z")).toEqual([
      { start: "2026-08-15", end: "2026-08-31" },
      { start: "2026-09-01", end: "2026-09-30" },
      { start: "2026-10-01", end: "2026-10-31" },
    ]);
  });

  it("posts one query per state and month with the NAICS filter, pages, de-duplicates and keeps captures", async () => {
    const page = fx("usaspending-awards.2026-10-31.verbatim.json");
    const bodies: Record<string, unknown>[] = [];
    const collector = new UsaspendingCollector({
      http: http(async (_u, init) => {
        const b = JSON.parse(String(init!.body));
        bodies.push(b);
        const more = b.page === 1 && b.filters.place_of_performance_locations[0].state === "FL";
        return new Response(JSON.stringify({ ...page, page_metadata: { page: b.page, hasNext: more } }));
      }),
      states: ["FL", "TX"],
      naics: ["541511"],
      now: () => AT,
    });
    const run = await collector.fetch({ since: "2026-10-01T00:00:00Z" });
    // FL: two pages; TX: one page. The same two awards every time, so two records.
    expect(bodies).toHaveLength(3);
    expect(bodies[0]).toMatchObject({
      filters: {
        award_type_codes: ["A", "B", "C", "D"],
        place_of_performance_locations: [{ country: "USA", state: "FL" }],
        naics_codes: { require: ["541511"] },
        time_period: [{ start_date: "2026-10-01", end_date: "2026-10-31", date_type: "last_modified_date" }],
      },
      limit: 100,
    });
    expect(run.records.map((r) => r.awardId)).toEqual(["NNK17MA01T", "47QFCA21F0058"]);
    expect(run.records[0]!.captureIndex).toBe(0);
    expect(run.captures).toHaveLength(3);
    expect(run.complete).toBe(true);
  });

  it("marks a month that hits the 10,000-row ceiling as incomplete instead of truncating silently", async () => {
    const page = fx("usaspending-awards.2026-10-31.verbatim.json");
    const collector = new UsaspendingCollector({
      http: http(async () => new Response(JSON.stringify({ ...page, page_metadata: { hasNext: true } }))),
      states: ["FL"],
      naics: [],
      now: () => AT,
    });
    const run = await collector.fetch({ since: "2026-10-01T00:00:00Z" });
    expect(run.captures).toHaveLength(100);
    expect(run.complete).toBe(false);
    expect(run.notes[0]).toMatch(/10,000-row search ceiling/);
  });
});

describe("OpenFEMA Public Assistance", () => {
  it("normalizes the captured live project and applicant", () => {
    const [p] = fx("openfema-pa-projects.2026-10-31.verbatim.json").PublicAssistanceFundedProjectsDetails;
    const project = normalizePaProject(p);
    expect(project).toMatchObject({
      key: "4844-1-000-UGAGA-00",
      state: "FL",
      damageCategory: "A",
      damageCategoryName: "Debris Removal",
      title: "Debris removal 100%",
      federalShareObligated: 380703.38,
      declarationDate: "2024-11-05T00:00:00.000Z",
    });
    // FEMA restamps lastRefresh on every reload; that alone is not a change.
    expect(normalizePaProject({ ...p, lastRefresh: "2026-11-01T00:00:00Z" }).contentHash).toBe(
      project.contentHash,
    );
    const [a] = fx("openfema-pa-applicants.2026-10-31.verbatim.json").PublicAssistanceApplicants;
    expect(normalizePaApplicant(a)).toMatchObject({
      key: "4844-000-UGAGA-00",
      name: "Seminole Tribe of Florida",
      state: "Florida",
      city: "Hollywood",
    });
  });

  it("filters by state and lastRefresh, pages with $skip, and keys captures on the rows", async () => {
    const projects = fx("openfema-pa-projects.2026-10-31.verbatim.json");
    const applicants = fx("openfema-pa-applicants.2026-10-31.verbatim.json");
    const urls: string[] = [];
    const collector = new OpenFemaPaCollector({
      http: http(async (u) => {
        urls.push(u);
        return new Response(JSON.stringify(u.includes("Applicants") ? applicants : projects));
      }),
      states: ["FL"],
      now: () => AT,
    });
    const run = await collector.fetch({ since: "2026-10-25T00:00:00.000Z" });
    const q = (i: number) => new URL(urls[i]!).searchParams;
    expect(q(0).get("$filter")).toBe(
      "stateAbbreviation eq 'FL' and lastRefresh ge '2026-10-25T00:00:00.000Z'",
    );
    expect(q(0).get("$skip")).toBe("0");
    expect(q(1).get("$filter")).toBe("state eq 'Florida' and lastRefresh ge '2026-10-25T00:00:00.000Z'");
    expect(urls[0]).toContain("%20eq%20"); // spaces as %20, which the API expects
    const recs = run.records[0]!;
    expect(recs.projects).toHaveLength(2);
    expect(recs.applicants[0]!.name).toBe("Seminole Tribe of Florida");
    expect(recs.projects[1]!.captureIndex).toBe(0);
    expect(recs.applicants[0]!.captureIndex).toBe(1);
    // The same rows with a new run stamp get the same content key, so storage keeps one copy.
    const again = await collector.fetch({ since: "2026-10-25T00:00:00.000Z" });
    expect(again.captures[1]!.contentKey).toBe(run.captures[1]!.contentKey);
  });

  it("notes states it has no applicant-name mapping for", async () => {
    const collector = new OpenFemaPaCollector({
      http: http(async () => new Response(JSON.stringify({ PublicAssistanceFundedProjectsDetails: [] }))),
      states: ["NM"],
      now: () => AT,
    });
    const run = await collector.fetch({ since: "2026-10-25T00:00:00.000Z" });
    expect(run.notes[0]).toMatch(/NM: no state name/);
  });
});

describe("USAspending award details", () => {
  const detail = fx("usaspending-award-detail.2026-10-31.subset.json");

  it("reads offers, competition, solicitation, ceiling and potential end date from the live record", () => {
    expect(normalizeAwardDetail(detail)).toMatchObject({
      key: "CONT_AWD_47QFCA21F0058_4732_GS00Q14OADU117_4732",
      solicitationId: "47QFCA21R0074",
      offersReceived: 4,
      extentCompeted: "A",
      extentCompetedName: "FULL AND OPEN COMPETITION",
      setAside: null,
      pricingType: "COST PLUS AWARD FEE",
      baseAndAllOptions: 1078384543,
      totalObligation: 888673071.6,
      potentialEndDate: "2027-01-05",
      parentAwardKey: "CONT_IDV_GS00Q14OADU117_4732",
    });
    const blank = { ...detail, latest_transaction_contract_data: { number_of_offers_received: "" } };
    expect(normalizeAwardDetail(blank).offersReceived).toBeNull();
  });

  it("requests one award page per key and skips awards that are gone", async () => {
    const urls: string[] = [];
    const run = await new UsaspendingDetailCollector({
      http: http(async (u) => {
        urls.push(u);
        return u.includes("GONE") ? new Response("", { status: 404 }) : new Response(JSON.stringify(detail));
      }),
      now: () => AT,
    }).fetchFor(["CONT_AWD_47QFCA21F0058_4732_GS00Q14OADU117_4732", "GONE"]);
    expect(urls[0]).toBe(
      "https://api.usaspending.gov/api/v2/awards/CONT_AWD_47QFCA21F0058_4732_GS00Q14OADU117_4732/",
    );
    expect(run.records).toHaveLength(1);
    expect(run.records[0]!.captureIndex).toBe(0);
    expect(run.notes).toEqual(["1 award(s) no longer on USAspending"]);
  });
});
