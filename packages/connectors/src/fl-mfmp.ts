import {
  Opportunity,
  extractKeyDates,
  isLocalBuyerName,
  valueFromText,
  isIntel,
  type ClassificationCode,
  type DocumentRef,
  type NoticeKind,
  type OpportunityStatus,
} from "@radar/core";
import { z } from "zod";
import type { HttpClient } from "./http.js";
import { opportunityId, type ConnectorRun, type FetchWindow, type SourceConnector } from "./types.js";
import { clean, contentHash, toIso } from "./util.js";

/**
 * Florida MyFloridaMarketPlace Vendor Information Portal (VIP), "State of Florida Advertisements".
 * Public; no sign-in. Replaced the legacy Vendor Bid System on March 28, 2022.
 *
 * Collection uses the same public JSON endpoints the public pages call (verified without cookies on
 * Oct 15, 2026): POST /mfmp/pub/search/bids (100 per page) for the list, and GET
 * /mfmp/pub/search/bids/detail?id= for each biddable ad's commodity codes, description, contact and
 * documents. Both require `Accept: application/json`; without it the server returns the web app's HTML.
 * See docs/SOURCES.md#fl-mfmp.
 */
export const FL_VIP_BASE = "https://vendor.myfloridamarketplace.com";
export const FL_SEARCH_API = `${FL_VIP_BASE}/mfmp/pub/search/bids`;
export const FL_DETAIL_API = `${FL_VIP_BASE}/mfmp/pub/search/bids/detail`;
export const FL_DOWNLOAD_API = `${FL_VIP_BASE}/mfmp/bids/detail/attachment/download`;
export const FL_TZ = "America/New_York";
const PAGE_SIZE = 100;

export const FlAd = z.object({
  advertisementId: z.number(),
  uniqueName: z.string(),
  agencyAdNumber: z.string().nullable().optional(),
  type: z.string(),
  typeId: z.string().optional(),
  title: z.string(),
  openDate: z.string().nullable().optional(),
  closeDate: z.string().nullable().optional(),
  publishDate: z.string().nullable().optional(),
  status: z.string(),
  version: z.number().nullable().optional(),
  organization: z
    .object({
      organizationId: z.number().optional(),
      shortName: z.string().nullable().optional(),
      name: z.string(),
    })
    .nullable()
    .optional(),
  agency: z.string().nullable().optional(),
});
export type FlAd = z.infer<typeof FlAd>;

export const FlDetail = z
  .object({
    advertisementId: z.number(),
    description: z.string().nullable().optional(),
    commodityCodes: z
      .array(z.object({ id: z.string(), value: z.string().nullable().optional() }))
      .nullable()
      .optional(),
    docs: z
      .array(
        z.object({
          attachmentId: z.number(),
          fileName: z.string().nullable().optional(),
          description: z.string().nullable().optional(),
          date: z.string().nullable().optional(),
        }),
      )
      .nullable()
      .optional(),
    responseContact: z
      .object({
        responseContact: z.string().nullable().optional(),
        email: z.string().nullable().optional(),
        ph: z.string().nullable().optional(),
      })
      .nullable()
      .optional(),
    lastUpdateDate: z.string().nullable().optional(),
  })
  .passthrough();
export type FlDetail = z.infer<typeof FlDetail>;

/** Bump when the parser reads new fields from the same payloads. 2 = estimated value from the description; 3 = local buyers. */
export const FL_PARSE_VERSION = 3;

/** Ad types exactly as listed in the portal's "Ad Type" filter. */
export const FL_AD_TYPES: Record<string, NoticeKind> = {
  "Invitation to Bid": "itb",
  "Invitation to Negotiate": "itn",
  "Request for Proposals": "rfp",
  "Request for Information": "rfi",
  "Request for Statement of Qualifications": "soq",
  "Grant Opportunities": "grant",
  "Agency Decision": "award_decision",
  "Informational Notice": "informational",
  "Public Meeting Notice": "informational",
  "Single Source": "single_source",
};

const STATUS: Record<string, OpportunityStatus> = {
  OPEN: "open",
  PREVIEW: "preview",
  CLOSED: "closed",
  WITHDRAWN: "cancelled",
};

/**
 * An ad stays "OPEN" on the portal through its posting window even after the agency posts a notice of
 * intent to award (observed: DLA RFP 2026.04, open until Jan 2027 with an Intent to Award posted July 21).
 * When the agency has posted such a document, Radar marks the record awarded so it leaves the bid lane.
 */
const AWARD_DOC = /intent(ion)? to award|notice of (intended )?award|award (notice|recommendation)/i;
/** Boilerplate posted with the solicitation (protest procedures, instructions) is not an award notice. */
const AWARD_BOILERPLATE = /protest|procedure|instruction|template|sample|form/i;
const ONE_DAY_MS = 86_400_000;

/** Drops the per-user "favorite" flag so it never registers as a content change. */
/**
 * Fields that change without the notice changing: a live countdown (`timeRemaining`) and per-viewer flags. They
 * are left out of the content hash, so a record only counts as updated when the notice itself changes.
 */
const VOLATILE_FIELDS = new Set([
  "favorite",
  "timeRemaining",
  "intendToParticipate",
  "editable",
  "deletable",
  "vendorViewer",
  "canAdvertisementNotification",
  "canAdvertisementAuditLog",
  "submitted",
  "needVersionUpdate",
]);

export function hashable(raw: unknown): unknown {
  return Object.fromEntries(
    Object.entries((raw ?? {}) as Record<string, unknown>).filter(([k]) => !VOLATILE_FIELDS.has(k)),
  );
}

export function htmlToText(html: string | null | undefined): string | null {
  if (!html) return null;
  const text = html
    .replace(/<(br|\/p|\/li|\/div)\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
  return text || null;
}

export function normalizeFlAd(raw: unknown, fetchedAt: string, detailRaw?: unknown): Opportunity {
  const ad = FlAd.parse(raw);
  const detail = detailRaw === undefined || detailRaw === null ? null : FlDetail.parse(detailRaw);
  const buyerName = clean(ad.organization?.name) ?? clean(ad.agency) ?? "Unknown agency";

  const codes: ClassificationCode[] = (detail?.commodityCodes ?? []).map((c) => ({
    system: "UNSPSC",
    code: c.id,
    description: clean(c.value ?? null),
  }));
  const documents: DocumentRef[] = (detail?.docs ?? []).map((d) => ({
    filename: d.fileName ?? null,
    url: `${FL_DOWNLOAD_API}?attachmentId=${d.attachmentId}`,
    description: clean(d.description ?? null),
    postedAt: toIso(d.date ?? null),
  }));
  // An award notice must be posted at least a day after the ad opened; documents posted with the solicitation
  // itself (often protest-procedure boilerplate that mentions "intent to award") never count.
  const openedAt = Date.parse(ad.openDate ?? ad.publishDate ?? "");
  const awardPosted = (detail?.docs ?? []).some((d) => {
    const label = `${d.description ?? ""} ${d.fileName ?? ""}`;
    const postedAt = Date.parse(d.date ?? "");
    return (
      AWARD_DOC.test(label) &&
      !AWARD_BOILERPLATE.test(label) &&
      Number.isFinite(postedAt) &&
      Number.isFinite(openedAt) &&
      postedAt - openedAt >= ONE_DAY_MS
    );
  });
  const contact = detail?.responseContact
    ? {
        name: clean(detail.responseContact.responseContact ?? null),
        email: clean(detail.responseContact.email ?? null),
        phone: clean(detail.responseContact.ph ?? null),
      }
    : null;
  const status = awardPosted ? "awarded" : (STATUS[ad.status] ?? "unknown");
  const description = htmlToText(detail?.description);
  const keyDates = extractKeyDates(description, { now: fetchedAt });
  const indicators = (detail as { indicators?: Record<string, unknown> } | null)?.indicators;
  if (indicators?.preSolicitationConference === true && !keyDates.some((k) => k.kind === "pre_bid")) {
    keyDates.push({
      kind: "pre_bid",
      date: null,
      time: null,
      mandatory: null,
      note: "The posting flags a pre-solicitation conference.",
    });
  }

  return Opportunity.parse({
    id: opportunityId("fl-mfmp", String(ad.advertisementId)),
    source: "fl-mfmp",
    sourceRecordId: String(ad.advertisementId),
    solicitationNumber: clean(ad.agencyAdNumber ?? null),
    title: clean(ad.title) ?? ad.uniqueName,
    description,
    kind: FL_AD_TYPES[ad.type] ?? "other",
    kindLabel: ad.type,
    status,
    buyer: {
      name: buyerName,
      id: ad.organization?.organizationId != null ? String(ad.organization.organizationId) : null,
      // The portal mixes state agencies with cities, counties and school districts that post there too.
      level: isLocalBuyerName(buyerName) ? "local" : "state",
    },
    state: "FL",
    postedAt: toIso(ad.publishDate ?? ad.openDate ?? null),
    dueAt: toIso(ad.closeDate ?? null),
    dueTimezone: ad.closeDate ? FL_TZ : null,
    codes,
    setAside: null,
    contact,
    documents,
    version: ad.version ?? null,
    hasAddendum:
      (ad.version ?? 1) > 1 || documents.some((d) => /addend/i.test(`${d.description} ${d.filename}`)),
    keyDates,
    // The portal has no value field; a stated value is read conservatively from the description.
    estimatedValue: valueFromText(description),
    provenance: {
      source: "fl-mfmp",
      sourceUrl: `${FL_VIP_BASE}/search/bids/detail/${ad.advertisementId}`,
      fetchedAt,
      // FL_PARSE_VERSION is part of the hash, so a parser that reads new fields stores every record once more.
      contentHash: contentHash({
        list: hashable(raw),
        detail: detail ? hashable(detailRaw) : null,
        v: FL_PARSE_VERSION,
      }),
      basis: "fl-mfmp",
    },
  });
}

/** Supplies raw advertisement records and details from the public portal. */
export interface FlTransport {
  /** Raw ad objects for the given status filters, in portal order. */
  searchAds(statuses: string[], maxRecords: number): Promise<unknown[]>;
  /** Raw detail object for one ad. */
  getDetail(advertisementId: number): Promise<unknown>;
}

/** Calls the portal's public JSON endpoints directly. */
export class HttpFlTransport implements FlTransport {
  constructor(private readonly http: HttpClient) {}

  async searchAds(statuses: string[], maxRecords: number): Promise<unknown[]> {
    const out: unknown[] = [];
    for (let page = 1; out.length < maxRecords && page <= 50; page++) {
      const body = {
        pageSize: PAGE_SIZE,
        type: [],
        status: statuses,
        agency: [],
        adNumber: "",
        agencyAdvertisementNumber: "",
        title: "",
        publishedDate: "",
        openDate: "",
        endDate: "",
        commodityCodes: [],
        intendsToParticipate: "",
        assignee: "",
        page,
      };
      const rows = await this.http.json<unknown>(FL_SEARCH_API, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!Array.isArray(rows)) throw new Error("MFMP search did not return a list");
      out.push(...rows);
      if (rows.length < PAGE_SIZE) break;
    }
    return out.slice(0, maxRecords);
  }

  async getDetail(advertisementId: number): Promise<unknown> {
    return this.http.json<unknown>(`${FL_DETAIL_API}?id=${encodeURIComponent(String(advertisementId))}`);
  }
}

export interface FlMfmpOptions {
  transport: FlTransport;
  statuses?: string[];
  /** Upper bound on detail requests per run; biddable ads are enriched first, in portal order. */
  maxDetails?: number;
  now?: () => string;
  /** Called as detail requests progress (every 25 and at the end), for run logs. */
  onProgress?: (p: { listed: number; detailsDone: number }) => void;
}

export class FlMfmpConnector implements SourceConnector {
  readonly id = "fl-mfmp" as const;
  readonly basis = "fl-mfmp";
  constructor(private readonly opts: FlMfmpOptions) {}

  async fetch(window: FetchWindow = {}): Promise<ConnectorRun> {
    const fetchedAt = (this.opts.now ?? (() => new Date().toISOString()))();
    const max = window.maxRecords ?? 1000;
    const raw = await this.opts.transport.searchAds(this.opts.statuses ?? ["OPEN", "PREVIEW"], max);
    // Complete only if the result was not cut off by the cap and no date filter was applied.
    const run: ConnectorRun = {
      source: this.id,
      opportunities: [],
      rejected: [],
      fetchedAt,
      complete: false,
      partialIds: [],
    };
    let detailBudget = this.opts.maxDetails ?? 1000;
    let detailsDone = 0;
    this.opts.onProgress?.({ listed: raw.length, detailsDone });
    for (const r of raw) {
      try {
        const ad = FlAd.parse(r);
        // Details carry codes, description and documents. Intel notices (decisions, meetings) don't need them.
        let detail: unknown = null;
        const kind = FL_AD_TYPES[ad.type] ?? "other";
        const wantsDetail = !isIntel(kind);
        if (wantsDetail && detailBudget > 0) {
          detailBudget--;
          try {
            detail = await this.opts.transport.getDetail(ad.advertisementId);
          } catch (err) {
            // Keep the list-level record; note the missing detail for diagnosis.
            run.rejected.push({
              sourceRecordId: String(ad.advertisementId),
              error: `detail: ${(err as Error).message.slice(0, 250)}`,
            });
          }
          if (++detailsDone % 25 === 0) this.opts.onProgress?.({ listed: raw.length, detailsDone });
        }
        const opp = normalizeFlAd(r, fetchedAt, detail);
        if (wantsDetail && detail === null) run.partialIds!.push(opp.id);
        if (window.since && opp.postedAt && opp.postedAt < window.since && !opp.hasAddendum) continue;
        run.opportunities.push(opp);
      } catch (err) {
        const id = (r as { advertisementId?: number } | null)?.advertisementId;
        run.rejected.push({
          sourceRecordId: id != null ? String(id) : null,
          error: (err as Error).message.slice(0, 300),
        });
      }
    }
    this.opts.onProgress?.({ listed: raw.length, detailsDone });
    // Complete only if nothing was cut off, no date filter applied, and every list row parsed (detail
    // failures alone don't count: those records are still seen, just kept at their stored version).
    run.complete =
      raw.length > 0 &&
      raw.length < max &&
      !window.since &&
      run.rejected.every((r) => r.error.startsWith("detail:"));
    return run;
  }
}
