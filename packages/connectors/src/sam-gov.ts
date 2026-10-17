import { Opportunity, type ClassificationCode, type NoticeKind } from "@radar/core";
import { z } from "zod";
import { HttpError, type HttpClient } from "./http.js";
import {
  kindFromText,
  opportunityId,
  type ConnectorRun,
  type FetchWindow,
  type SourceConnector,
} from "./types.js";
import { clean, contentHash, toIso } from "./util.js";

/**
 * SAM.gov Get Opportunities Public API v2 (GSA). Official, documented API; requires a free public API key.
 * https://open.gsa.gov/api/get-opportunities-public-api/
 */
export const SAM_SEARCH = "https://api.sam.gov/opportunities/v2/search";

const Poc = z
  .object({
    fullName: z.string().nullable().optional(),
    email: z.string().nullable().optional(),
    phone: z.string().nullable().optional(),
  })
  .passthrough();

export const SamNotice = z
  .object({
    noticeId: z.string(),
    title: z.string(),
    solicitationNumber: z.string().nullable().optional(),
    fullParentPathName: z.string().nullable().optional(),
    postedDate: z.string().nullable().optional(),
    type: z.string().nullable().optional(),
    baseType: z.string().nullable().optional(),
    typeOfSetAsideDescription: z.string().nullable().optional(),
    typeOfSetAside: z.string().nullable().optional(),
    responseDeadLine: z.string().nullable().optional(),
    naicsCode: z.string().nullable().optional(),
    classificationCode: z.string().nullable().optional(),
    active: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    uiLink: z.string().nullable().optional(),
    resourceLinks: z.array(z.string()).nullable().optional(),
    pointOfContact: z.array(Poc).nullable().optional(),
    placeOfPerformance: z
      .object({ state: z.object({ code: z.string().nullable().optional() }).nullable().optional() })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();
export type SamNotice = z.infer<typeof SamNotice>;

const SAM_TYPES: Record<string, NoticeKind> = {
  Presolicitation: "presolicitation",
  "Sources Sought": "sources_sought",
  "Special Notice": "informational",
  "Award Notice": "award_decision",
  Justification: "single_source",
  "Intent to Bundle Requirements (DoD-Funded)": "informational",
  "Sale of Surplus Property": "other",
};

export function samKind(
  type: string | null | undefined,
  title: string,
  solnum: string | null | undefined,
): NoticeKind {
  const t = type ?? "";
  if (SAM_TYPES[t]) return SAM_TYPES[t]!;
  if (/solicitation/i.test(t)) return kindFromText(solnum, title) ?? "rfp";
  return "other";
}

export function normalizeSam(raw: unknown, fetchedAt: string): Opportunity {
  const n = SamNotice.parse(raw);
  const codes: ClassificationCode[] = [];
  if (n.naicsCode) codes.push({ system: "NAICS", code: n.naicsCode, description: null });
  if (n.classificationCode) codes.push({ system: "PSC", code: n.classificationCode, description: null });
  const poc = n.pointOfContact?.[0];
  const pathParts = (n.fullParentPathName ?? "")
    .split(".")
    .map((s) => s.trim())
    .filter(Boolean);
  const state = n.placeOfPerformance?.state?.code ?? null;
  const uiLink = n.uiLink && /^https?:/.test(n.uiLink) ? n.uiLink : `https://sam.gov/opp/${n.noticeId}/view`;
  return Opportunity.parse({
    id: opportunityId("sam-gov", n.noticeId),
    source: "sam-gov",
    sourceRecordId: n.noticeId,
    solicitationNumber: clean(n.solicitationNumber),
    title: clean(n.title) ?? n.noticeId,
    // The API returns a link to the description, not the text; it is fetched on demand (needs the API key).
    description: null,
    kind: samKind(n.type, n.title, n.solicitationNumber),
    kindLabel: clean(n.type),
    status: n.active === "No" ? "closed" : "open",
    buyer: {
      name: pathParts.length ? pathParts.slice(0, 2).join(" / ") : "Federal agency",
      id: null,
      level: "federal",
    },
    state: state && /^[A-Z]{2}$/.test(state) ? state : null,
    postedAt: toIso(n.postedDate),
    dueAt: toIso(n.responseDeadLine),
    dueTimezone: null,
    codes,
    setAside: clean(n.typeOfSetAsideDescription ?? n.typeOfSetAside ?? null),
    contact: poc
      ? {
          name: clean(poc.fullName ?? null),
          email: clean(poc.email ?? null),
          phone: clean(poc.phone ?? null),
        }
      : null,
    documents: (n.resourceLinks ?? [])
      .filter((u) => /^https?:/.test(u))
      .map((url) => ({ filename: null, url, description: null, postedAt: null })),
    version: null,
    hasAddendum: false,
    provenance: {
      source: "sam-gov",
      sourceUrl: uiLink,
      fetchedAt,
      contentHash: contentHash(n),
      basis: "sam-gov",
    },
  });
}

export interface SamOptions {
  http: HttpClient;
  apiKey: string;
  /** Place-of-performance states to query (one request series per state). */
  states: string[];
  /** Procurement types: o = solicitation, k = combined synopsis/solicitation, p = presolicitation, r = sources sought. */
  ptypes?: string[];
  /** NAICS codes to restrict the query; empty means all. */
  naics?: string[];
  lookbackDays?: number;
  now?: () => string;
}

const mmddyyyy = (d: Date) =>
  `${String(d.getUTCMonth() + 1).padStart(2, "0")}/${String(d.getUTCDate()).padStart(2, "0")}/${d.getUTCFullYear()}`;

export class SamGovConnector implements SourceConnector {
  readonly id = "sam-gov" as const;
  readonly basis = "sam-gov";
  constructor(private readonly opts: SamOptions) {
    if (!opts.apiKey) throw new Error("SAM_API_KEY is required for the SAM.gov connector");
  }

  async fetch(window: FetchWindow = {}): Promise<ConnectorRun> {
    const fetchedAt = (this.opts.now ?? (() => new Date().toISOString()))();
    const run: ConnectorRun = {
      source: this.id,
      opportunities: [],
      rejected: [],
      fetchedAt,
      complete: false,
    };
    const to = new Date(fetchedAt);
    const from = window.since
      ? new Date(window.since)
      : new Date(to.getTime() - (this.opts.lookbackDays ?? 14) * 86_400_000);
    const cap = window.maxRecords ?? 5000;
    const seen = new Set<string>();
    const naicsList = this.opts.naics?.length ? this.opts.naics : [undefined];

    for (const state of this.opts.states) {
      for (const ncode of naicsList) {
        for (let offset = 0; run.opportunities.length < cap; offset += 1000) {
          const q = new URLSearchParams({
            api_key: this.opts.apiKey,
            postedFrom: mmddyyyy(from),
            postedTo: mmddyyyy(to),
            limit: "1000",
            offset: String(offset),
            state,
          });
          if (ncode) q.set("ncode", ncode);
          for (const p of this.opts.ptypes ?? ["o", "k", "p", "r"]) q.append("ptype", p);
          let res: { totalRecords?: number; opportunitiesData?: unknown[] };
          try {
            res = await this.opts.http.json(`${SAM_SEARCH}?${q}`);
          } catch (err) {
            // SAM answers an empty result with 404 "No Data found" rather than an empty list.
            if (err instanceof HttpError && err.status === 404 && /no data/i.test(err.body)) break;
            throw err;
          }
          const rows = res.opportunitiesData ?? [];
          for (const r of rows) {
            try {
              const opp = normalizeSam(r, fetchedAt);
              if (seen.has(opp.id)) continue;
              seen.add(opp.id);
              run.opportunities.push(opp);
            } catch (err) {
              const id = (r as { noticeId?: string } | null)?.noticeId ?? null;
              run.rejected.push({ sourceRecordId: id, error: (err as Error).message.slice(0, 300) });
            }
          }
          if (rows.length < 1000 || offset + 1000 >= (res.totalRecords ?? 0)) break;
        }
      }
    }
    // SAM queries are by posted-date window, so a run never sees the full set of open notices; it never
    // closes records by absence. SAM's own "active" flag drives status instead.
    run.opportunities = run.opportunities.slice(0, cap);
    return run;
  }
}
