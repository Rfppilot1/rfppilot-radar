import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  FACTS_SEARCH,
  FlFactsCollector,
  HttpClient,
  agencyOptions,
  factsDate,
  factsRecords,
  normalizeFactsRow,
  parseCsv,
} from "../src/index.js";

const CSV = readFileSync(
  new URL("./fixtures/fl-facts-contracts.2026-11-01.excerpt.csv", import.meta.url),
  "utf8",
);
const AT = "2026-11-01T15:00:00.000Z";

/**
 * A cut-down search page with the live form's field names (checked Nov 1, 2026). The live page's __VIEWSTATE is
 * ~13 KB; its value does not matter to the collector, only that it is sent back.
 */
const page = (state: string, agency = "") => `<html><body><form method="post" action="./ContractSearch.aspx">
<input type="hidden" name="__EVENTTARGET" value="" />
<input type="hidden" name="__EVENTARGUMENT" value="" />
<input type="hidden" name="__VIEWSTATE" value="${state}" />
<input type="hidden" name="__EVENTVALIDATION" value="ev-${state}" />
<select name="ctl00$PC$ddlAgency">
  <option ${agency ? "" : 'selected="selected" '}value="">ALL AGENCIES</option>
  <option ${agency === "310000" ? 'selected="selected" ' : ""}value="310000">EXECUTIVE OFFICE OF THE GOVERNOR</option>
  <option ${agency === "370000" ? 'selected="selected" ' : ""}value="370000">DEPARTMENT OF ENVIRONMENTAL PROTECTION</option>
</select>
<input type="text" name="ctl00$PC$txtVendorName" value="" />
<input type="text" name="ctl00$PC$txtBeginDate" value="" />
<input type="radio" name="ctl00$PC$rblSrchOption" value="" checked="checked" />
<input type="radio" name="ctl00$PC$rblSrchOption" value="G" />
<input type="radio" name="ctl00$PC$rblSrchOption" value="C" />
<input type="radio" name="ctl00$PC$rblSrchOption" value="P" />
<input type="submit" name="ctl00$PC$btnReset" value="Reset" />
<input type="submit" name="ctl00$PC$btnSearch" value="Search" />
</form></body></html>`;

describe("FACTS export parsing", () => {
  it("reads quoted CSV with commas, doubled quotes, line breaks and FACTS's unescaped quotes", () => {
    expect(parseCsv('a,b\r\n"x, y","say ""hi""\nthere"\r\n"glass." ","z"')).toEqual([
      ["a", "b"],
      ["x, y", 'say "hi"\nthere'],
      ['glass." ', "z"],
    ]);
  });

  it("parses the verbatim export excerpt by column name", () => {
    const rows = factsRecords(CSV);
    expect(rows).toHaveLength(30);
    expect(Object.keys(rows[0]!)).toHaveLength(52);
  });

  it("normalizes an emergency procurement under an executive order", () => {
    const c = normalizeFactsRow(factsRecords(CSV)[4]!);
    expect(c).toMatchObject({
      key: "FL|EXECUTIVE OFFICE OF THE GOVERNOR|Memorandum of Agreement/Understanding or Interagency Agreement|E6108",
      state: "FL",
      agency: "EXECUTIVE OFFICE OF THE GOVERNOR",
      contractId: "E6108",
      poNumber: null,
      status: "Active",
      originalAmount: 1751680.15,
      totalAmount: 1751680.15,
      amountType: "award_fixed",
      commodityCode: "93131800",
      commodityDescription: "Disaster preparedness and relief",
      beginDate: "2025-10-30",
      executedDate: "2025-09-22",
      recipientType: expect.stringMatching(/^FOR PROFIT/),
      sourceUrl: FACTS_SEARCH,
    });
    expect(c.vendor).toMatch(/^GARNER ENVIRONMENTAL SERVICES,/);
    expect(c.procurementMethod).toMatch(/^Emergency procurement per Executive Order/);
  });

  it("treats typo dates as unknown instead of storing them", () => {
    expect(factsDate("7/1/2107")).toBeNull();
    expect(factsDate("9/9/9999")).toBeNull();
    expect(factsDate("2/30/2025")).toBeNull();
    expect(factsDate("6/30/2018")).toBe("2018-06-30");
    const pasco = normalizeFactsRow(factsRecords(CSV)[0]!);
    expect(pasco).toMatchObject({ beginDate: null, originalEndDate: "2018-06-30", newEndDate: "2018-08-31" });
    expect(pasco.vendor).toBe("PASCO COUNTY BOCC");
    expect(pasco.cfda).toBe("97.042");
  });

  it("changes the hash only when the content changes", () => {
    const row = factsRecords(CSV)[4]!;
    const a = normalizeFactsRow(row);
    expect(normalizeFactsRow({ ...row }).contentHash).toBe(a.contentHash);
    expect(normalizeFactsRow({ ...row, "Total Amount": "1800000.00" }).contentHash).not.toBe(a.contentHash);
  });

  it("refuses an export whose columns changed", () => {
    expect(() => factsRecords("Agency Name,Vendor\r\nX,Y\r\n")).toThrow(/missing columns/);
  });

  it("lists agency codes from the dropdown", () => {
    expect([...agencyOptions(page("s"))]).toEqual([
      ["310000", "EXECUTIVE OFFICE OF THE GOVERNOR"],
      ["370000", "DEPARTMENT OF ENVIRONMENTAL PROTECTION"],
    ]);
  });
});

describe("FACTS collector", () => {
  /** Fake FACTS: the export works only with the session cookie set on the first visit. */
  function site() {
    const posts: URLSearchParams[] = [];
    let visits = 0;
    let lastKind = "";
    const fetchImpl = async (url: string, init?: RequestInit) => {
      expect(url).toBe(FACTS_SEARCH);
      const cookie = new Headers(init?.headers).get("cookie") ?? "";
      if (!init?.method || init.method === "GET") {
        visits++;
        const headers = new Headers({ "content-type": "text/html" });
        if (!cookie) headers.append("set-cookie", "ASP.NET_SessionId=abc123; path=/; HttpOnly");
        return new Response(page(`get${visits}`), { headers });
      }
      const body = new URLSearchParams(String(init.body));
      posts.push(body);
      if (body.get("__EVENTTARGET") === "ctl00$PC$hlkExport") {
        if (!cookie.includes("ASP.NET_SessionId=abc123")) return new Response(page("lost"));
        if (body.get("ctl00$PC$ddlAgency") === "370000") return new Response("Server Error", { status: 404 });
        // The excerpt holds contracts; the grants search returns just the header.
        const kind = lastKind;
        const csv = kind === "C" ? CSV : CSV.split("\r\n")[0] + "\r\n";
        return new Response(csv, { headers: { "content-type": "text/csv" } });
      }
      const agency = body.get("ctl00$PC$ddlAgency") ?? "";
      lastKind = body.get("ctl00$PC$rblSrchOption") ?? "";
      return new Response(page(`results-${agency}`, agency));
    };
    return { posts, fetchImpl: fetchImpl as unknown as typeof fetch };
  }
  const client = (fetchImpl: typeof fetch, cookies = true) =>
    new HttpClient({ userAgent: "t", minIntervalMs: 0, maxRetries: 0, fetchImpl, cookies });

  it("searches, exports with the session cookie, and keeps one capture per agency", async () => {
    const s = site();
    const run = await new FlFactsCollector({
      http: client(s.fetchImpl),
      agencies: ["310000"],
      beginSince: "2023-10-01T00:00:00.000Z",
      now: () => AT,
    }).fetch({ since: "2023-10-01T00:00:00.000Z", until: AT });
    expect(run.notes).toEqual([
      "EXECUTIVE OFFICE OF THE GOVERNOR contracts: 30 rows",
      "EXECUTIVE OFFICE OF THE GOVERNOR grants: 0 rows",
    ]);
    expect(run.complete).toBe(true);
    expect(run.records).toHaveLength(30);
    expect(run.captures).toHaveLength(2);
    expect(run.captures.map((c) => c.request)).toMatchObject([
      { agency: "310000", beginDate: "10/01/2023", kind: "contracts" },
      { agency: "310000", beginDate: "10/01/2023", kind: "grants" },
    ]);
    expect(run.records.every((r) => r.captureIndex === 0)).toBe(true);
    const [search, exp] = s.posts;
    expect(search!.get("ctl00$PC$ddlAgency")).toBe("310000");
    expect(search!.get("ctl00$PC$txtBeginDate")).toBe("10/01/2023");
    expect(search!.get("ctl00$PC$rblSrchOption")).toBe("C");
    expect(s.posts[2]!.get("ctl00$PC$rblSrchOption")).toBe("G");
    expect(search!.get("ctl00$PC$btnSearch")).toBe("Search");
    expect(search!.has("ctl00$PC$btnReset")).toBe(false);
    // The export posts back the results page's own state, not the search page's.
    expect(exp!.get("__VIEWSTATE")).toBe("results-310000");
    expect(exp!.has("ctl00$PC$btnSearch")).toBe(false);
  });

  it("fails an agency cleanly without the session, and keeps going after one agency fails", async () => {
    const lost = await new FlFactsCollector({
      http: client(site().fetchImpl, false),
      agencies: ["310000"],
      beginSince: "2023-10-01T00:00:00.000Z",
    }).fetch({ since: "2023-10-01T00:00:00.000Z" });
    expect(lost.complete).toBe(false);
    expect(lost.notes.join(" ")).toMatch(/did not return CSV/);

    const mixed = await new FlFactsCollector({
      http: client(site().fetchImpl),
      agencies: ["370000", "999999", "310000"],
      beginSince: "2023-10-01T00:00:00.000Z",
    }).fetch({ since: "2023-10-01T00:00:00.000Z" });
    expect(mixed.complete).toBe(false);
    expect(mixed.records).toHaveLength(30);
    expect(mixed.notes.join(" ")).toMatch(/999999 is not in the FACTS agency list/);
    expect(mixed.notes.join(" ")).toMatch(/ENVIRONMENTAL PROTECTION \(370000\) contracts: HTTP 404/);
  });

  it("gives repeated agency/type/id rows distinct keys and drops exact repeats", async () => {
    const garner = CSV.split("\r\n")[5]!;
    const dup = CSV + garner + "\r\n" + garner.replace('"1751680.15","1751680.15"', '"1.00","2.00"') + "\r\n";
    const s = site();
    const fetchImpl = (async (u: string, init?: RequestInit) => {
      const r = await s.fetchImpl(u, init);
      return r.headers.get("content-type") === "text/csv" ? new Response(dup) : r;
    }) as unknown as typeof fetch;
    const run = await new FlFactsCollector({
      http: client(fetchImpl),
      agencies: ["310000"],
      beginSince: "2023-10-01T00:00:00.000Z",
    }).fetch({ since: "2023-10-01T00:00:00.000Z" });
    const keys = run.records.map((r) => r.key);
    expect(keys).toHaveLength(31);
    expect(new Set(keys).size).toBe(31);
    expect(keys.at(-1)).toMatch(/\|E6108\|E6108$/);
  });
});

describe("HTTP client cookies", () => {
  it("sends cookies back only when enabled, per host, and drops expired ones", async () => {
    const seen: string[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      seen.push(`${new URL(url).host}:${new Headers(init?.headers).get("cookie") ?? ""}`);
      const h = new Headers();
      if (url.endsWith("/set")) h.append("set-cookie", "a=1; Path=/");
      if (url.endsWith("/set")) h.append("set-cookie", "b=2; Path=/");
      if (url.endsWith("/expire")) h.append("set-cookie", "a=; Max-Age=0");
      return new Response("ok", { headers: h });
    }) as unknown as typeof fetch;
    const on = new HttpClient({ userAgent: "t", minIntervalMs: 0, fetchImpl, cookies: true });
    await on.text("https://x.test/set");
    await on.text("https://x.test/next");
    await on.text("https://y.test/other");
    await on.text("https://x.test/expire");
    await on.text("https://x.test/after");
    const off = new HttpClient({ userAgent: "t", minIntervalMs: 0, fetchImpl });
    await off.text("https://x.test/set");
    await off.text("https://x.test/next");
    expect(seen).toEqual([
      "x.test:",
      "x.test:a=1; b=2",
      "y.test:",
      "x.test:a=1; b=2",
      "x.test:b=2",
      "x.test:",
      "x.test:",
    ]);
  });
});
