import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FlMfmpConnector,
  HttpFlTransport,
  HttpClient,
  HttpError,
  SamGovConnector,
  TxEsbdConnector,
  contentHash,
  fetchDisasterSignals,
  groupDeclarations,
  kindFromText,
  normalizeFlAd,
  normalizeSam,
  normalizeTxEsbd,
  parseNigp,
  redact,
  zonedToUtcIso,
} from "../src/index.js";

const fx = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8"));
const AT = "2026-10-15T14:00:00.000Z";
const noSleep = async () => {};

describe("util", () => {
  it("converts Central and Eastern wall-clock times to UTC across DST", () => {
    expect(zonedToUtcIso("10/23/2026", "10:00 AM", "America/Chicago")).toBe("2026-10-23T15:00:00.000Z");
    expect(zonedToUtcIso("12/1/2026", "12:00 PM", "America/Chicago")).toBe("2026-12-01T18:00:00.000Z");
    expect(zonedToUtcIso("11/20/2026", "2:00 PM", "America/New_York")).toBe("2026-11-20T19:00:00.000Z");
    expect(zonedToUtcIso("not a date", null, "America/Chicago")).toBeNull();
  });

  it("hashes canonically regardless of key order", () => {
    expect(contentHash({ a: 1, b: [1, { c: 2, d: 3 }] })).toBe(contentHash({ b: [1, { d: 3, c: 2 }], a: 1 }));
  });

  it("derives notice kinds conservatively", () => {
    expect(kindFromText("ITN 2627-011")).toBe("itn");
    expect(kindFromText("Request for Proposals for audit")).toBe("rfp");
    expect(kindFromText("Statement of Qualifications for engineering")).toBe("soq");
    expect(kindFromText("Fleet vehicles")).toBeNull();
  });

  it("redacts API keys from URLs", () => {
    expect(redact("https://api.sam.gov/x?api_key=SECRET&limit=1")).toBe(
      "https://api.sam.gov/x?api_key=***&limit=1",
    );
  });
});

describe("Texas ESBD", () => {
  it("normalizes the captured live record verbatim", () => {
    const [raw] = fx("tx-esbd.2026-10-15.verbatim.json");
    const o = normalizeTxEsbd(raw, AT);
    expect(o.id).toBe("tx-esbd:564514");
    expect(o.solicitationNumber).toBe("6100019874a");
    expect(o.buyer).toEqual({ name: "City of San Antonio - M0152", id: "M0152", level: "local" });
    expect(o.status).toBe("open");
    expect(o.hasAddendum).toBe(true);
    expect(o.dueAt).toBe("2026-10-23T15:00:00.000Z");
    expect(o.kind).toBe("rfp"); // "REQUEST FOR OFFER"
    expect(o.codes[0]).toMatchObject({ system: "NIGP", code: "91017" });
    expect(o.provenance.sourceUrl).toBe("https://www.txsmartbuy.gov/esbd/6100019874a");
  });

  it("parses multi-code NIGP strings", () => {
    expect(
      parseNigp("91875-Management Consulting;92040-Information Technology Consulting;").map((c) => c.code),
    ).toEqual(["91875", "92040"]);
  });

  it("pages through the public service and stops at the last page", async () => {
    const lines = fx("tx-esbd.synthetic.json");
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ lines, page: 1, recordsPerPage: 24, totalRecordsFound: 2 })),
    );
    const http = new HttpClient({
      userAgent: "test",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    const run = await new TxEsbdConnector({ http, now: () => AT }).fetch();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const body = JSON.parse((fetchImpl.mock.calls[0] as unknown as [string, RequestInit])[1].body as string);
    expect(body).toMatchObject({ status: "1", page: "1", urlRoot: "esbd" });
    expect(run.opportunities.map((o) => o.buyer.level)).toEqual(["state", "state"]);
    expect(run.rejected).toEqual([]);
  });

  it("reads each posting's detail for description, documents and key dates, skipping ones stored unchanged", async () => {
    const lines = fx("tx-esbd.synthetic.json");
    const detail = fx("tx-esbd-detail.synthetic.json");
    const urls: string[] = [];
    const fetchImpl = async (u: string) => {
      urls.push(u);
      return new Response(
        JSON.stringify(
          u.includes("ESBD.Details") ? detail : { lines, page: 1, recordsPerPage: 24, totalRecordsFound: 2 },
        ),
      );
    };
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    const first = await new TxEsbdConnector({ http, now: () => AT, details: {} }).fetch();
    const o = first.opportunities[0]!;
    expect(o.description).toMatch(/^HHSC seeks an IV&V vendor/);
    expect(o.documents.map((d) => d.filename)).toEqual([
      "ESBD_900001_RFP 529-27-0001.pdf",
      "ESBD_900001_Addendum No. 1.pdf",
    ]);
    expect(o.documents[0]!.url).toMatch(/^https:\/\/www\.txsmartbuy\.gov\/core\/media\//);
    expect(o.hasAddendum).toBe(true);
    expect(o.contact?.email).toBe("pat.buyer@example.gov");
    expect(o.estimatedValue).toEqual({ amount: 1250000, basis: "agency_estimate", text: null });
    expect(o.keyDates.map((k) => [k.kind, k.date, k.time, k.mandatory])).toEqual([
      ["pre_bid", "2026-10-29", "10:00 AM", true],
      ["questions_due", "2026-11-05", null, null],
    ]);
    expect(urls.filter((u) => u.includes("ESBD.Details"))).toHaveLength(2);

    // Second run: both postings are already stored with detail and unchanged, so no detail calls.
    urls.length = 0;
    const known = new Map(first.opportunities.map((x) => [x.id, x.provenance.listHash!] as const));
    // The stored version must differ from a list-only copy, or the detail would never be saved.
    expect(o.provenance.contentHash).not.toBe(o.provenance.listHash);
    const second = await new TxEsbdConnector({ http, now: () => AT, details: { known } }).fetch();
    expect(urls.filter((u) => u.includes("ESBD.Details"))).toHaveLength(0);
    expect(second.partialIds).toEqual(first.opportunities.map((x) => x.id));
    expect(second.complete).toBe(true);
  });

  it("keeps malformed records as rejects instead of dropping them silently", async () => {
    const fetchImpl = async () =>
      new Response(
        JSON.stringify({ lines: [{ internalid: "x" }], page: 1, recordsPerPage: 24, totalRecordsFound: 1 }),
      );
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    const run = await new TxEsbdConnector({ http, now: () => AT }).fetch();
    expect(run.opportunities).toHaveLength(0);
    expect(run.rejected[0]?.sourceRecordId).toBe("x");
  });
});

describe("Florida MFMP", () => {
  it("normalizes the captured live record and routes agency decisions to intel", () => {
    const [raw] = fx("fl-mfmp.2026-10-15.verbatim.json");
    const o = normalizeFlAd(raw, AT);
    expect(o.id).toBe("fl-mfmp:17068");
    expect(o.kind).toBe("award_decision");
    expect(o.kindLabel).toBe("Agency Decision");
    expect(o.solicitationNumber).toBe("DOT-RFA-26-9007-PB");
    expect(o.buyer.name).toBe("Florida Department of Transportation (FDOT)");
    expect(o.dueAt).toBe("2026-10-15T21:00:00.000Z");
    expect(o.provenance.sourceUrl).toBe("https://vendor.myfloridamarketplace.com/search/bids/detail/17068");
  });

  it("maps ITN, marks later versions as addenda, and ignores the per-user favorite flag in the hash", () => {
    const [itn] = fx("fl-mfmp.synthetic.json");
    const a = normalizeFlAd(itn, AT);
    const b = normalizeFlAd({ ...itn, favorite: !itn.favorite }, AT);
    expect(a.kind).toBe("itn");
    expect(a.hasAddendum).toBe(true);
    expect(a.provenance.contentHash).toBe(b.provenance.contentHash);
  });

  it("runs through a transport", async () => {
    const transport = {
      searchAds: vi.fn(async () => fx("fl-mfmp.synthetic.json")),
      getDetail: vi.fn(async () => null),
    };
    const run = await new FlMfmpConnector({ transport, now: () => AT }).fetch({ maxRecords: 50 });
    expect(transport.searchAds).toHaveBeenCalledWith(["OPEN", "PREVIEW"], 50);
    expect(run.opportunities.map((o) => o.kind)).toEqual(["itn", "rfp"]);
  });
});

describe("SAM.gov", () => {
  const data = fx("sam-gov.synthetic.json");

  it("normalizes solicitations and sources-sought notices", () => {
    const [sol, ss] = data.opportunitiesData.map((r: unknown) => normalizeSam(r, AT));
    expect(sol.kind).toBe("rfp");
    expect(sol.state).toBe("FL");
    expect(sol.buyer.level).toBe("federal");
    expect(sol.codes).toEqual([
      { system: "NAICS", code: "541611", description: null },
      { system: "PSC", code: "R408", description: null },
    ]);
    expect(sol.dueAt).toBe("2026-11-14T20:00:00.000Z");
    expect(sol.documents).toHaveLength(1);
    expect(ss.kind).toBe("sources_sought");
    expect(ss.provenance.sourceUrl).toBe("https://sam.gov/opp/eeee5555ffff6666aaaa7777bbbb8888/view");
  });

  it("treats SAM's documented 404 No Data found as an empty result, but surfaces other errors", async () => {
    const mk = (body: string, status = 404) =>
      new SamGovConnector({
        http: new HttpClient({
          userAgent: "t",
          minIntervalMs: 0,
          maxRetries: 0,
          fetchImpl: (async () => new Response(body, { status })) as unknown as typeof fetch,
        }),
        apiKey: "k",
        states: ["FL"],
      });
    const run = await mk('{"error":{"code":"404","message":"No Data found"}}').fetch();
    expect(run.opportunities).toHaveLength(0);
    const seen: { state: string; body: string }[] = [];
    await new SamGovConnector({
      http: new HttpClient({
        userAgent: "t",
        minIntervalMs: 0,
        maxRetries: 0,
        fetchImpl: (async () => new Response("No Data found", { status: 404 })) as unknown as typeof fetch,
      }),
      apiKey: "secret-key",
      states: ["TX"],
      onNoData: (q) => seen.push(q),
    }).fetch();
    expect(seen).toMatchObject([{ state: "TX", body: "No Data found" }]);
    expect(JSON.stringify(seen)).not.toContain("secret-key");
    expect((await mk("").fetch()).opportunities).toHaveLength(0);
    await expect(mk('{"error":{"code":"API_KEY_INVALID"}}', 403).fetch()).rejects.toThrow(/HTTP 403/);
  });

  it("probes once, without the key in the log, when every SAM query answers no data", async () => {
    const urls: string[] = [];
    const probes: { endpoint: string; status: number; totalRecords: number | null }[] = [];
    await new SamGovConnector({
      http: new HttpClient({
        userAgent: "t",
        minIntervalMs: 0,
        maxRetries: 0,
        fetchImpl: (async (url: string) => {
          urls.push(String(url));
          if (String(url).includes("/prod/")) return new Response('{"totalRecords":42}', { status: 200 });
          return new Response("", { status: 404 });
        }) as unknown as typeof fetch,
      }),
      apiKey: "secret-key",
      states: ["FL", "TX"],
      onProbe: (p) => probes.push(p),
    }).fetch();
    expect(probes).toEqual([
      { endpoint: "https://api.sam.gov/opportunities/v2/search", status: 404, totalRecords: null, body: "" },
      { endpoint: "https://api.sam.gov/prod/opportunities/v2/search", status: 200, totalRecords: 42, body: "" },
    ]);
    expect(urls.filter((u) => !u.includes("state=")).every((u) => u.includes("limit=1"))).toBe(true);
    expect(JSON.stringify(probes)).not.toContain("secret-key");
  });

  it("requires an API key and queries each state with the documented parameters", async () => {
    expect(() => new SamGovConnector({ http: {} as HttpClient, apiKey: "", states: ["FL"] })).toThrow(
      /SAM_API_KEY/,
    );
    const urls: string[] = [];
    const fetchImpl = async (u: string) => {
      urls.push(u);
      return new Response(JSON.stringify(data));
    };
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    const run = await new SamGovConnector({ http, apiKey: "k", states: ["FL", "TX"], now: () => AT }).fetch();
    expect(urls).toHaveLength(2);
    const q = new URL(urls[0]!).searchParams;
    expect(q.get("postedTo")).toBe("10/15/2026");
    expect(q.get("postedFrom")).toBe("10/01/2026");
    // No type filter by default: several repeated ptype values can make SAM match nothing.
    expect(q.getAll("ptype")).toEqual([]);
    expect(q.get("state")).toBe("FL");
    expect(run.opportunities).toHaveLength(2); // deduplicated across the two state queries
  });
});

describe("OpenFEMA", () => {
  it("groups county rows into one signal per disaster", () => {
    const s = groupDeclarations(fx("openfema.verbatim.json"), "FL");
    expect(s).toHaveLength(2);
    expect(s.find((x) => x.disasterNumber === 5631)?.counties).toEqual(["Putnam", "Clay"]);
    expect(s[0]?.publicAssistance).toBe(true);
  });
});

describe("HttpClient", () => {
  it("retries transient errors and honors Retry-After, but not client errors", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = async () =>
      ++n < 3 ? new Response("busy", { status: 429, headers: { "retry-after": "2" } }) : new Response("{}");
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      minIntervalMs: 0,
    });
    await http.json("https://x.test/a");
    expect(n).toBe(3);
    expect(sleeps).toEqual([2000, 2000]);

    const bad = new HttpClient({
      userAgent: "t",
      fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    await expect(bad.json("https://x.test/b?api_key=SECRET")).rejects.toThrow(HttpError);
    await expect(bad.json("https://x.test/b?api_key=SECRET")).rejects.not.toThrow(/SECRET/);
  });
});

describe("hardening", () => {
  it("rejects impossible dates and times instead of rolling them over", () => {
    expect(zonedToUtcIso("2/30/2026", "10:00 AM", "America/Chicago")).toBeNull();
    expect(zonedToUtcIso("13/1/2026", null, "America/Chicago")).toBeNull();
    expect(zonedToUtcIso("10/1/2026", "13:00 PM", "America/Chicago")).toBeNull();
    expect(zonedToUtcIso("10/1/2026", "10:75 AM", "America/Chicago")).toBeNull();
    expect(zonedToUtcIso("10/1/2026", "23:30", "America/Chicago")).toBe("2026-10-02T04:30:00.000Z");
  });

  it("classifies by the earliest notice-type mention", () => {
    expect(kindFromText("RFP for services following the Request for Information")).toBe("rfp");
    expect(kindFromText("Bid_254855_IR.doc")).toBeNull();
  });

  it("never keeps an API key on an HttpError", async () => {
    const bad = new HttpClient({
      userAgent: "t",
      fetchImpl: (async () => new Response("no", { status: 403 })) as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    const err = (await bad.json("https://x.test/b?api_key=SECRET").catch((e) => e)) as HttpError;
    expect(err.url).not.toContain("SECRET");
    expect(JSON.stringify(err)).not.toContain("SECRET");
  });

  it("caps Retry-After and times out slow bodies", async () => {
    const sleeps: number[] = [];
    let n = 0;
    const fetchImpl = async () =>
      ++n === 1
        ? new Response("x", { status: 503, headers: { "retry-after": "86400" } })
        : new Response("{}");
    await new HttpClient({
      userAgent: "t",
      fetchImpl: fetchImpl as typeof fetch,
      sleep: async (ms) => void sleeps.push(ms),
      minIntervalMs: 0,
    }).json("https://x.test/");
    expect(sleeps).toEqual([60_000]);

    const slowBody = (async (_u: string, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(c) {
            init.signal?.addEventListener("abort", () => c.error(new Error("aborted")));
          },
        }),
      )) as unknown as typeof fetch;
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: slowBody,
      sleep: noSleep,
      minIntervalMs: 0,
      timeoutMs: 20,
      maxRetries: 0,
    });
    await expect(http.json("https://x.test/slow")).rejects.toThrow();
  });

  it("marks a Texas run complete only when it reached the last page, and keeps data when a page fails", async () => {
    const lines = fx("tx-esbd.synthetic.json");
    const ok = new HttpClient({
      userAgent: "t",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ lines, page: 1, recordsPerPage: 24, totalRecordsFound: 2 }),
        )) as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    expect((await new TxEsbdConnector({ http: ok, now: () => AT }).fetch()).complete).toBe(true);
    expect((await new TxEsbdConnector({ http: ok, now: () => AT }).fetch({ maxRecords: 1 })).complete).toBe(
      false,
    );

    let page = 0;
    const full = Array.from({ length: 24 }, (_, i) => ({ ...lines[0], internalid: String(1000 + i) }));
    const flaky = new HttpClient({
      userAgent: "t",
      fetchImpl: (async () =>
        ++page === 1
          ? new Response(JSON.stringify({ lines: full, page: 1, recordsPerPage: 24, totalRecordsFound: 48 }))
          : new Response("<html>maintenance</html>")) as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
      maxRetries: 0,
    });
    const run = await new TxEsbdConnector({ http: flaky, now: () => AT }).fetch();
    expect(run.opportunities).toHaveLength(24);
    expect(run.complete).toBe(false);
    expect(run.rejected[0]?.error).toMatch(/page 2/);
  });

  it("routes Florida public meeting notices to the intel lane", () => {
    const [raw] = fx("fl-mfmp.2026-10-15.verbatim.json");
    expect(normalizeFlAd({ ...raw, type: "Public Meeting Notice" }, AT).kind).toBe("informational");
  });

  it("validates OpenFEMA inputs and accepts lower-case states", async () => {
    const urls: string[] = [];
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: (async (u: string) => (
        urls.push(u),
        new Response(JSON.stringify({ DisasterDeclarationsSummaries: fx("openfema.verbatim.json") }))
      )) as unknown as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    const s = await fetchDisasterSignals(http, "fl", "2026-01-01T00:00:00Z");
    expect(s).toHaveLength(2);
    expect(new URL(urls[0]!).searchParams.get("$filter")).toContain("state eq 'FL'");
    await expect(fetchDisasterSignals(http, "Florida", "2026-01-01")).rejects.toThrow(/Invalid state/);
    await expect(fetchDisasterSignals(http, "FL", "2026-01-01' or 1 eq 1")).rejects.toThrow(/Invalid since/);
  });
});

describe("empty responses", () => {
  it("never report a complete run", async () => {
    const http = new HttpClient({
      userAgent: "t",
      fetchImpl: (async () =>
        new Response(
          JSON.stringify({ lines: [], page: 1, recordsPerPage: 24, totalRecordsFound: 0 }),
        )) as typeof fetch,
      sleep: noSleep,
      minIntervalMs: 0,
    });
    expect((await new TxEsbdConnector({ http, now: () => AT }).fetch()).complete).toBe(false);
    const fl = await new FlMfmpConnector({
      transport: { searchAds: async () => [], getDetail: async () => null },
      now: () => AT,
    }).fetch();
    expect(fl.complete).toBe(false);
  });
});

describe("Florida detail enrichment", () => {
  const detail = fx("fl-mfmp-detail.2026-10-15.verbatim.json");
  const listRow = {
    advertisementId: 16313,
    uniqueName: "RFP-16313",
    agencyAdNumber: "RFP DLA-2026.04",
    type: "Request for Proposals",
    title: "Compensation Analysis and Market Pay Study",
    openDate: "2026-06-19T18:21:59.000+00:00",
    closeDate: "2027-01-31T22:00:00.000+00:00",
    publishDate: "2026-06-19T18:21:59.000+00:00",
    status: "OPEN",
    version: 3,
    organization: { organizationId: 30000013, name: "Department of Legal Affairs (DLA)" },
    agency: "Department of Legal Affairs (DLA)",
  };

  it("adds UNSPSC codes, plain-text description, contact and original document names from the live detail", () => {
    const o = normalizeFlAd(listRow, AT, detail);
    expect(o.codes.map((c) => c.code)).toEqual(["80101500", "80101505", "80101511", "80141500"]);
    expect(o.codes[0]).toMatchObject({
      system: "UNSPSC",
      description: "Business and corporate management consultation services",
    });
    expect(o.description).toMatch(/^The purpose of this Request for Proposal/);
    expect(o.description).not.toMatch(/<p>|&nbsp;/);
    expect(o.contact).toEqual({
      name: "Jeri Roberts",
      email: "Jeri.Roberts@myfloridalegal.com",
      phone: "(850) 414-3417",
    });
    expect(o.documents.map((d) => d.filename)).toEqual([
      "DLA-RFP DLA 2026.04 CA Mrkt Pay.pdf",
      "Final DLA RFP 2026.04 Addendum 1.pdf",
      "Notice of Intent to Award RFP DLA 2026.04.pdf",
    ]);
    expect(o.documents[0]!.url).toBe(
      "https://vendor.myfloridamarketplace.com/mfmp/bids/detail/attachment/download?attachmentId=38446",
    );
    expect(o.hasAddendum).toBe(true);
  });

  it("marks an ad awarded when the agency has posted an intent to award, even though the portal still says OPEN", () => {
    expect(normalizeFlAd(listRow, AT, detail).status).toBe("awarded");
    const withoutAward = { ...detail, docs: detail.docs.slice(0, 2) };
    expect(normalizeFlAd(listRow, AT, withoutAward).status).toBe("open");
  });

  it("changes the content hash when a new document is posted", () => {
    const a = normalizeFlAd(listRow, AT, { ...detail, docs: detail.docs.slice(0, 1) });
    const b = normalizeFlAd(listRow, AT, { ...detail, docs: detail.docs.slice(0, 2) });
    expect(a.provenance.contentHash).not.toBe(b.provenance.contentHash);
  });

  it("calls the public JSON endpoints with Accept: application/json, and fetches details only for biddable ads", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (url.includes("/detail")) return new Response(JSON.stringify(detail));
      return new Response(
        JSON.stringify([
          listRow,
          { ...listRow, advertisementId: 17068, uniqueName: "AD-17068", type: "Agency Decision" },
        ]),
      );
    }) as unknown as typeof fetch;
    const http = new HttpClient({ userAgent: "t", fetchImpl, sleep: noSleep, minIntervalMs: 0 });
    const run = await new FlMfmpConnector({ transport: new HttpFlTransport(http), now: () => AT }).fetch();
    expect(calls[0]!.init.method).toBe("POST");
    expect(JSON.parse(calls[0]!.init.body as string)).toMatchObject({
      status: ["OPEN", "PREVIEW"],
      pageSize: 100,
      page: 1,
    });
    expect((calls[0]!.init.headers as Record<string, string>).accept).toBe("application/json");
    expect(calls.filter((c) => c.url.includes("/detail"))).toHaveLength(1);
    expect(run.opportunities.map((o) => o.kind)).toEqual(["rfp", "award_decision"]);
    expect(run.complete).toBe(true);
  });

  it("keeps the list record when a detail request fails", async () => {
    const transport = {
      searchAds: async () => [listRow],
      getDetail: async () => Promise.reject(new Error("timeout")),
    };
    const run = await new FlMfmpConnector({ transport, now: () => AT }).fetch();
    expect(run.opportunities).toHaveLength(1);
    expect(run.opportunities[0]!.codes).toEqual([]);
    expect(run.rejected[0]).toMatchObject({ sourceRecordId: "16313" });
  });
});

describe("Florida review fixes", () => {
  const detail = fx("fl-mfmp-detail.2026-10-15.verbatim.json");
  const row = {
    advertisementId: 16313,
    uniqueName: "RFP-16313",
    type: "Request for Proposals",
    title: "Compensation Analysis and Market Pay Study",
    openDate: "2026-06-19T18:21:59.000+00:00",
    closeDate: "2027-01-31T22:00:00.000+00:00",
    status: "OPEN",
    version: 3,
    organization: { name: "Department of Legal Affairs (DLA)" },
  };

  it("ignores award-related boilerplate posted with the solicitation", () => {
    const boiler = {
      ...detail,
      docs: [
        {
          attachmentId: 1,
          fileName: "Protest procedures after Notice of Intent to Award.pdf",
          description: "Procedures",
          date: "2026-08-01T00:00:00.000+00:00",
        },
        {
          attachmentId: 2,
          fileName: "Notice of Intent to Award.pdf",
          description: "Intent to Award",
          date: "2026-06-19T18:30:00.000+00:00",
        },
      ],
    };
    expect(normalizeFlAd(row, AT, boiler).status).toBe("open");
  });

  it("is not complete when a list row fails to parse, and reports details it could not fetch as partial", async () => {
    const transport = {
      searchAds: async () => [row, { advertisementId: "bad" }],
      getDetail: async () => detail,
    };
    expect((await new FlMfmpConnector({ transport, now: () => AT }).fetch()).complete).toBe(false);
    const flaky = {
      searchAds: async () => [row],
      getDetail: async () => Promise.reject(new Error("timeout")),
    };
    const run = await new FlMfmpConnector({ transport: flaky, now: () => AT }).fetch();
    expect(run.complete).toBe(true);
    expect(run.partialIds).toEqual(["fl-mfmp:16313"]);
  });
});

describe("Florida content hash", () => {
  it("ignores the live countdown and per-viewer flags in the detail, but not real changes", () => {
    const [itn] = fx("fl-mfmp.synthetic.json");
    const detail = fx("fl-mfmp-detail.2026-10-15.verbatim.json");
    const h = (d: object) => normalizeFlAd(itn, AT, d).provenance.contentHash;
    const base = h({ ...detail, timeRemaining: "44 days 1 hour", favorite: false });
    expect(h({ ...detail, timeRemaining: "44 days 0 hours", favorite: true, editable: false })).toBe(base);
    expect(h({ ...detail, description: "Revised scope", timeRemaining: "1 day" })).not.toBe(base);
  });
});
