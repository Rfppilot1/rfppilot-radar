import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  FlMfmpConnector,
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
    const transport = { searchAds: vi.fn(async () => fx("fl-mfmp.synthetic.json")) };
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
    expect(q.getAll("ptype")).toEqual(["o", "k", "p", "r"]);
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
    const fl = await new FlMfmpConnector({ transport: { searchAds: async () => [] }, now: () => AT }).fetch();
    expect(fl.complete).toBe(false);
  });
});
