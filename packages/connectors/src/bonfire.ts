import { Opportunity } from "@radar/core";
import { z } from "zod";
import type { HttpClient } from "./http.js";
import {
  kindFromText,
  opportunityId,
  type ConnectorRun,
  type FetchWindow,
  type SourceConnector,
} from "./types.js";
import { clean, contentHash } from "./util.js";

/**
 * Bonfire (Euna Procurement) public portals, `<org>.bonfirehub.com/portal/?tab=openOpportunities`. Each portal's
 * open list comes from the same public JSON call the page makes, verified without cookies on Oct 27, 2026:
 * `GET /PublicPortal/getOpenPublicOpportunitiesSectionData`. Bonfire has no public directory of portals, so the
 * portals read are listed in BONFIRE_PORTALS (each confirmed by hand). See docs/SOURCES.md#bonfire.
 */
export interface BonfirePortal {
  /** Subdomain, e.g. "hillsboroughcounty" for hillsboroughcounty.bonfirehub.com. */
  org: string;
  name: string;
  state: string;
  timezone: string;
}

/** Confirmed Florida portals (Oct 27, 2026). Add one only after opening its public portal page. */
export const BONFIRE_PORTALS: BonfirePortal[] = [
  { org: "hillsboroughcounty", name: "Hillsborough County", state: "FL", timezone: "America/New_York" },
  { org: "broward", name: "Broward County", state: "FL", timezone: "America/New_York" },
  { org: "pascocountyfl", name: "Pasco County", state: "FL", timezone: "America/New_York" },
  { org: "talgov", name: "City of Tallahassee", state: "FL", timezone: "America/New_York" },
  { org: "ucfprocurement", name: "University of Central Florida", state: "FL", timezone: "America/New_York" },
  { org: "fau", name: "Florida Atlantic University", state: "FL", timezone: "America/New_York" },
];

const BONFIRE_PARSE_VERSION = 1;

export const BonfireProject = z
  .object({
    ProjectID: z.union([z.string(), z.number()]).transform(String),
    ReferenceID: z.string().nullable().optional(),
    ProjectName: z.string().nullable().optional(),
    ProjectStatusID: z.union([z.string(), z.number()]).nullable().optional(),
    ProjectVisibilityID: z.union([z.string(), z.number()]).nullable().optional(),
    DateClose: z.string().nullable().optional(),
    DepartmentID: z.union([z.string(), z.number()]).nullable().optional(),
  })
  .passthrough();
export type BonfireProject = z.infer<typeof BonfireProject>;

const BonfireResponse = z.object({
  success: z.union([z.number(), z.boolean()]),
  payload: z.object({
    projects: z.union([z.record(z.unknown()), z.array(z.unknown())]),
    departments: z
      .union([
        z.record(z.object({ DepartmentName: z.string().nullable().optional() }).passthrough()),
        z.array(z.unknown()),
      ])
      .optional(),
  }),
});

/** Bonfire's DateClose is UTC wall-clock time ("2026-11-17 19:00:00"). */
export function bonfireDateToIso(v: string | null | undefined): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?$/.exec(v?.trim() ?? "");
  if (!m) return null;
  const t = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +(m[6] ?? 0));
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function kindFor(p: BonfireProject) {
  const t = `${p.ReferenceID ?? ""} ${p.ProjectName ?? ""}`;
  if (
    /^\s*(public notice|pre-?solicitation notice)\b/i.test(p.ProjectName ?? "") ||
    /^public notice$/i.test(p.ReferenceID ?? "")
  )
    return "presolicitation" as const;
  if (/\b(notice of intent|intent to award|bid tabulation)\b/i.test(t)) return "award_decision" as const;
  return kindFromText(p.ProjectName, p.ReferenceID) ?? "other";
}

export function normalizeBonfire(
  raw: unknown,
  fetchedAt: string,
  portal: BonfirePortal,
  departmentName?: string | null,
): Opportunity {
  const p = BonfireProject.parse(raw);
  const title = clean(p.ProjectName) ?? clean(p.ReferenceID) ?? `Bonfire project ${p.ProjectID}`;
  const dept = clean(departmentName ?? null);
  return Opportunity.parse({
    id: opportunityId("bonfire", `${portal.org}/${p.ProjectID}`),
    source: "bonfire",
    sourceRecordId: `${portal.org}/${p.ProjectID}`,
    solicitationNumber: clean(p.ReferenceID ?? null),
    title,
    // The open list carries no description; the department is the only context it gives.
    description: dept ? `Department: ${dept}` : null,
    kind: kindFor(p),
    kindLabel: null,
    status: String(p.ProjectStatusID ?? "2") === "2" ? "open" : "unknown",
    buyer: { name: portal.name, id: portal.org, level: "local" },
    state: portal.state,
    postedAt: null,
    dueAt: bonfireDateToIso(p.DateClose),
    dueTimezone: p.DateClose ? portal.timezone : null,
    codes: [],
    setAside: null,
    contact: null,
    documents: [],
    version: null,
    hasAddendum: false,
    keyDates: [],
    estimatedValue: null,
    provenance: {
      source: "bonfire",
      sourceUrl: `https://${portal.org}.bonfirehub.com/opportunities/${p.ProjectID}`,
      fetchedAt,
      // PrivateProjectID is a per-project token; it is stable, so it can stay in the hash.
      contentHash: contentHash({ raw, dept, v: BONFIRE_PARSE_VERSION }),
      basis: "bonfire",
    },
  });
}

export interface BonfireConnectorOptions {
  http: HttpClient;
  portals?: BonfirePortal[];
  now?: () => string;
}

export class BonfireConnector implements SourceConnector {
  readonly id = "bonfire" as const;
  readonly basis = "bonfire";

  constructor(private readonly opts: BonfireConnectorOptions) {}

  async fetch(window: FetchWindow = {}): Promise<ConnectorRun> {
    const fetchedAt = this.opts.now?.() ?? new Date().toISOString();
    const run: ConnectorRun = { source: this.id, opportunities: [], rejected: [], fetchedAt, complete: true };
    const max = window.maxRecords ?? 20_000;
    for (const portal of this.opts.portals ?? BONFIRE_PORTALS) {
      try {
        const res = BonfireResponse.parse(
          await this.opts.http.json<unknown>(
            `https://${portal.org}.bonfirehub.com/PublicPortal/getOpenPublicOpportunitiesSectionData`,
          ),
        );
        const rows = Array.isArray(res.payload.projects)
          ? res.payload.projects
          : Object.values(res.payload.projects);
        const depts = (
          res.payload.departments && !Array.isArray(res.payload.departments) ? res.payload.departments : {}
        ) as Record<string, { DepartmentName?: string | null }>;
        for (const row of rows) {
          if (run.opportunities.length >= max) {
            run.complete = false;
            break;
          }
          try {
            const deptId = String((row as { DepartmentID?: unknown })?.DepartmentID ?? "");
            const vis = String((row as { ProjectVisibilityID?: unknown })?.ProjectVisibilityID ?? "1");
            if (vis !== "1") continue; // only publicly visible projects
            run.opportunities.push(
              normalizeBonfire(row, fetchedAt, portal, depts[deptId]?.DepartmentName ?? null),
            );
          } catch (err) {
            const id = (row as { ProjectID?: unknown })?.ProjectID;
            run.rejected.push({
              sourceRecordId: id != null ? `${portal.org}/${id}` : null,
              error: (err as Error).message.slice(0, 300),
            });
          }
        }
      } catch (err) {
        run.complete = false;
        run.rejected.push({
          sourceRecordId: portal.org,
          error: `portal: ${(err as Error).message.slice(0, 280)}`,
        });
      }
    }
    return run;
  }
}
