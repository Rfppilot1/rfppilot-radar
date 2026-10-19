import {
  FirmProfile,
  applyReview,
  resolveScoring,
  daysBetween,
  diffOpportunity,
  needsReview,
  profileHash,
  scoreOpportunity,
  secondLook,
  type Digest,
  type DigestChange,
  type DigestEntry,
  type Match,
  type Opportunity,
  type RelevanceReviewer,
} from "@radar/core";
import { GOOD_BANDS, type Repository, type UpsertResult } from "./repository.js";

/** Structural shape of a connector run, so this package does not depend on the connectors package. */
export interface RunLike {
  source: string;
  opportunities: Opportunity[];
  rejected: { sourceRecordId: string | null; error: string }[];
  fetchedAt: string;
  complete: boolean;
  partialIds?: string[];
}

export interface IngestResult extends UpsertResult {
  closed: string[];
  /** Set when the safety limit refused to close records by absence (likely a bad source response). */
  closeRefused: { wouldClose: number; open: number } | null;
}

/**
 * Persists one connector run and logs it. After a complete run, open records of that source that the run did
 * not see are closed (cancelled, awarded or withdrawn upstream), so they stop appearing as matches.
 */
export async function ingestRun(repo: Repository, run: RunLike, startedAt: string): Promise<IngestResult> {
  // Partially fetched records never overwrite a fuller stored version; they only count as seen.
  const partial = new Set(run.partialIds ?? []);
  const stored = partial.size ? await repo.getOpportunities([...partial]) : new Map();
  const keep = run.opportunities.filter((o) => partial.has(o.id) && stored.has(o.id));
  const write = run.opportunities.filter((o) => !(partial.has(o.id) && stored.has(o.id)));
  const result = await repo.upsertOpportunities(write, run.fetchedAt);
  await repo.touchSeen(
    keep.map((o) => o.id),
    run.fetchedAt,
  );
  result.unchanged += keep.length;
  // Never close on an empty run, whatever the connector says.
  const close =
    run.complete && run.opportunities.length > 0 ? await repo.closeMissing(run.source, run.fetchedAt) : null;
  const closed = close?.closed ?? [];
  await repo.recordRun({
    source: run.source,
    startedAt,
    finishedAt: new Date().toISOString(),
    fetched: run.opportunities.length,
    inserted: result.inserted.length,
    updated: result.updated.length,
    closed: closed.length,
    rejected: run.rejected.length,
    complete: run.complete,
    error: close?.refused
      ? `close refused: ${close.wouldClose} of ${close.open} open records missing from this run`
      : null,
  });
  return {
    ...result,
    closed,
    closeRefused: close?.refused ? { wouldClose: close.wouldClose, open: close.open } : null,
  };
}

export interface RescoreOptions {
  reviewer?: RelevanceReviewer;
  /** Cap on reviewer calls per run, to bound cost. */
  maxReviews?: number;
  onReviewError?: (opportunityId: string, err: Error) => void;
}

/**
 * Scores open opportunities in a profile's geography and stores the matches. With a reviewer, matches the
 * rules rate below strong get a semantic review; a review is reused while both the opportunity and the
 * profile fields the reviewer saw are unchanged.
 */
export async function rescoreProfile(
  repo: Repository,
  profile: FirmProfile,
  now: string,
  o: RescoreOptions = {},
): Promise<number> {
  const opps = await repo.listOpportunities({
    states: profile.states,
    openOnly: true,
    dueAfter: now,
    limit: 10_000,
  });
  const previous = new Map(
    (
      await repo.listMatches(profile.tenantId, profile.id, {
        bands: ["strong", "possible", "weak", "excluded"],
        limit: 100_000,
      })
    ).map((m) => [m.opportunityId, m] as const),
  );
  const pHash = profileHash(profile);
  const { bands } = resolveScoring(profile);
  let budget = o.maxReviews ?? 50;
  const matches: Match[] = [];
  for (const opp of opps) {
    let m = scoreOpportunity(opp, profile, { now });
    if (o.reviewer && needsReview(m)) {
      const key = { contentHash: opp.provenance.contentHash, profileHash: pHash };
      const prior = previous.get(opp.id)?.review;
      if (prior && prior.contentHash === key.contentHash && prior.profileHash === key.profileHash) {
        m = applyReview(m, prior, key, bands);
      } else if (budget > 0) {
        budget--;
        try {
          m = applyReview(m, await o.reviewer.review(opp, profile), key, bands);
        } catch (err) {
          o.onReviewError?.(opp.id, err as Error);
        }
      }
    }
    matches.push(m);
  }
  await repo.saveMatches(profile.tenantId, matches);
  return matches.length;
}

export interface DigestOptions {
  /** New-match window start. Use the previous digest time (`repo.lastDigestAt`) so no item is missed or repeated. */
  since: string;
  now: string;
  closingWithinDays?: number;
  /**
   * Federal (SAM.gov) notices reach the email only at or above this fit score; below it they count as screened
   * out. Federal postings match broad consulting codes far more often than they fit a state and local firm.
   * Default 45.
   */
  federalMinScore?: number;
}

export const FEDERAL_MIN_SCORE = 45;

export async function buildDigest(
  repo: Repository,
  tenantId: string,
  profileId: string,
  o: DigestOptions,
): Promise<Digest> {
  const profile = await repo.getProfile(tenantId, profileId);
  if (!profile) throw new Error("Profile not found");
  const matches = await repo.listMatches(tenantId, profileId, {
    bands: ["strong", "possible", "weak", "excluded"],
    activeAt: o.now,
    limit: 5000,
  });
  const decisions = await repo.listDecisions(tenantId, profileId);
  const decided = new Map(decisions.map((d) => [d.opportunityId, d]));
  const opps = await repo.getOpportunities(matches.map((m) => m.opportunityId));

  const entries = (pred: (e: DigestEntry & { firstGood: string | null }) => boolean): DigestEntry[] =>
    matches
      .map((m) => ({ opportunity: opps.get(m.opportunityId)!, match: m, firstGood: m.firstGoodAt }))
      .filter((e) => e.opportunity && pred(e))
      .map(({ opportunity, match }) => ({ opportunity, match }));

  const federalMin = o.federalMinScore ?? FEDERAL_MIN_SCORE;
  const firstSeen = new Map(matches.map((m) => [m.opportunityId, m.firstMatchedAt] as const));
  const clearsBar = (m: Match) => opps.get(m.opportunityId)?.source !== "sam-gov" || m.score >= federalMin;
  const good = (b: Match["band"], m?: Match) => GOOD_BANDS.has(b) && (!m || clearsBar(m));
  const isNew = (firstGood: string | null) => firstGood !== null && firstGood >= o.since;
  const notPassed = (id: string) => decided.get(id)?.decision !== "pass";
  const window = o.closingWithinDays ?? 7;

  // At-a-glance: every open, biddable notice Radar read for this profile, by fit band and by source.
  const open = matches.filter((m) => {
    const opp = opps.get(m.opportunityId);
    return opp && m.lane === "bid" && notPassed(opp.id) && (opp.dueAt === null || opp.dueAt >= o.now);
  });
  const bySource: Record<string, number> = {};
  for (const m of open) {
    const src = opps.get(m.opportunityId)!.source;
    bySource[src] = (bySource[src] ?? 0) + 1;
  }
  const glance = {
    screened: open.length,
    strong: open.filter((m) => m.band === "strong" && clearsBar(m)).length,
    possible: open.filter((m) => m.band === "possible" && clearsBar(m)).length,
    notFit: open.filter((m) => !good(m.band, m)).length,
    bySource,
  };

  // Change alerts: anything the reader is tracking (a strong or possible match, or a bid they chose to
  // pursue) whose posting changed since their last digest. New matches are listed as new instead.
  const newIds = new Set(
    matches.filter((m) => good(m.band, m) && isNew(m.firstGoodAt)).map((m) => m.opportunityId),
  );
  const changedIds = new Set(await repo.changedSince(o.since));
  const tracked = changedIds.size
    ? (
        await repo.listMatches(tenantId, profileId, {
          bands: ["strong", "possible", "weak", "excluded"],
          limit: 100_000,
        })
      ).filter(
        (m) =>
          changedIds.has(m.opportunityId) &&
          !newIds.has(m.opportunityId) &&
          notPassed(m.opportunityId) &&
          (good(m.band, m) || ["pursue", "watch"].includes(decided.get(m.opportunityId)?.decision ?? "")),
      )
    : [];
  const trackedIds = tracked.map((m) => m.opportunityId);
  const [current, baseline] = await Promise.all([
    repo.getOpportunities(trackedIds),
    repo.versionsBefore(trackedIds, o.since),
  ]);
  const changed: DigestChange[] = tracked
    .flatMap((m) => {
      const cur = current.get(m.opportunityId);
      const prev = baseline.get(m.opportunityId);
      if (!cur || !prev) return [];
      const changes = diffOpportunity(prev, cur, o.now);
      return changes.length ? [{ opportunity: cur, match: m, changes }] : [];
    })
    .sort((a, b) => b.match.score - a.match.score);

  const isClosing = (dueAt: string | null) =>
    dueAt !== null && daysBetween(o.now, dueAt) >= 0 && daysBetween(o.now, dueAt) <= window;
  const strongOpen = entries(
    (e) =>
      e.match.lane === "bid" &&
      e.match.band === "strong" &&
      clearsBar(e.match) &&
      !isNew(e.firstGood) &&
      notPassed(e.opportunity.id) &&
      (e.opportunity.dueAt === null || e.opportunity.dueAt >= o.now) &&
      !isClosing(e.opportunity.dueAt),
  )
    .sort((a, b) => b.match.score - a.match.score)
    .slice(0, 10);

  return {
    profileName: profile.name,
    generatedAt: o.now,
    glance,
    changed,
    strongOpen,
    bands: resolveScoring(profile).bands,
    newMatches: entries(
      (e) =>
        e.match.lane === "bid" &&
        good(e.match.band, e.match) &&
        isNew(e.firstGood) &&
        notPassed(e.opportunity.id),
    ),
    closingSoon: entries(
      (e) =>
        e.match.lane === "bid" &&
        good(e.match.band, e.match) &&
        notPassed(e.opportunity.id) &&
        e.opportunity.dueAt !== null &&
        daysBetween(o.now, e.opportunity.dueAt) >= 0 &&
        daysBetween(o.now, e.opportunity.dueAt) <= window,
    ),
    intel: entries((e) => e.match.lane === "intel" && good(e.match.band, e.match) && isNew(e.firstGood)),
    // Near misses are shown once, on the day they first appear, and never for federal notices under the bar;
    // pass decisions that changed are shown whenever they apply.
    secondLook: secondLook({
      opportunities: opps,
      matches,
      decisions,
      hashAtDecision: new Map(decisions.map((d) => [d.opportunityId, d.hashAtDecision])),
      now: o.now,
      possibleCutoff: resolveScoring(profile).bands.possible,
    }).filter(
      (s) =>
        s.why !== "near_miss" || (clearsBar(s.match) && (firstSeen.get(s.opportunity.id) ?? "") >= o.since),
    ),
  };
}
