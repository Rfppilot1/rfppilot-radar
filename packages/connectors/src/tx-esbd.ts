import {
  Opportunity,
  extractKeyDates,
  parseMoney,
  valueFromText,
  type ClassificationCode,
  type OpportunityStatus,
} from "@radar/core";
import { z } from "zod";
import type { HttpClient } from "./http.js";
import {
  kindFromText,
  opportunityId,
  type ConnectorRun,
  type FetchWindow,
  type SourceConnector,
} from "./types.js";
import { htmlToText } from "./fl-mfmp.js";
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
/** Bump when the detail parser reads new fields, so stored postings are re-read once. 2 = estimated value. */
export const TX_DETAIL_VERSION = 2;

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

/**
 * The public detail page's own data service (the same call the page at /esbd/<solicitation id> makes). It adds
 * the description, contact, addendum log and posted attachments that the search list omits.
 */
export const txDetailUrl = (solicitationId: string) =>
  `${TX_ESBD_BASE}/app/extensions/CPA/CPAMain/1.0.0/services/ESBD.Details.Service.ss?c=852252&email=&identification=${encodeURIComponent(solicitationId)}&n=2&optOutKey=&urlRoot=esbd`;

export const TxEsbdDetail = z
  .object({
    description: z.string().nullable().optional(),
    contactName: z.string().nullable().optional(),
    contactNumber: z.string().nullable().optional(),
    contactEmail: z.string().nullable().optional(),
    /** The agency's estimated value, as a money string ("59,500.00"); empty or "0.00" when not given. */
    value: z.union([z.string(), z.number()]).nullable().optional(),
    attachments: z
      .array(
        z.object({
          fileName: z.string().nullable().optional(),
          fileURL: z.string().nullable().optional(),
          fileDescription: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
  })
  .passthrough();

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

export function normalizeTxEsbd(raw: unknown, fetchedAt: string, detailRaw?: unknown): Opportunity {
  const l = TxEsbdLine.parse(raw);
  const detail = detailRaw === undefined || detailRaw === null ? null : TxEsbdDetail.parse(detailRaw);
  const description = htmlToText(detail?.description);
  const documents = (detail?.attachments ?? []).flatMap((a) =>
    a.fileURL
      ? [
          {
            filename: a.fileName ?? null,
            url: new URL(a.fileURL, TX_ESBD_BASE).toString(),
            description: clean(a.fileDescription ?? null),
            postedAt: null,
          },
        ]
      : [],
  );
  const contact = detail
    ? {
        name: clean(detail.contactName ?? null),
        email: clean(detail.contactEmail ?? null),
        phone: clean(detail.contactNumber ?? null),
      }
    : null;
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
    description,
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
    contact,
    documents,
    version: null,
    hasAddendum:
      l.status === "6" ||
      /addendum/i.test(l.statusName) ||
      documents.some((d) => /addend/i.test(`${d.filename}`)),
    keyDates: extractKeyDates(description, { now: fetchedAt }),
    estimatedValue: estimatedValue(detail?.value, description),
    provenance: {
      source: "tx-esbd",
      sourceUrl,
      fetchedAt,
      // With detail, the hash covers both, so a description or attachment change is stored as a new version.
      // The parser version is part of the hash, so records re-read by a newer parser are stored again.
      contentHash: detail
        ? contentHash({ list: l, detail: detailRaw, v: TX_DETAIL_VERSION })
        : contentHash(l),
      listHash: contentHash(l),
      detailVersion: detail ? TX_DETAIL_VERSION : undefined,
      basis: "tx-esbd",
    },
  });
}

export interface TxEsbdOptions {
  http: HttpClient;
  /** ESBD status filter; "1" = Posted. */
  status?: string;
  /** Upper bound on pages per run. Each page holds 24 records. */
  maxPages?: number;
  now?: () => string;
  /**
   * Fetch each posting's detail (description, attachments, contact). Off by default to keep tests and one-off
   * runs light; the scheduled worker turns it on.
   */
  details?: {
    /** Upper bound on detail requests per run. */
    max?: number;
    /**
     * List hashes (`provenance.listHash`) of records already stored WITH detail. A posting whose list entry is unchanged is not
     * re-fetched; it is reported as partial so the stored, fuller copy is kept.
     */
    known?: ReadonlyMap<string, string>;
    onProgress?: (p: { listed: number; detailsDone: number }) => void;
  };
}

export class TxEsbdConnector implements SourceConnector {
  readonly id = "tx-esbd" as const;
  readonly basis = "tx-esbd";
  private readonly lines = new Map<string, unknown>();
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
          this.lines.set(opp.id, line);
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
    if (this.opts.details) await this.enrich(run, this.opts.details);
    const capped = run.opportunities.length > cap;
    if (capped) run.opportunities = run.opportunities.slice(0, cap);
    run.complete =
      run.opportunities.length > 0 &&
      reachedEnd &&
      !capped &&
      skipped === 0 &&
      !run.rejected.some((r) => r.sourceRecordId === null);
    // Detail failures don't make a run incomplete: those records were still seen and keep their stored copy.
    return run;
  }

  /** Replaces list-only records with detail-enriched ones, skipping postings already stored with detail. */
  private async enrich(run: ConnectorRun, d: NonNullable<TxEsbdOptions["details"]>): Promise<void> {
    run.partialIds ??= [];
    let budget = d.max ?? 600;
    let done = 0;
    d.onProgress?.({ listed: run.opportunities.length, detailsDone: 0 });
    for (let i = 0; i < run.opportunities.length; i++) {
      const opp = run.opportunities[i]!;
      if (opp.status !== "open") continue;
      if (d.known?.get(opp.id) === opp.provenance.listHash || budget <= 0) {
        run.partialIds.push(opp.id);
        continue;
      }
      budget--;
      try {
        const raw = await this.opts.http.json<unknown>(
          txDetailUrl(opp.solicitationNumber ?? opp.sourceRecordId),
        );
        run.opportunities[i] = normalizeTxEsbd(this.lines.get(opp.id), run.fetchedAt, raw);
      } catch (err) {
        run.partialIds.push(opp.id);
        run.rejected.push({
          sourceRecordId: opp.sourceRecordId,
          error: `detail: ${(err as Error).message.slice(0, 250)}`,
        });
      }
      if (++done % 50 === 0) d.onProgress?.({ listed: run.opportunities.length, detailsDone: done });
    }
    d.onProgress?.({ listed: run.opportunities.length, detailsDone: done });
  }
}

function estimatedValue(field: string | number | null | undefined, description: string | null) {
  const amount = parseMoney(field ?? null);
  return amount ? { amount, basis: "agency_estimate" as const, text: null } : valueFromText(description);
}
