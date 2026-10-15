import { Opportunity, type ClassificationCode, type OpportunityStatus } from "@radar/core";
import { z } from "zod";
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
 * Texas Electronic State Business Daily (ESBD), Statewide Procurement Division, Comptroller of Public
 * Accounts. Public; the search page states "Sign in is NOT required."
 *
 * Collection uses the same JSON service the public search page calls, one page of 24 at a time, filtered to
 * status "Posted" (open). See docs/SOURCES.md#tx-esbd for the basis and the review items before commercial use.
 */
export const TX_ESBD_BASE = "https://www.txsmartbuy.gov";
export const TX_ESBD_SERVICE = `${TX_ESBD_BASE}/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Service.ss?c=852252&n=2`;
export const TX_TZ = "America/Chicago";

export const TxEsbdLine = z.object({
  internalid: z.string(),
  title: z.string(),
  solicitationId: z.string(),
  responseDue: z.string().optional().default(""),
  responseTime: z.string().optional().default(""),
  agencyNumber: z.string().optional().default(""),
  agencyName: z.string(),
  status: z.string().optional().default(""),
  statusName: z.string().optional().default(""),
  postingDate: z.string().optional().default(""),
  cancelledDate: z.string().optional().default(""),
  created: z.string().optional().default(""),
  lastModified: z.string().optional().default(""),
  nigpCodes: z.string().optional().default(""),
  repostURL: z.string().optional().default(""),
  url: z.string().optional().default(""),
});
export type TxEsbdLine = z.infer<typeof TxEsbdLine>;

export const TxEsbdPage = z.object({
  lines: z.array(z.unknown()),
  page: z.union([z.string(), z.number()]),
  recordsPerPage: z.union([z.string(), z.number()]),
  totalRecordsFound: z.union([z.string(), z.number()]),
});

/** ESBD status codes observed on the public search form. */
const STATUS: Record<string, OpportunityStatus> = {
  "1": "open", // Posted
  "6": "open", // Addendum Posted
  "2": "awarded",
  "11": "closed", // No Award
  "5": "closed",
  "3": "cancelled", // Posting Cancelled
};

export function parseNigp(raw: string): ClassificationCode[] {
  return raw
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s): ClassificationCode[] => {
      const m = /^(\d{3,7})\s*-\s*(.*)$/.exec(s);
      return m ? [{ system: "NIGP", code: m[1]!, description: clean(m[2]) }] : [];
    });
}

/** Texas state agencies use numeric agency numbers; cities, counties, ISDs and other members use letter prefixes. */
function buyerLevel(agencyNumber: string): "state" | "local" {
  return /^\d+$/.test(agencyNumber.trim()) ? "state" : "local";
}

export function normalizeTxEsbd(raw: unknown, fetchedAt: string): Opportunity {
  const l = TxEsbdLine.parse(raw);
  const status = STATUS[l.status] ?? (/addendum|posted/i.test(l.statusName) ? "open" : "unknown");
  const postedAt = zonedToUtcIso(l.postingDate, "12:00 AM", TX_TZ);
  const sourceUrl = `${TX_ESBD_BASE}/esbd/${encodeURIComponent(l.solicitationId)}`;
  const kind = kindFromText(l.solicitationId, l.title) ?? "other";
  return Opportunity.parse({
    id: opportunityId("tx-esbd", l.internalid),
    source: "tx-esbd",
    sourceRecordId: l.internalid,
    solicitationNumber: clean(l.solicitationId),
    title: clean(l.title) ?? l.solicitationId,
    description: null,
    kind,
    kindLabel: null,
    status,
    buyer: {
      name: clean(l.agencyName) ?? "Unknown agency",
      id: clean(l.agencyNumber),
      level: buyerLevel(l.agencyNumber),
    },
    state: "TX",
    postedAt,
    dueAt: l.responseDue ? zonedToUtcIso(l.responseDue, l.responseTime || null, TX_TZ) : null,
    dueTimezone: l.responseDue ? TX_TZ : null,
    codes: parseNigp(l.nigpCodes),
    setAside: null,
    contact: null,
    documents: [],
    version: null,
    hasAddendum: l.status === "6" || /addendum/i.test(l.statusName),
    provenance: { source: "tx-esbd", sourceUrl, fetchedAt, contentHash: contentHash(l), basis: "tx-esbd" },
  });
}

export interface TxEsbdOptions {
  http: HttpClient;
  /** ESBD status filter; "1" = Posted. */
  status?: string;
  /** Upper bound on pages per run. Each page holds 24 records. */
  maxPages?: number;
  now?: () => string;
}

export class TxEsbdConnector implements SourceConnector {
  readonly id = "tx-esbd" as const;
  readonly basis = "tx-esbd";
  constructor(private readonly opts: TxEsbdOptions) {}

  async fetch(window: FetchWindow = {}): Promise<ConnectorRun> {
    const fetchedAt = (this.opts.now ?? (() => new Date().toISOString()))();
    const run: ConnectorRun = {
      source: this.id,
      opportunities: [],
      rejected: [],
      fetchedAt,
      complete: false,
    };
    const maxPages = this.opts.maxPages ?? 60;
    const cap = window.maxRecords ?? Infinity;
    let reachedEnd = false;
    let skipped = 0;

    for (let page = 1; page <= maxPages && run.opportunities.length < cap; page++) {
      const body = { lines: [], page: String(page), urlRoot: "esbd", status: this.opts.status ?? "1" };
      let parsed: z.infer<typeof TxEsbdPage>;
      try {
        parsed = TxEsbdPage.parse(
          await this.opts.http.json<unknown>(TX_ESBD_SERVICE, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
        );
      } catch (err) {
        // Keep everything already fetched; the run is marked incomplete so nothing is closed by mistake.
        run.rejected.push({
          sourceRecordId: null,
          error: `page ${page}: ${(err as Error).message.slice(0, 250)}`,
        });
        break;
      }
      for (const line of parsed.lines) {
        try {
          const opp = normalizeTxEsbd(line, fetchedAt);
          if (window.since && opp.postedAt && opp.postedAt < window.since && !opp.hasAddendum) {
            skipped++;
            continue;
          }
          run.opportunities.push(opp);
        } catch (err) {
          const id = (line as { internalid?: string } | null)?.internalid ?? null;
          run.rejected.push({ sourceRecordId: id, error: (err as Error).message.slice(0, 300) });
        }
      }
      const perPage = Number(parsed.recordsPerPage) || 24;
      if (parsed.lines.length < perPage || page * perPage >= Number(parsed.totalRecordsFound)) {
        reachedEnd = true;
        break;
      }
    }
    const capped = run.opportunities.length > cap;
    if (capped) run.opportunities = run.opportunities.slice(0, cap);
    run.complete =
      run.opportunities.length > 0 &&
      reachedEnd &&
      !capped &&
      skipped === 0 &&
      !run.rejected.some((r) => r.sourceRecordId === null);
    return run;
  }
}
