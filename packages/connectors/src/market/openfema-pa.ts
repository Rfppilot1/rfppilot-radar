import { z } from "zod";
import type { HttpClient } from "../http.js";
import { contentHash } from "../util.js";
import type { MarketCapture, MarketRun, MarketWindow, PaApplicant, PaProject } from "@radar/core";

/**
 * OpenFEMA Public Assistance data (FEMA). Official, public, no key: https://www.fema.gov/about/openfema/api.
 *
 *   - Funded projects (v2): obligations per project worksheet, with damage category (A = debris removal,
 *     B = emergency protective measures), county and dates. Shows who spent disaster money on what; it names
 *     no contractors, so it is a demand signal for debris, monitoring and recovery contracts.
 *   - Applicants (v1): names for the applicant ids in the projects data.
 *
 * Field names verified Oct 31, 2026 against live responses (fixtures openfema-pa-*.2026-10-31). The v1 projects
 * endpoint is gone; projects filter on `stateAbbreviation`, applicants on the full state name in `state`.
 * Pages of up to 10,000 rows, read in a stable order with $skip; incremental runs filter on `lastRefresh`.
 */
export const OPENFEMA_BASE = "https://www.fema.gov/api/open";
export const PA_PROJECTS = `${OPENFEMA_BASE}/v2/PublicAssistanceFundedProjectsDetails`;
export const PA_APPLICANTS = `${OPENFEMA_BASE}/v1/PublicAssistanceApplicants`;
const PAGE = 10_000;
/** Safety stop: 50 pages × 10,000 rows per state is far beyond any state's history. */
const MAX_PAGES = 50;

const STATE_NAMES: Record<string, string> = { FL: "Florida", TX: "Texas", LA: "Louisiana", GA: "Georgia" };

const num = z.number().nullable().optional();
const str = z.string().nullable().optional();

export const PaProjectRow = z
  .object({
    disasterNumber: z.number(),
    pwNumber: z.number(),
    applicantId: z.string(),
    stateAbbreviation: z.string(),
    damageCategoryCode: z.string(),
    damageCategoryDescrip: str,
    applicationTitle: str,
    projectStatus: str,
    projectProcessStep: str,
    county: str,
    countyCode: str,
    projectAmount: num,
    federalShareObligated: num,
    totalObligated: num,
    firstObligationDate: str,
    lastObligationDate: str,
    declarationDate: str,
    incidentType: str,
    lastRefresh: str,
  })
  .passthrough();

export const PaApplicantRow = z
  .object({
    disasterNumber: z.number(),
    applicantId: z.string(),
    applicantName: z.string(),
    state: str,
    city: str,
    lastRefresh: str,
  })
  .passthrough();

const clean = (s: string | null | undefined) => (s && s.trim() ? s.replace(/\s+/g, " ").trim() : null);

export function normalizePaProject(raw: unknown): PaProject {
  const r = PaProjectRow.parse(raw);
  const key = `${r.disasterNumber}-${r.pwNumber}-${r.applicantId}`;
  const p: Omit<PaProject, "contentHash"> = {
    key,
    disasterNumber: r.disasterNumber,
    pwNumber: r.pwNumber,
    applicantId: r.applicantId,
    state: r.stateAbbreviation,
    county: clean(r.county),
    countyCode: clean(r.countyCode),
    damageCategory: r.damageCategoryCode,
    damageCategoryName: clean(r.damageCategoryDescrip),
    title: clean(r.applicationTitle),
    status: clean(r.projectStatus),
    processStep: clean(r.projectProcessStep),
    projectAmount: r.projectAmount ?? null,
    federalShareObligated: r.federalShareObligated ?? null,
    totalObligated: r.totalObligated ?? null,
    firstObligationDate: r.firstObligationDate ?? null,
    lastObligationDate: r.lastObligationDate ?? null,
    declarationDate: r.declarationDate ?? null,
    incidentType: clean(r.incidentType),
    lastRefresh: r.lastRefresh ?? null,
    sourceUrl: `${PA_PROJECTS}?$filter=${encodeURIComponent(
      `disasterNumber eq ${r.disasterNumber} and pwNumber eq ${r.pwNumber} and applicantId eq '${r.applicantId}'`,
    )}`,
  };
  // lastRefresh changes on every FEMA reload even when nothing else does; leave it out of the change hash.
  const { lastRefresh: _ignored, ...stable } = p;
  return { ...p, contentHash: contentHash(stable) };
}

export function normalizePaApplicant(raw: unknown): PaApplicant {
  const r = PaApplicantRow.parse(raw);
  const a: Omit<PaApplicant, "contentHash"> = {
    key: `${r.disasterNumber}-${r.applicantId}`,
    disasterNumber: r.disasterNumber,
    applicantId: r.applicantId,
    name: clean(r.applicantName) ?? r.applicantId,
    state: clean(r.state),
    city: clean(r.city),
    lastRefresh: r.lastRefresh ?? null,
  };
  const { lastRefresh: _ignored, ...stable } = a;
  return { ...a, contentHash: contentHash(stable) };
}

/** OData datetime literal; OpenFEMA accepts quoted ISO strings. */
const odataTime = (iso: string) => `'${new Date(iso).toISOString()}'`;

export interface OpenFemaPaOptions {
  http: HttpClient;
  states: string[];
  now?: () => string;
}

export interface PaRecords {
  projects: PaProject[];
  applicants: PaApplicant[];
}

export class OpenFemaPaCollector {
  readonly id = "openfema-pa" as const;
  constructor(private readonly opts: OpenFemaPaOptions) {}

  async fetch(window: MarketWindow): Promise<MarketRun<PaRecords>> {
    const now = this.opts.now ?? (() => new Date().toISOString());
    const fetchedAt = now();
    const until = window.until ?? fetchedAt;
    const out: PaRecords = { projects: [], applicants: [] };
    const run: MarketRun<PaRecords> = {
      source: this.id,
      records: [out],
      captures: [],
      rejected: [],
      fetchedAt,
      window: { since: window.since, until },
      complete: true,
      notes: [],
    };
    const since = `lastRefresh ge ${odataTime(window.since)}`;
    for (const state of this.opts.states) {
      await this.pages(
        run,
        PA_PROJECTS,
        `stateAbbreviation eq '${state}' and ${since}`,
        "disasterNumber,pwNumber,applicantId",
        "PublicAssistanceFundedProjectsDetails",
        (row, i) => out.projects.push({ ...normalizePaProject(row), captureIndex: i }),
        now,
      );
      const name = STATE_NAMES[state.toUpperCase()];
      if (!name) {
        run.notes.push(`${state}: no state name known for the applicants dataset; applicant names skipped`);
        continue;
      }
      await this.pages(
        run,
        PA_APPLICANTS,
        `state eq '${name}' and ${since}`,
        "disasterNumber,applicantId",
        "PublicAssistanceApplicants",
        (row, i) => out.applicants.push({ ...normalizePaApplicant(row), captureIndex: i }),
        now,
      );
    }
    return run;
  }

  private async pages(
    run: MarketRun<PaRecords>,
    endpoint: string,
    filter: string,
    orderby: string,
    entity: string,
    add: (row: unknown, captureIndex: number) => void,
    now: () => string,
  ): Promise<void> {
    for (let page = 0; ; page++) {
      const q = new URLSearchParams({
        $filter: filter,
        $orderby: orderby,
        $top: String(PAGE),
        $skip: String(page * PAGE),
      });
      const url = `${endpoint}?${q.toString().replace(/\+/g, "%20")}`;
      const raw = await this.opts.http.text(url, { headers: { accept: "application/json" } });
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const rows = Array.isArray(parsed[entity]) ? (parsed[entity] as unknown[]) : [];
      // The applicants list is reloaded whole every day; keying on the rows (not the run-stamped metadata) keeps
      // identical pages from being stored again.
      run.captures.push({
        source: "openfema-pa",
        url,
        request: null,
        retrievedAt: now(),
        body: raw,
        contentKey: contentHash(rows),
      } satisfies MarketCapture);
      for (const row of rows) {
        try {
          add(row, run.captures.length - 1);
        } catch (err) {
          const r = row as { applicantId?: string; disasterNumber?: number } | null;
          run.rejected.push({
            sourceRecordId: r ? `${r.disasterNumber ?? "?"}-${r.applicantId ?? "?"}` : null,
            error: (err as Error).message.slice(0, 300),
          });
        }
      }
      if (rows.length < PAGE) break;
      if (page + 1 >= MAX_PAGES) {
        run.complete = false;
        run.notes.push(`${entity}: stopped after ${MAX_PAGES} pages`);
        break;
      }
    }
  }
}
