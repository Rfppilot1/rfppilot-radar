import { Opportunity, extractKeyDates, valueFromText, type OpportunityStatus } from "@radar/core";
import { z } from "zod";
import { htmlToText } from "./fl-mfmp.js";
import type { HttpClient } from "./http.js";
import {
  kindFromText,
  opportunityId,
  type ConnectorRun,
  type FetchWindow,
  type SourceConnector,
} from "./types.js";
import { clean, contentHash, toIso } from "./util.js";

/**
 * OpenGov Procurement public portals (procurement.opengov.com/portal/<code>). Used by about 100 Florida local
 * governments (Orange, Volusia, Collier, Pinellas, Sarasota counties; Tampa, Orlando, St. Petersburg and many more
 * cities; airports, utilities, school districts) and about 45 in Texas.
 *
 * Collection uses the same public JSON API the portal pages call, verified without cookies on Oct 27, 2026:
 * `GET /api/v1/government` lists every government on the platform (name, state, timezone, portal code), and
 * `POST /api/v1/government/<code>/project/public` returns a portal's projects (filter status "open"). No sign-in.
 * See docs/SOURCES.md#opengov.
 */
export const OPENGOV_API = "https://api.procurement.opengov.com/api/v1";
export const OPENGOV_PORTAL = "https://procurement.opengov.com/portal";
const PAGE_SIZE = 100;
/** Bump when the parser reads new fields, so every stored record is refreshed once. */
const OPENGOV_PARSE_VERSION = 1;

export const OgGovernment = z
  .object({
    name: z.string(),
    state: z.string().nullable().optional(),
    timezone: z.string().nullable().optional(),
    isActive: z.boolean().nullable().optional(),
    deleted_at: z.string().nullable().optional(),
    government: z.object({ code: z.string(), id: z.number().optional() }).passthrough().nullable().optional(),
  })
  .passthrough();
export type OgGovernment = z.infer<typeof OgGovernment>;

export const OgProject = z
  .object({
    id: z.number(),
    title: z.string().nullable().optional(),
    financialId: z.string().nullable().optional(),
    status: z.string(),
    summary: z.string().nullable().optional(),
    releaseProjectDate: z.string().nullable().optional(),
    proposalDeadline: z.string().nullable().optional(),
    created_at: z.string().nullable().optional(),
    isPrivate: z.boolean().nullable().optional(),
    comingSoon: z.boolean().nullable().optional(),
    department: z.object({ name: z.string().nullable().optional() }).passthrough().nullable().optional(),
    addendums: z.array(z.unknown()).nullable().optional(),
    template: z.object({ title: z.string().nullable().optional() }).passthrough().nullable().optional(),
    government: z
      .object({
        code: z.string(),
        organization: z
          .object({
            name: z.string().nullable().optional(),
            state: z.string().nullable().optional(),
            timezone: z.string().nullable().optional(),
          })
          .passthrough()
          .nullable()
          .optional(),
      })
      .passthrough(),
  })
  .passthrough();
export type OgProject = z.infer<typeof OgProject>;

const OgPage = z.object({ count: z.number(), rows: z.array(z.unknown()) });

const STATUS: Record<string, OpportunityStatus> = {
  open: "open",
  pending: "preview",
  evaluation: "closed",
  awardPending: "closed",
  closed: "closed",
  canceled: "cancelled",
  cancelled: "cancelled",
};

/** Template names OpenGov governments use for notices that are not biddable. */
function kindFor(p: OgProject) {
  const label = p.template?.title ?? null;
  if (label && /notice of intent|award|bid tab/i.test(label)) return "award_decision" as const;
  if (label && /(letter of interest|sources sought)/i.test(label)) return "sources_sought" as const;
  if (/^\s*(pre-?solicitation|public notice)\b/i.test(p.title ?? "")) return "presolicitation" as const;
  return kindFromText(label, p.title, p.financialId) ?? "other";
}

export function normalizeOpenGov(raw: unknown, fetchedAt: string, gov?: OgGovernment): Opportunity {
  const p = OgProject.parse(raw);
  const code = p.government.code;
  const org = p.government.organization ?? null;
  const description = htmlToText(p.summary);
  const title = clean(p.title) ?? clean(p.financialId) ?? `OpenGov project ${p.id}`;
  return Opportunity.parse({
    id: opportunityId("opengov", `${code}/${p.id}`),
    source: "opengov",
    sourceRecordId: `${code}/${p.id}`,
    solicitationNumber: clean(p.financialId ?? null),
    title,
    description,
    kind: kindFor(p),
    kindLabel: clean(p.template?.title ?? null),
    status: p.comingSoon ? "preview" : (STATUS[p.status] ?? "unknown"),
    buyer: {
      name: clean(org?.name) ?? clean(gov?.name) ?? code,
      id: code,
      level: "local",
    },
    state: (org?.state ?? gov?.state ?? null)?.toUpperCase().slice(0, 2) ?? null,
    postedAt: toIso(p.releaseProjectDate ?? p.created_at ?? null),
    dueAt: toIso(p.proposalDeadline ?? null),
    dueTimezone: p.proposalDeadline ? (org?.timezone ?? gov?.timezone ?? null) : null,
    codes: [],
    setAside: null,
    contact: null,
    documents: [],
    version: null,
    hasAddendum: (p.addendums?.length ?? 0) > 0,
    keyDates: extractKeyDates(description, { now: fetchedAt }),
    estimatedValue: valueFromText(description),
    provenance: {
      source: "opengov",
      sourceUrl: `${OPENGOV_PORTAL}/${encodeURIComponent(code)}/projects/${p.id}`,
      fetchedAt,
      contentHash: contentHash({ raw, v: OPENGOV_PARSE_VERSION }),
      basis: "opengov",
    },
  });
}

export interface OpenGovConnectorOptions {
  http: HttpClient;
  /** Two-letter states whose governments to read (default FL). */
  states?: string[];
  /** Portal codes to skip (for example, ones a customer does not want). */
  exclude?: string[];
  now?: () => string;
  onProgress?: (p: { governments: number; done: number; projects: number }) => void;
}

export class OpenGovConnector implements SourceConnector {
  readonly id = "opengov" as const;
  readonly basis = "opengov";

  constructor(private readonly opts: OpenGovConnectorOptions) {}

  /** Every active government on the platform in the configured states. */
  async governments(): Promise<OgGovernment[]> {
    const raw = await this.opts.http.json<unknown[]>(`${OPENGOV_API}/government`);
    if (!Array.isArray(raw)) throw new Error("OpenGov government list did not return a list");
    const states = new Set((this.opts.states ?? ["FL"]).map((s) => s.trim().toUpperCase()));
    const exclude = new Set(this.opts.exclude ?? []);
    const out: OgGovernment[] = [];
    for (const r of raw) {
      const g = OgGovernment.safeParse(r);
      if (!g.success || !g.data.government?.code) continue;
      if (g.data.isActive === false || g.data.deleted_at) continue;
      if (!states.has((g.data.state ?? "").toUpperCase())) continue;
      if (exclude.has(g.data.government.code)) continue;
      out.push(g.data);
    }
    return out;
  }

  async fetch(window: FetchWindow = {}): Promise<ConnectorRun> {
    const fetchedAt = this.opts.now?.() ?? new Date().toISOString();
    const run: ConnectorRun = { source: this.id, opportunities: [], rejected: [], fetchedAt, complete: true };
    const max = window.maxRecords ?? 20_000;
    const govs = await this.governments();
    let done = 0;
    for (const gov of govs) {
      const code = gov.government!.code;
      try {
        for (let page = 1; page <= 20; page++) {
          const body = {
            filters: [{ type: "status", value: "open" }],
            quickSearchQuery: null,
            limit: PAGE_SIZE,
            page,
          };
          const res = OgPage.parse(
            await this.opts.http.json<unknown>(
              `${OPENGOV_API}/government/${encodeURIComponent(code)}/project/public`,
              { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
            ),
          );
          for (const row of res.rows) {
            if (run.opportunities.length >= max) {
              run.complete = false;
              break;
            }
            try {
              const o = normalizeOpenGov(row, fetchedAt, gov);
              if ((row as { isPrivate?: boolean }).isPrivate) continue;
              if (window.since && o.postedAt && o.postedAt < window.since) continue;
              run.opportunities.push(o);
            } catch (err) {
              const id = (row as { id?: unknown })?.id;
              run.rejected.push({
                sourceRecordId: id != null ? `${code}/${id}` : null,
                error: (err as Error).message.slice(0, 300),
              });
            }
          }
          if (res.rows.length < PAGE_SIZE || page * PAGE_SIZE >= res.count) break;
        }
      } catch (err) {
        // One portal failing must not stop the others, but the run is then not the full list.
        run.complete = false;
        run.rejected.push({ sourceRecordId: code, error: `portal: ${(err as Error).message.slice(0, 280)}` });
      }
      done++;
      if (done % 25 === 0 || done === govs.length)
        this.opts.onProgress?.({ governments: govs.length, done, projects: run.opportunities.length });
      if (run.opportunities.length >= max) {
        run.complete = false;
        break;
      }
    }
    if (window.since) run.complete = false;
    return run;
  }
}
