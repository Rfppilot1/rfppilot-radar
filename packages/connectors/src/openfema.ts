import { z } from "zod";
import type { HttpClient } from "./http.js";
import { toIso } from "./util.js";

/**
 * OpenFEMA disaster declarations: a demand signal, not an opportunity. A new major-disaster declaration with
 * Public Assistance in a county predicts debris, recovery, grant-management and consulting procurements in
 * the following weeks. Official public API, no key. https://www.fema.gov/about/openfema/api
 */
export const OPENFEMA_DECLARATIONS = "https://www.fema.gov/api/open/v2/DisasterDeclarationsSummaries";

export const FemaDeclarationRow = z
  .object({
    femaDeclarationString: z.string(),
    disasterNumber: z.number(),
    declarationType: z.string(),
    declarationTitle: z.string().nullable().optional(),
    incidentType: z.string().nullable().optional(),
    declarationDate: z.string(),
    designatedArea: z.string().nullable().optional(),
    state: z.string().optional(),
    fipsStateCode: z.string().nullable().optional(),
    fipsCountyCode: z.string().nullable().optional(),
    paProgramDeclared: z.boolean().nullable().optional(),
    hmProgramDeclared: z.boolean().nullable().optional(),
    iaProgramDeclared: z.boolean().nullable().optional(),
  })
  .passthrough();

export interface DisasterSignal {
  id: string;
  disasterNumber: number;
  declaration: string;
  type: string;
  title: string;
  incidentType: string;
  state: string;
  declaredAt: string;
  counties: string[];
  publicAssistance: boolean;
  hazardMitigation: boolean;
  individualAssistance: boolean;
  sourceUrl: string;
}

const cleanCounty = (a: string) =>
  a.replace(/\s*\((County|Parish|Municipality|Reservation|Borough|city)\)\s*/gi, "").trim();

/** Groups per-county declaration rows into one signal per disaster. */
export function groupDeclarations(rows: unknown[], state: string): DisasterSignal[] {
  const byNum = new Map<number, DisasterSignal>();
  for (const raw of rows) {
    const r = FemaDeclarationRow.parse(raw);
    let s = byNum.get(r.disasterNumber);
    if (!s) {
      s = {
        id: `openfema:${r.femaDeclarationString}`,
        disasterNumber: r.disasterNumber,
        declaration: r.femaDeclarationString,
        type: r.declarationType,
        title: r.declarationTitle ?? `Disaster ${r.disasterNumber}`,
        incidentType: r.incidentType ?? "Other",
        state,
        declaredAt: toIso(r.declarationDate) ?? r.declarationDate,
        counties: [],
        publicAssistance: false,
        hazardMitigation: false,
        individualAssistance: false,
        sourceUrl: `https://www.fema.gov/disaster/${r.disasterNumber}`,
      };
      byNum.set(r.disasterNumber, s);
    }
    s.publicAssistance ||= !!r.paProgramDeclared;
    s.hazardMitigation ||= !!r.hmProgramDeclared;
    s.individualAssistance ||= !!r.iaProgramDeclared;
    const c = r.designatedArea ? cleanCounty(r.designatedArea) : "";
    if (c && !/statewide/i.test(c) && !s.counties.includes(c)) s.counties.push(c);
  }
  return [...byNum.values()].sort((a, b) => b.declaredAt.localeCompare(a.declaredAt));
}

export async function fetchDisasterSignals(
  http: HttpClient,
  state: string,
  sinceIso: string,
): Promise<DisasterSignal[]> {
  const st = state.trim().toUpperCase();
  if (!/^[A-Z]{2}$/.test(st)) throw new Error(`Invalid state "${state}"`);
  if (
    !/^\d{4}-\d{2}-\d{2}(T[0-9:.]+(Z|[+-]\d{2}:?\d{2})?)?$/.test(sinceIso) ||
    Number.isNaN(Date.parse(sinceIso))
  ) {
    throw new Error(`Invalid since date "${sinceIso}"`);
  }
  const since = sinceIso.slice(0, 10);
  const rows: unknown[] = [];
  const pageSize = 1000;
  for (let skip = 0; skip < 20_000; skip += pageSize) {
    const q = new URLSearchParams({
      $filter: `state eq '${st}' and declarationDate ge '${since}'`,
      $orderby: "declarationDate desc",
      $top: String(pageSize),
      $skip: String(skip),
    });
    const res = await http.json<{ DisasterDeclarationsSummaries?: unknown[] }>(
      `${OPENFEMA_DECLARATIONS}?${q}`,
    );
    const page = res.DisasterDeclarationsSummaries ?? [];
    rows.push(...page);
    if (page.length < pageSize) break;
  }
  return groupDeclarations(rows, st);
}
