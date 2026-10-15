import { BANDS } from "./scoring.js";
import type { Decision, Match, Opportunity } from "./schema.js";
import { daysBetween } from "./text.js";

/**
 * Second-look review: the safeguard against one reviewer's point of view silently filtering out good work.
 *
 * It surfaces three kinds of item for a second reviewer:
 *  1. passed:    the firm passed on something Radar rated strong or possible (with the pass reason shown);
 *  2. changed:   something the firm passed on has since changed (new version/addendum or new due date);
 *  3. near_miss: something auto-filtered as weak that scored within NEAR_MISS_MARGIN of the threshold.
 */
export const NEAR_MISS_MARGIN = 5;

export interface SecondLookItem {
  opportunity: Opportunity;
  match: Match;
  decision: Decision | null;
  why: "passed" | "changed" | "near_miss";
  note: string;
}

export interface SecondLookInput {
  opportunities: Map<string, Opportunity>;
  matches: Match[];
  decisions: Decision[];
  /** Content hash of each opportunity at the time it was decided, keyed by opportunity id. */
  hashAtDecision?: Map<string, string>;
  now?: string;
  windowDays?: number;
}

export function secondLook(input: SecondLookInput): SecondLookItem[] {
  const now = input.now ?? new Date().toISOString();
  const windowDays = input.windowDays ?? 90;
  const decisions = new Map(input.decisions.map((d) => [`${d.profileId}|${d.opportunityId}`, d]));
  const items: SecondLookItem[] = [];

  for (const m of input.matches) {
    const opp = input.opportunities.get(m.opportunityId);
    if (!opp || m.band === "excluded" || m.lane !== "bid") continue;
    if (opp.dueAt && daysBetween(now, opp.dueAt) < 0) continue;
    const d = decisions.get(`${m.profileId}|${m.opportunityId}`) ?? null;

    if (d?.decision === "pass") {
      if (daysBetween(d.decidedAt, now) > windowDays) continue;
      const before = input.hashAtDecision?.get(opp.id);
      if (before && before !== opp.provenance.contentHash) {
        items.push({
          opportunity: opp,
          match: m,
          decision: d,
          why: "changed",
          note: "Changed since the pass decision (addendum, date or scope)",
        });
      } else if (m.band === "strong" || m.band === "possible") {
        items.push({
          opportunity: opp,
          match: m,
          decision: d,
          why: "passed",
          note: `Rated ${m.band} (${m.score}) but passed${d.reason ? `: ${d.reason}` : ""}`,
        });
      }
    } else if (!d && m.band === "weak" && m.score >= BANDS.possible - NEAR_MISS_MARGIN) {
      items.push({
        opportunity: opp,
        match: m,
        decision: null,
        why: "near_miss",
        note: `Scored ${m.score}, just under the ${BANDS.possible} cutoff`,
      });
    }
  }

  const order = { changed: 0, passed: 1, near_miss: 2 } as const;
  return items.sort((a, b) => order[a.why] - order[b.why] || b.match.score - a.match.score);
}
