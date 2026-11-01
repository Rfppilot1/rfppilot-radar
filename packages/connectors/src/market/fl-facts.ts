import { parse } from "node-html-parser";
import type { HttpClient } from "../http.js";
import { contentHash } from "../util.js";
import { formFields } from "../vendorlink.js";
import type { MarketCapture, MarketRun, MarketWindow, StateContract } from "@radar/core";

/**
 * FACTS, the Florida Accountability Contract Tracking System (Department of Financial Services). Public, no key,
 * no API: an ASP.NET search form with a CSV export. Terms of use (Search/SearchTerms.aspx) place no limit on
 * automated access, and the site has no robots.txt. Checked Nov 1, 2026.
 *
 * Flow per agency and kind, verified live (fixture fl-facts-contracts.2026-11-01.excerpt.csv is a verbatim excerpt):
 *   1. GET the search page; it sets the ASP.NET session cookie and carries the form state (__VIEWSTATE etc).
 *   2. POST the form with the agency code, a Begin Date lower bound and the kind (contracts, grants or POs).
 *   3. POST the results page's form back with __EVENTTARGET = the export link: the reply is the whole result as
 *      CSV. Without the session cookie the export returns the search page instead, so the client keeps cookies.
 *
 * FACTS has no "changed since" filter, so each run re-reads every agreement that began on or after `beginSince`
 * and the store keeps only rows whose content changed. Runs weekly (FL_FACTS_INTERVAL_DAYS in the worker).
 */
export const FACTS_BASE = "https://facts.fldfs.com";
export const FACTS_SEARCH = `${FACTS_BASE}/Search/ContractSearch.aspx`;

const AGENCY_FIELD = "ctl00$PC$ddlAgency";
const BEGIN_FIELD = "ctl00$PC$txtBeginDate";
const OPTION_FIELD = "ctl00$PC$rblSrchOption";
const EXPORT_TARGET = "ctl00$PC$hlkExport";

/**
 * Agencies collected by default: emergency management (the Division of Emergency Management sits under the
 * Executive Office of the Governor), environment, transportation, management services, commerce, agriculture
 * (forestry), military affairs and health. FL_FACTS_AGENCIES overrides.
 */
export const DEFAULT_FACTS_AGENCIES = [
  "310000",
  "370000",
  "550000",
  "720000",
  "400000",
  "420000",
  "620000",
  "640000",
];

/** The agency dropdown: code → name. "ALL AGENCIES" (no code) is left out. */
export function agencyOptions(html: string): Map<string, string> {
  const root = parse(html);
  const sel = root.querySelector(`select[name="${AGENCY_FIELD}"]`);
  const out = new Map<string, string>();
  for (const o of sel?.querySelectorAll("option") ?? []) {
    const code = (o.getAttribute("value") ?? "").trim();
    if (/^\d{6}$/.test(code)) out.set(code, o.text.replace(/\s+/g, " ").trim());
  }
  return out;
}

/** RFC 4180 CSV (quoted fields may hold commas, doubled quotes and line breaks), lenient about stray quotes. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        const next = text[i + 1];
        if (next === '"') {
          field += '"';
          i++;
        } else if (next === undefined || next === "," || next === "\r" || next === "\n") quoted = false;
        // FACTS does not escape quotes typed into free-text fields ('...systems." ",'): a quote that is not
        // followed by a separator is part of the text.
        else field += c;
      } else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") {
      row.push(field);
      field = "";
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += c;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows.filter((r) => !(r.length === 1 && r[0] === ""));
}

const clean = (s: string | undefined) => {
  const t = (s ?? "").replace(/\s+/g, " ").trim();
  return t ? t : null;
};

const money = (s: string | undefined) => {
  const t = (s ?? "").replace(/[$,\s]/g, "");
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) ? n : null;
};

/**
 * M/D/YYYY → YYYY-MM-DD. FACTS holds typed-in dates with typos (7/1/2107, 9/9/9999); a year outside 1980–2075
 * is treated as unknown rather than stored as a date that would skew expiry views.
 */
export function factsDate(s: string | undefined): string | null {
  const m = /^\s*(\d{1,2})\/(\d{1,2})\/(\d{4})\s*$/.exec(s ?? "");
  if (!m) return null;
  const [mo, d, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 1980 || y > 2075 || mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCMonth() !== mo - 1) return null;
  return date.toISOString().slice(0, 10);
}

/** Header names in the export, read by name so a reordered or widened export still parses. */
const COL = {
  agency: "Agency Name",
  vendor: "Vendor/Grantor Name",
  vendor2: "Vendor/Grantor Name Line 2",
  type: "Type",
  contractId: "Agency Contract ID",
  po: "PO Number",
  grant: "Grant Award ID",
  original: "Original Contract Amount",
  total: "Total Amount",
  poBudget: "PO Budget Amount",
  commodityCode: "Commodity/Service Type Code",
  commodity: "Commodity/Service Type Description",
  title: "Long Title/PO Title",
  status: "Status",
  flair: "FLAIR Contract ID",
  shortTitle: "Short Title",
  begin: "Begin Date",
  originalEnd: "Original End Date",
  newEnd: "New End Date",
  executed: "Contract Execution Date",
  grantDate: "Grant Award Date",
  poDate: "PO Order Date",
  serviceArea: "Agency Service Area",
  method: "Method of Procurement",
  stateTerm: "State Term Contract ID",
  reference: "Agency Reference Number",
  recipientType: "Recipient Type",
  cfda: "CFDA Code",
  csfa: "CSFA Code",
} as const;

const REQUIRED = [COL.agency, COL.vendor, COL.type, COL.contractId, COL.po, COL.grant, COL.total];

/** Rows of a FACTS export as header → value records. Throws if the export's shape changed. */
export function factsRecords(csv: string): Record<string, string>[] {
  const rows = parseCsv(csv.replace(/^﻿/, ""));
  const header = rows.shift()?.map((h) => h.trim()) ?? [];
  const missing = REQUIRED.filter((c) => !header.includes(c));
  if (missing.length) throw new Error(`FACTS export is missing columns: ${missing.join(", ")}`);
  return rows.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""])));
}

export function normalizeFactsRow(r: Record<string, string>): StateContract {
  const agency = clean(r[COL.agency]);
  const vendor = clean([r[COL.vendor], r[COL.vendor2]].join(" "));
  if (!agency) throw new Error("FACTS row has no agency");
  const contractId = clean(r[COL.contractId]);
  const poNumber = clean(r[COL.po]);
  const grantAwardId = clean(r[COL.grant]);
  const id = contractId ?? poNumber ?? grantAwardId;
  if (!id) throw new Error("FACTS row has no contract, PO or grant id");
  const type = clean(r[COL.type]);
  const isPo = !contractId && !grantAwardId && Boolean(poNumber);
  const c: Omit<StateContract, "contentHash"> = {
    key: ["FL", agency, type ?? "", id].join("|"),
    state: "FL",
    agency,
    vendor,
    type,
    contractId,
    poNumber,
    grantAwardId,
    flairContractId: clean(r[COL.flair]),
    title: clean(r[COL.title]),
    shortTitle: clean(r[COL.shortTitle]),
    status: clean(r[COL.status]),
    originalAmount: money(r[COL.original]),
    totalAmount: money(r[COL.total]) ?? (isPo ? money(r[COL.poBudget]) : null),
    // The agreement's stated total (with amendments), not money paid out.
    amountType: "award_fixed",
    commodityCode: clean(r[COL.commodityCode]),
    commodityDescription: clean(r[COL.commodity]),
    procurementMethod: clean(r[COL.method]),
    stateTermContractId: clean(r[COL.stateTerm]),
    agencyReference: clean(r[COL.reference]),
    serviceArea: clean(r[COL.serviceArea]),
    beginDate: factsDate(r[COL.begin]) ?? factsDate(r[COL.grantDate]) ?? factsDate(r[COL.poDate]),
    originalEndDate: factsDate(r[COL.originalEnd]),
    newEndDate: factsDate(r[COL.newEnd]),
    executedDate: factsDate(r[COL.executed]),
    recipientType: clean(r[COL.recipientType]),
    cfda: clean(r[COL.cfda]),
    csfa: clean(r[COL.csfa]),
    sourceUrl: FACTS_SEARCH,
  };
  return { ...c, contentHash: contentHash(c) };
}

/** MM/DD/YYYY for the search form, from an ISO date. */
const formDate = (iso: string) => {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCMonth() + 1)}/${p(d.getUTCDate())}/${d.getUTCFullYear()}`;
};

/**
 * What each search returns: FACTS splits agreements into contracts (Agency Contract ID), grants (Grant Award ID)
 * and purchase orders (PO Number), with no overlap (checked Nov 1, 2026 on the Governor's office since FY24:
 * 5,768 + 147 + 749 = the 6,664 "Show All" rows). Purchase orders are most of the volume (89% of the Department of
 * Environmental Protection's rows) and are mostly small one-off buys, so they are off by default.
 */
export type FactsKind = "contracts" | "grants" | "purchase-orders";
const KIND_OPTION: Record<FactsKind, string> = { contracts: "C", grants: "G", "purchase-orders": "P" };
export const DEFAULT_FACTS_KINDS: FactsKind[] = ["contracts", "grants"];

export interface FlFactsOptions {
  http: HttpClient;
  /** Agency codes to collect (six digits, from the search page's dropdown). */
  agencies?: string[];
  kinds?: FactsKind[];
  /** Agreements that began on or after this date are read on every run. */
  beginSince: string;
  now?: () => string;
}

export class FlFactsCollector {
  readonly id = "fl-facts" as const;
  constructor(private readonly opts: FlFactsOptions) {}

  /** The window is recorded but not used to filter: FACTS has no change date, so every run re-reads. */
  async fetch(window: MarketWindow): Promise<MarketRun<StateContract>> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    const fetchedAt = now();
    const run: MarketRun<StateContract> = {
      source: this.id,
      records: [],
      captures: [],
      rejected: [],
      fetchedAt,
      window: { since: window.since, until: window.until ?? fetchedAt },
      complete: true,
      notes: [],
    };
    const first = await this.opts.http.text(FACTS_SEARCH);
    const known = agencyOptions(first);
    const agencies = this.opts.agencies ?? DEFAULT_FACTS_AGENCIES;
    const begin = formDate(this.opts.beginSince);
    const seen = new Map<string, string>();
    const kinds = this.opts.kinds ?? DEFAULT_FACTS_KINDS;
    for (const code of agencies) {
      if (!known.has(code)) {
        run.complete = false;
        run.notes.push(`agency ${code} is not in the FACTS agency list; skipped`);
        continue;
      }
      for (const kind of kinds) await this.collect(run, code, known.get(code)!, kind, begin, seen, now);
    }
    return run;
  }

  private async collect(
    run: MarketRun<StateContract>,
    code: string,
    name: string,
    kind: FactsKind,
    begin: string,
    seen: Map<string, string>,
    now: () => string,
  ): Promise<void> {
    {
      try {
        const csv = await this.exportAgency(code, begin, KIND_OPTION[kind]);
        const request = { agency: code, agencyName: name, beginDate: begin, kind };
        run.captures.push({
          source: this.id,
          url: FACTS_SEARCH,
          request,
          retrievedAt: now(),
          body: csv,
        } satisfies MarketCapture);
        const captureIndex = run.captures.length - 1;
        let n = 0;
        for (const row of factsRecords(csv)) {
          try {
            const c = normalizeFactsRow(row);
            const key = unique(seen, c);
            if (key === null) continue;
            run.records.push({ ...c, key, captureIndex });
            n++;
          } catch (err) {
            run.rejected.push({
              sourceRecordId: row[COL.contractId] || row[COL.po] || row[COL.grant] || null,
              error: (err as Error).message.slice(0, 300),
            });
          }
        }
        run.notes.push(`${name} ${kind}: ${n} rows`);
      } catch (err) {
        // One search failing (timeout, oversized export) does not lose the others; the run is marked incomplete.
        run.complete = false;
        run.notes.push(`${name} (${code}) ${kind}: ${(err as Error).message.slice(0, 200)}`);
      }
    }
  }

  /** Search one agency, then export the result. A fresh page per agency keeps the form state consistent. */
  private async exportAgency(code: string, begin: string, option: string): Promise<string> {
    const http = this.opts.http;
    const page = await http.text(FACTS_SEARCH);
    if (!page.includes(AGENCY_FIELD)) throw new Error("search page has no agency list (site changed?)");
    const search = formFields(page);
    search.set(AGENCY_FIELD, code);
    search.set(BEGIN_FIELD, begin);
    search.set(OPTION_FIELD, option);
    search.set("__EVENTTARGET", "");
    search.set("__EVENTARGUMENT", "");
    search.append("ctl00$PC$btnSearch", "Search");
    const results = await http.text(FACTS_SEARCH, form(search));
    const exp = formFields(results);
    exp.set("__EVENTTARGET", EXPORT_TARGET);
    exp.set("__EVENTARGUMENT", "");
    const csv = await http.text(FACTS_SEARCH, form(exp));
    if (!csv.trimStart().startsWith("Agency Name"))
      throw new Error("export did not return CSV (session lost or form changed)");
    return csv;
  }
}

/**
 * A few agreements share agency, type and id (4 of 20,077 in the Executive Office of the Governor's export); the
 * FLAIR id, then the row's order, tells them apart so one run never writes the same key twice. The same row seen
 * again (one agreement returned by two searches) is dropped.
 */
function unique(seen: Map<string, string>, c: StateContract): string | null {
  let key = c.key;
  if (seen.get(key) === c.contentHash) return null;
  if (seen.has(key) && c.flairContractId) key = `${c.key}|${c.flairContractId}`;
  if (seen.get(key) === c.contentHash) return null;
  for (let i = 2; seen.has(key); i++) key = `${c.key}|${i}`;
  seen.set(key, c.contentHash);
  return key;
}

const form = (body: URLSearchParams): RequestInit => ({
  method: "POST",
  body: body.toString(),
  headers: { "content-type": "application/x-www-form-urlencoded", referer: FACTS_SEARCH },
});
