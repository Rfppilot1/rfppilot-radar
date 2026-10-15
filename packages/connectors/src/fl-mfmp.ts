import { Opportunity, type NoticeKind, type OpportunityStatus } from "@radar/core";
import { z } from "zod";
import { opportunityId, type ConnectorRun, type FetchWindow, type SourceConnector } from "./types.js";
import { clean, contentHash, toIso } from "./util.js";

/**
 * Florida MyFloridaMarketPlace Vendor Information Portal (VIP), "State of Florida Advertisements".
 * Public search; no sign-in. Replaced the legacy Vendor Bid System on March 28, 2022.
 *
 * The public search page obtains its data through an anonymous session established by the page itself,
 * so collection runs through a transport that drives the public page (see PlaywrightFlTransport) rather
 * than calling the service directly. See docs/SOURCES.md#fl-mfmp.
 */
export const FL_VIP_BASE = "https://vendor.myfloridamarketplace.com";
export const FL_SEARCH_URL = `${FL_VIP_BASE}/search/bids`;
export const FL_TZ = "America/New_York";

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

/** Field names exclude the volatile per-user "favorite" flag so it never registers as a content change. */
function hashable(raw: unknown): unknown {
  const { favorite: _favorite, ...rest } = raw as Record<string, unknown>;
  return rest;
}

export function normalizeFlAd(raw: unknown, fetchedAt: string): Opportunity {
  const ad = FlAd.parse(raw);
  const buyerName = clean(ad.organization?.name) ?? clean(ad.agency) ?? "Unknown agency";
  return Opportunity.parse({
    id: opportunityId("fl-mfmp", String(ad.advertisementId)),
    source: "fl-mfmp",
    sourceRecordId: String(ad.advertisementId),
    solicitationNumber: clean(ad.agencyAdNumber ?? null),
    title: clean(ad.title) ?? ad.uniqueName,
    description: null,
    kind: FL_AD_TYPES[ad.type] ?? "other",
    kindLabel: ad.type,
    status: STATUS[ad.status] ?? "unknown",
    buyer: {
      name: buyerName,
      id: ad.organization?.organizationId != null ? String(ad.organization.organizationId) : null,
      level: "state",
    },
    state: "FL",
    postedAt: toIso(ad.publishDate ?? ad.openDate ?? null),
    dueAt: toIso(ad.closeDate ?? null),
    dueTimezone: ad.closeDate ? FL_TZ : null,
    codes: [],
    setAside: null,
    contact: null,
    documents: [],
    version: ad.version ?? null,
    hasAddendum: (ad.version ?? 1) > 1,
    provenance: {
      source: "fl-mfmp",
      sourceUrl: `${FL_VIP_BASE}/search/bids/detail/${ad.advertisementId}`,
      fetchedAt,
      contentHash: contentHash(hashable(raw)),
      basis: "fl-mfmp",
    },
  });
}

/** Supplies raw advertisement records from the public portal. */
export interface FlTransport {
  /** Returns raw ad objects for the given status filters, in portal order. */
  searchAds(statuses: string[], maxRecords: number): Promise<unknown[]>;
}

export interface FlMfmpOptions {
  transport: FlTransport;
  statuses?: string[];
  now?: () => string;
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
      complete: raw.length > 0 && raw.length < max && !window.since,
    };
    for (const r of raw) {
      try {
        const opp = normalizeFlAd(r, fetchedAt);
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
    return run;
  }
}

/**
 * Drives the public search page in a headless browser. The page obtains an anonymous session URL for its
 * search service; we let the page run one ordinary search, then, inside the page, repeat that same request
 * (same URL, same JSON body shape, same JSON content type) with the status filter and page size we need
 * (100 per page, paced, with a per-request timeout). Only the status and page-size values differ from the
 * page's own request. Requires the optional dependency `playwright-core` and Chromium.
 */
export class PlaywrightFlTransport implements FlTransport {
  constructor(
    private readonly opts: {
      executablePath?: string;
      userAgent: string;
      timeoutMs?: number;
      pauseMs?: number;
    },
  ) {}

  async searchAds(statuses: string[], maxRecords: number): Promise<unknown[]> {
    const { chromium } = await import("playwright-core");
    const browser = await chromium.launch({ executablePath: this.opts.executablePath, headless: true });
    try {
      const page = await browser.newPage({ userAgent: this.opts.userAgent });
      await page.goto(FL_SEARCH_URL, { waitUntil: "networkidle", timeout: this.opts.timeoutMs ?? 60_000 });
      const searchRequest = page.waitForRequest(
        (r) => r.method() === "POST" && /"page"\s*:/.test(r.postData() ?? ""),
        { timeout: 30_000 },
      );
      await page.getByRole("button", { name: /^\s*search\s*$/i }).click();
      const req = await searchRequest;
      const template = {
        url: req.url(),
        body: JSON.parse(req.postData() ?? "{}") as Record<string, unknown>,
      };
      return await page.evaluate(
        async ({ template, statuses, maxRecords, pauseMs }) => {
          const out: unknown[] = [];
          for (let p = 1; out.length < maxRecords && p <= 50; p++) {
            const res = await fetch(template.url, {
              method: "POST",
              headers: { accept: "application/json", "content-type": "application/json" },
              body: JSON.stringify({ ...template.body, status: statuses, pageSize: 100, page: p }),
              signal: AbortSignal.timeout(30_000),
            });
            if (!res.ok) throw new Error(`MFMP search returned ${res.status}`);
            const rows = (await res.json()) as unknown[];
            out.push(...rows);
            if (rows.length < 100) break;
            await new Promise((r) => setTimeout(r, pauseMs));
          }
          return out.slice(0, maxRecords);
        },
        { template, statuses, maxRecords, pauseMs: this.opts.pauseMs ?? 1000 },
      );
    } finally {
      await browser.close();
    }
  }
}
