import {
  FirmProfile,
  applyReview,
  daysBetween,
  needsReview,
  profileHash,
  scoreOpportunity,
  secondLook,
  type Digest,
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
  const result = await repo.upsertOpportunities(run.opportunities, run.fetchedAt);
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
  let budget = o.maxReviews ?? 50;
  const matches: Match[] = [];
  for (const opp of opps) {
    let m = scoreOpportunity(opp, profile, { now });
    if (o.reviewer && needsReview(m)) {
      const key = { contentHash: opp.provenance.contentHash, profileHash: pHash };
      const prior = previous.get(opp.id)?.review;
      if (prior && prior.contentHash === key.contentHash && prior.profileHash === key.profileHash) {
        m = applyReview(m, prior, key);
      } else if (budget > 0) {
        budget--;
        try {
          m = applyReview(m, await o.reviewer.review(opp, profile), key);
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
}

export async function buildDigest(
  repo: Repository,
  tenantId: string,
  profileId: string,
  o: DigestOptions,
): Promise<Digest> {
  const profile = await repo.getProfile(tenantId, profileId);
  if (!profile) throw new Error("Profile not found");
  const matches = await repo.listMatches(tenantId, profileId, {
    bands: ["strong", "possible", "weak"],
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

  const good = (b: Match["band"]) => GOOD_BANDS.has(b);
  const isNew = (firstGood: string | null) => firstGood !== null && firstGood >= o.since;
  const notPassed = (id: string) => decided.get(id)?.decision !== "pass";
  const window = o.closingWithinDays ?? 7;

  return {
    profileName: profile.name,
    generatedAt: o.now,
    newMatches: entries(
      (e) =>
        e.match.lane === "bid" && good(e.match.band) && isNew(e.firstGood) && notPassed(e.opportunity.id),
    ),
    closingSoon: entries(
      (e) =>
        e.match.lane === "bid" &&
        good(e.match.band) &&
        notPassed(e.opportunity.id) &&
        e.opportunity.dueAt !== null &&
        daysBetween(o.now, e.opportunity.dueAt) >= 0 &&
        daysBetween(o.now, e.opportunity.dueAt) <= window,
    ),
    intel: entries((e) => e.match.lane === "intel" && good(e.match.band) && isNew(e.firstGood)),
    secondLook: secondLook({
      opportunities: opps,
      matches,
      decisions,
      hashAtDecision: new Map(decisions.map((d) => [d.opportunityId, d.hashAtDecision])),
      now: o.now,
    }),
  };
}
