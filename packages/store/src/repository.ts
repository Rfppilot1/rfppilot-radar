import type { Decision, FirmProfile, Match, Opportunity } from "@radar/core";

export interface UpsertResult {
  inserted: string[];
  updated: string[];
  unchanged: number;
}

export interface CloseResult {
  closed: string[];
  /** True when the safety limit stopped the close; nothing was changed. */
  refused: boolean;
  wouldClose: number;
  open: number;
}

/** Default safety limit for closing records by absence in one run. */
export const MAX_CLOSE_SHARE = 0.2;

export interface OpportunityQuery {
  states?: string[];
  sources?: string[];
  openOnly?: boolean;
  dueAfter?: string;
  /** Row cap; "all" for worker reads that must see every row (scoring, digests). Default 500. */
  limit?: number | "all";
}

export interface MatchQuery {
  bands?: Match["band"][];
  lane?: Match["lane"];
  /** Only matches that first reached strong/possible on/after this instant ("new since last digest"). */
  firstGoodSince?: string;
  /**
   * Only matches whose opportunity is still actionable at this instant: open or preview, and not past its
   * due date. API and digest reads set this; administrative reads do not.
   */
  activeAt?: string;
  /** Row cap; "all" for worker reads that must see every row (scoring, digests). Default 500. */
  limit?: number | "all";
}

export interface StoredMatch extends Match {
  firstMatchedAt: string;
  firstGoodAt: string | null;
}

export interface StoredDecision extends Decision {
  hashAtDecision: string;
}

/** A held worker lock; release it when the run ends. */
export interface RunLock {
  release(): Promise<void>;
}

export interface DeliveryRecord {
  tenantId: string;
  profileId: string;
  recipient: string;
  generatedAt: string;
  messageId: string | null;
}

export interface IngestRunRecord {
  source: string;
  startedAt: string;
  finishedAt: string;
  fetched: number;
  inserted: number;
  updated: number;
  closed: number;
  rejected: number;
  complete: boolean;
  error: string | null;
}

/**
 * Persistence boundary. Two implementations ship: Postgres (production) and in-memory (tests, demos).
 *
 * Tenant isolation: every tenant-owned record is keyed by (tenantId, profileId). Every profile-scoped call
 * takes the tenant id; a profile that does not exist for that tenant behaves as not found, and two tenants
 * may use the same profile id without affecting each other.
 */
export interface Repository {
  upsertOpportunities(opps: Opportunity[], seenAt: string): Promise<UpsertResult>;
  /**
   * Marks open/preview records of `source` that were not seen since `seenSince` as closed. Only call after a
   * complete run (the connector saw the source's full current list). Refuses, closing nothing, when more than
   * `maxShare` of the source's open records would close at once: that pattern means a bad response, not a
   * wave of cancellations.
   */
  closeMissing(source: string, seenSince: string, maxShare?: number): Promise<CloseResult>;
  /** Marks records as seen at `seenAt` without changing their content. */
  touchSeen(ids: string[], seenAt: string): Promise<void>;
  getOpportunity(id: string): Promise<Opportunity | null>;
  getOpportunities(ids: string[]): Promise<Map<string, Opportunity>>;
  listOpportunities(q: OpportunityQuery): Promise<Opportunity[]>;
  /** Ids of opportunities with a new stored version (content change or close) at or after `since`. */
  changedSince(since: string): Promise<string[]>;
  /** For each id, the latest stored version from before `before`; ids first seen later are absent. */
  versionsBefore(ids: string[], before: string): Promise<Map<string, Opportunity>>;

  upsertProfile(profile: FirmProfile, at: string): Promise<void>;
  getProfile(tenantId: string, profileId: string): Promise<FirmProfile | null>;
  listProfiles(tenantId: string): Promise<FirmProfile[]>;
  /** Every profile across tenants. For the scheduled worker only; never exposed through the API. */
  listAllProfilesForWorker(): Promise<FirmProfile[]>;

  saveMatches(tenantId: string, matches: Match[]): Promise<void>;
  listMatches(tenantId: string, profileId: string, q?: MatchQuery): Promise<StoredMatch[]>;
  getMatch(tenantId: string, profileId: string, opportunityId: string): Promise<StoredMatch | null>;

  saveDecision(tenantId: string, decision: Decision): Promise<StoredDecision>;
  listDecisions(tenantId: string, profileId: string): Promise<StoredDecision[]>;

  lastDigestAt(tenantId: string, profileId: string): Promise<string | null>;
  recordDigest(tenantId: string, profileId: string, generatedAt: string): Promise<void>;

  /**
   * When `recipient` last received this profile's digest. Falls back to the profile's last recorded digest for
   * recipients with no delivery rows yet (deliveries were first recorded per recipient in migration 003).
   */
  lastDeliveryAt(tenantId: string, profileId: string, recipient: string): Promise<string | null>;
  recordDelivery(d: DeliveryRecord): Promise<void>;

  recordRun(run: IngestRunRecord): Promise<void>;
  /** Finish time of the source's latest complete run, or null if it never had one. */
  lastCompleteRunAt(source: string): Promise<string | null>;
  /** Finish time of the source's latest run that ended without an error, complete or not. */
  lastSuccessfulRunAt(source: string): Promise<string | null>;

  /**
   * Takes the named worker lock without waiting, or returns null when another process holds it. Keeps two
   * overlapping scheduled runs from both ingesting and both sending email.
   */
  tryRunLock(name: string): Promise<RunLock | null>;
  /** Throws when the store cannot be reached. Used by the API health check. */
  ping(): Promise<void>;
  close(): Promise<void>;
}

export class NotFoundError extends Error {
  constructor(what: string) {
    super(`${what} not found`);
    this.name = "NotFoundError";
  }
}

export const GOOD_BANDS: ReadonlySet<Match["band"]> = new Set(["strong", "possible"]);
export const ACTIVE_STATUSES: ReadonlySet<Opportunity["status"]> = new Set(["open", "preview"]);
