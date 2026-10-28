import { Opportunity, type KeyDate, type NoticeKind } from "@radar/core";
import { parse, type HTMLElement } from "node-html-parser";
import type { HttpClient } from "./http.js";
import {
  kindFromText,
  opportunityId,
  type ConnectorRun,
  type FetchWindow,
  type SourceConnector,
} from "./types.js";
import { clean, contentHash, zonedToUtcIso } from "./util.js";

/**
 * VendorLink public bid lists (ASP.NET WebForms). The shared site, www.myvendorlink.com, hosts about 115 agencies,
 * nearly all in Florida (Brevard County, OUC, Hillsborough, Polk, Manatee, Seminole and Sarasota school districts,
 * Ocala, Kissimmee, St. Cloud and many more); some agencies run their own copy (Osceola County and its school board
 * at vendorlink.osceola.org, Orange County Public Schools at vendorlink.ocps.net).
 *
 * Collection posts the public search form exactly as a browser does, verified without cookies on Oct 28, 2026:
 * GET /external/bids for the form, then POST it back with agency "all", status Active and 100 rows per page, and
 * follow the grid's own pager. No sign-in. See docs/SOURCES.md#vendorlink.
 */
export interface VendorLinkSite {
  host: string;
  /** State of the agencies on this site when they cannot be told apart by name. */
  defaultState: string;
}

export const VENDORLINK_SITES: VendorLinkSite[] = [
  { host: "www.myvendorlink.com", defaultState: "FL" },
  { host: "vendorlink.osceola.org", defaultState: "FL" },
  { host: "vendorlink.ocps.net", defaultState: "FL" },
];

export const VL_TZ = "America/New_York";
const VL_PARSE_VERSION = 1;
const GRID_ID = "ctl00_RegionMiddle_grvSolicitations";
const F = "ctl00$RegionMiddle$";

/** A few agencies on the shared site are outside Florida; their names say so. */
const OTHER_STATES: [RegExp, string][] = [
  [/\bgeorgia\b|,\s*GA\b/i, "GA"],
  [/\bnorth carolina\b|\bhatteras\b|,\s*NC\b/i, "NC"],
  [/\balabama\b|,\s*AL\b/i, "AL"],
  [/\btennessee\b|,\s*TN\b/i, "TN"],
  [/\bsouth carolina\b|,\s*SC\b/i, "SC"],
];

export function stateForAgency(name: string, fallback: string): string {
  for (const [re, st] of OTHER_STATES) if (re.test(name)) return st;
  return fallback;
}

export interface VendorLinkRow {
  agency: string;
  agencyId: string | null;
  number: string | null;
  title: string;
  status: string;
  broadcast: string | null;
  mandatoryPreBid: boolean;
  questionEnd: string | null;
  due: string | null;
}

const text = (el: HTMLElement | undefined | null) => clean(el?.text?.replace(/&amp;/g, "&") ?? null);

/** Reads the solicitation grid. Rows without the nine data cells (the pager row, empty rows) are skipped. */
export function parseVendorLinkGrid(html: string): {
  rows: VendorLinkRow[];
  agencies: Map<string, string>;
  pages: number[];
} {
  const doc = parse(html);
  const agencies = new Map<string, string>();
  for (const o of doc.querySelectorAll(`select[name="${F}ddlAgency"] option`)) {
    const v = o.getAttribute("value");
    const name = text(o);
    if (v && name) agencies.set(name.replace(/\s*\(now on .*\)\s*$/i, ""), v);
  }
  const grid = doc.getElementById(GRID_ID);
  const rows: VendorLinkRow[] = [];
  const pages = new Set<number>();
  if (grid) {
    for (const tr of grid.querySelectorAll("tr")) {
      const tds = tr.querySelectorAll(":scope > td");
      // The pager row holds a nested table of page links.
      for (const a of tr.querySelectorAll("a")) {
        const m = /Page\$(\d+)/.exec(a.getAttribute("href") ?? "");
        if (m) pages.add(Number(m[1]));
      }
      if (tds.length < 9) continue;
      const span = (suffix: string) => text(tr.querySelector(`span[id$="_${suffix}"]`));
      const agency = text(tds[0]) ?? "";
      const title = text(tds[2]);
      if (!agency || !title) continue;
      rows.push({
        agency,
        agencyId: agencies.get(agency) ?? null,
        number: text(tds[1]),
        title,
        status: text(tds[4]) ?? "",
        broadcast: span("lblItemSolicitationBroadcastDate"),
        mandatoryPreBid: tr.querySelector('input[id$="_cbMandatory"]')?.getAttribute("checked") != null,
        questionEnd: span("lblItemSolicitationQuestionEndDate"),
        due: span("lblItemSolicitationDueDate"),
      });
    }
  }
  return { rows, agencies, pages: [...pages].sort((a, b) => a - b) };
}

/** The form's current field values, as a browser would post them (no buttons, only checked boxes). */
export function formFields(html: string): URLSearchParams {
  const doc = parse(html);
  const form = doc.querySelector("form");
  const p = new URLSearchParams();
  if (!form) return p;
  for (const el of form.querySelectorAll("input, select, textarea")) {
    const name = el.getAttribute("name");
    if (!name) continue;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") ?? "text").toLowerCase();
    if (tag === "input") {
      if (["submit", "button", "image", "file", "reset"].includes(type)) continue;
      if ((type === "checkbox" || type === "radio") && el.getAttribute("checked") == null) continue;
      p.set(name, el.getAttribute("value") ?? (type === "checkbox" ? "on" : ""));
    } else if (tag === "select") {
      const opts = el.querySelectorAll("option");
      const sel = opts.find((o) => o.getAttribute("selected") != null) ?? opts[0];
      p.set(name, sel?.getAttribute("value") ?? "");
    } else {
      p.set(name, el.text ?? "");
    }
  }
  return p;
}

/** "10/22/2026 4:00 PM" in Eastern time to UTC ISO. */
export function vlDate(v: string | null): string | null {
  const m = /^(\d{1,2}\/\d{1,2}\/\d{4})(?:\s+(\d{1,2}:\d{2}\s*[AP]M))?$/i.exec(v?.trim() ?? "");
  return m ? zonedToUtcIso(m[1]!, m[2] ?? null, VL_TZ) : null;
}

function localDate(v: string | null): { date: string; time: string | null } | null {
  const m = /^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s+(\d{1,2}:\d{2}\s*[AP]M))?$/i.exec(v?.trim() ?? "");
  if (!m) return null;
  return { date: `${m[3]}-${m[1]!.padStart(2, "0")}-${m[2]!.padStart(2, "0")}`, time: m[4] ?? null };
}

function kindFor(r: VendorLinkRow): NoticeKind {
  const t = `${r.number ?? ""} ${r.title}`;
  if (/\b(single|sole)[\s/-]*source\b/i.test(t)) return "single_source";
  if (/\bintent to award\b|\bnotice of award\b/i.test(t)) return "award_decision";
  // Standing vendor registrations and prequalification lists (no due date) are not bids.
  if (
    !r.due &&
    /\b(registration|pre-?qualification|prequalified|vendor list|preferred contractor)\b/i.test(t)
  )
    return "informational";
  return kindFromText(r.title, r.number) ?? "other";
}

export function normalizeVendorLink(r: VendorLinkRow, fetchedAt: string, site: VendorLinkSite): Opportunity {
  const agencyKey = r.agencyId ?? r.agency.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  const key = r.number ?? contentHash({ t: r.title, b: r.broadcast }).slice(0, 16);
  const recordId = `${site.host}/${agencyKey}/${key}`;
  const keyDates: KeyDate[] = [];
  const q = localDate(r.questionEnd);
  if (q)
    keyDates.push({
      ...q,
      kind: "questions_due",
      mandatory: null,
      note: `Question end date: ${r.questionEnd}`,
    });
  if (r.mandatoryPreBid)
    keyDates.push({
      kind: "pre_bid",
      date: null,
      time: null,
      mandatory: true,
      note: "The posting flags a mandatory pre-bid meeting.",
    });
  const status = /^active$/i.test(r.status) ? "open" : /cancel/i.test(r.status) ? "cancelled" : "unknown";
  const raw = { ...r };
  return Opportunity.parse({
    id: opportunityId("vendorlink", recordId),
    source: "vendorlink",
    sourceRecordId: recordId,
    solicitationNumber: r.number,
    title: r.title,
    description: null,
    kind: kindFor(r),
    kindLabel: null,
    status,
    buyer: { name: r.agency, id: r.agencyId, level: "local" },
    state: stateForAgency(r.agency, site.defaultState),
    postedAt: vlDate(r.broadcast),
    dueAt: vlDate(r.due),
    dueTimezone: r.due ? VL_TZ : null,
    codes: [],
    setAside: null,
    contact: null,
    documents: [],
    version: null,
    hasAddendum: false,
    keyDates,
    estimatedValue: null,
    provenance: {
      source: "vendorlink",
      // The detail page is session-bound, so the public list filtered to the agency is the stable link.
      sourceUrl: r.agencyId
        ? `https://${site.host}/external/bids?a=${encodeURIComponent(r.agencyId)}`
        : `https://${site.host}/external/bids`,
      fetchedAt,
      contentHash: contentHash({ raw, v: VL_PARSE_VERSION }),
      basis: "vendorlink",
    },
  });
}

export interface VendorLinkConnectorOptions {
  http: HttpClient;
  sites?: VendorLinkSite[];
  now?: () => string;
}

export class VendorLinkConnector implements SourceConnector {
  readonly id = "vendorlink" as const;
  readonly basis = "vendorlink";

  constructor(private readonly opts: VendorLinkConnectorOptions) {}

  private post(url: string, fields: URLSearchParams) {
    return this.opts.http.text(url, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: fields.toString(),
    });
  }

  async fetch(window: FetchWindow = {}): Promise<ConnectorRun> {
    const fetchedAt = this.opts.now?.() ?? new Date().toISOString();
    const run: ConnectorRun = { source: this.id, opportunities: [], rejected: [], fetchedAt, complete: true };
    const max = window.maxRecords ?? 20_000;
    const seen = new Set<string>();
    for (const site of this.opts.sites ?? VENDORLINK_SITES) {
      const url = `https://${site.host}/external/bids`;
      try {
        const form = await this.opts.http.text(url);
        const search = formFields(form);
        search.set(`${F}ddlAgency`, "");
        search.set(`${F}ddlStatus`, "2"); // Active
        search.set(`${F}rblSolicitationPageCount`, "100");
        search.delete(`${F}cbPiggyback`); // agencies' own solicitations, not piggyback contracts
        search.set(`${F}btnSearch`, "Search Bids");
        let html = await this.post(url, search);
        const visited = new Set<number>([1]);
        for (let guard = 0; guard < 50; guard++) {
          const page = parseVendorLinkGrid(html);
          for (const row of page.rows) {
            if (run.opportunities.length >= max) {
              run.complete = false;
              break;
            }
            try {
              const o = normalizeVendorLink(row, fetchedAt, site);
              if (seen.has(o.id)) continue; // the same posting can repeat across pages
              seen.add(o.id);
              run.opportunities.push(o);
            } catch (err) {
              run.rejected.push({
                sourceRecordId: `${site.host}/${row.number ?? row.title}`,
                error: (err as Error).message.slice(0, 300),
              });
            }
          }
          const next = page.pages.find((n) => !visited.has(n));
          if (next === undefined || run.opportunities.length >= max) break;
          visited.add(next);
          const fields = formFields(html);
          fields.set("__EVENTTARGET", `${F}grvSolicitations`);
          fields.set("__EVENTARGUMENT", `Page$${next}`);
          html = await this.post(url, fields);
        }
      } catch (err) {
        run.complete = false;
        run.rejected.push({
          sourceRecordId: site.host,
          error: `site: ${(err as Error).message.slice(0, 280)}`,
        });
      }
    }
    return run;
  }
}
