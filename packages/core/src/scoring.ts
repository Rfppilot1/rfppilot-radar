import {
  FirmProfile,
  isIntel,
  type FirmProfileInput,
  type Match,
  type NoticeKind,
  type Opportunity,
  type Reason,
  ScoringOverrides,
} from "./schema.js";
import { daysBetween, hasPhrase, normalize } from "./text.js";

/**
 * Deterministic, explainable fit scoring.
 *
 * Every point in the score is attached to a human-readable reason, so a reviewer can see exactly why an
 * opportunity surfaced (or did not). Bump SCORER_VERSION whenever weights or rules change; stored matches
 * record the version that produced them.
 */
export const SCORER_VERSION = "2026.10.1";

export const WEIGHTS = {
  codePrimary: 35,
  codeExtra: 5,
  codeExtraCap: 10,
  capability: 12,
  capabilityTitleMultiplier: 1.5,
  capabilityCap: 45,
  knownBuyer: 8,
  exclusion: -40,
  tightTiming: -15,
} as const;

export const KIND_POINTS: Partial<Record<NoticeKind, number>> = {
  rfp: 7,
  itn: 7,
  soq: 7,
  rfq: 5,
  rfi: 4,
  presolicitation: 4,
  sources_sought: 4,
};

export const BANDS = { strong: 55, possible: 30 } as const;

export interface ResolvedScoring {
  weights: { [K in keyof typeof WEIGHTS]: number };
  bands: { strong: number; possible: number };
  kindPoints: Partial<Record<NoticeKind, number>>;
}

/** Defaults overlaid with the profile's own scoring overrides. */
export function resolveScoring(profile: { scoring?: unknown }): ResolvedScoring {
  const o = ScoringOverrides.parse(profile.scoring ?? {});
  const bands = { ...BANDS, ...o.bands };
  if (bands.possible >= bands.strong)
    throw new Error(`Scoring bands: "possible" (${bands.possible}) must be below "strong" (${bands.strong})`);
  return { weights: { ...WEIGHTS, ...o.weights }, bands, kindPoints: { ...KIND_POINTS, ...o.kindPoints } };
}

export interface ScoreOptions {
  now?: string;
}

export function scoreOpportunity(
  opp: Opportunity,
  profileInput: FirmProfileInput,
  options: ScoreOptions = {},
): Match {
  const profile = FirmProfile.parse(profileInput);
  const { weights: WEIGHTS_, bands: BANDS_, kindPoints } = resolveScoring(profile);
  const now = options.now ?? new Date().toISOString();
  const reasons: Reason[] = [];
  const lane: Match["lane"] = isIntel(opp.kind) ? "intel" : "bid";
  let hardExclude = false;

  // Geography: state and local buyers must be in the profile's states; federal needs includeFederal and a
  // place of performance that is unstated or in the profile's states.
  const inStates = opp.state !== null && profile.states.includes(opp.state);
  if (opp.buyer.level === "federal") {
    if (!profile.includeFederal) {
      hardExclude = true;
      reasons.push({
        factor: "geography",
        points: 0,
        detail: "Federal opportunities are turned off for this profile",
      });
    } else if (opp.state !== null && !inStates) {
      hardExclude = true;
      reasons.push({
        factor: "geography",
        points: 0,
        detail: `Place of performance ${opp.state} is outside target states`,
      });
    }
  } else if (!inStates) {
    hardExclude = true;
    reasons.push({
      factor: "geography",
      points: 0,
      detail: `Buyer state ${opp.state ?? "unknown"} is outside target states`,
    });
  }

  // Status and timing.
  if (opp.status === "closed" || opp.status === "awarded" || opp.status === "cancelled") {
    if (lane === "bid") hardExclude = true;
    reasons.push({ factor: "status", points: 0, detail: `Status is ${opp.status}` });
  }
  if (opp.dueAt && lane === "bid") {
    const days = daysBetween(now, opp.dueAt);
    if (days < 0) {
      hardExclude = true;
      reasons.push({ factor: "timing", points: 0, detail: "Response deadline has passed" });
    } else if (days < profile.minDaysToRespond) {
      reasons.push({
        factor: "timing",
        points: WEIGHTS_.tightTiming,
        detail: `Only ${Math.floor(days)} day(s) to respond; profile needs ${profile.minDaysToRespond}`,
      });
    }
  }

  // Classification codes (prefix match, best weight wins; extra distinct matches add a little).
  const codeHits: { label: string; weight: number }[] = [];
  for (const c of opp.codes) {
    for (const target of profile.codes) {
      if (c.system === target.system && c.code.startsWith(target.prefix)) {
        codeHits.push({
          label: `${c.system} ${c.code}${c.description ? ` (${c.description})` : ""}`,
          weight: target.weight,
        });
        break;
      }
    }
  }
  if (codeHits.length > 0) {
    codeHits.sort((a, b) => b.weight - a.weight);
    const [best, ...rest] = codeHits;
    reasons.push({
      factor: "code",
      points: round(WEIGHTS_.codePrimary * best!.weight),
      detail: `Classification matches profile: ${best!.label}`,
    });
    const extra = Math.min(WEIGHTS_.codeExtraCap, rest.length * WEIGHTS_.codeExtra);
    if (extra > 0) {
      reasons.push({ factor: "code", points: extra, detail: `${rest.length} more matching code(s)` });
    }
  }

  // Capability phrases: title matches count more than description-only matches.
  const title = normalize(opp.title);
  const body = normalize(`${opp.title} ${opp.description ?? ""}`);
  let capPoints = 0;
  const capHits: string[] = [];
  for (const cap of profile.capabilities) {
    if (hasPhrase(title, cap.phrase)) {
      capPoints += WEIGHTS_.capability * cap.weight * WEIGHTS_.capabilityTitleMultiplier;
      capHits.push(`"${cap.phrase}" (title)`);
    } else if (hasPhrase(body, cap.phrase)) {
      capPoints += WEIGHTS_.capability * cap.weight;
      capHits.push(`"${cap.phrase}"`);
    }
  }
  if (capHits.length > 0) {
    reasons.push({
      factor: "capability",
      points: round(Math.min(WEIGHTS_.capabilityCap, capPoints)),
      detail: `Matches capabilities: ${capHits.join(", ")}`,
    });
  }

  // Exclusions.
  const exclusionHits = profile.exclusions.filter((p) => hasPhrase(body, p));
  if (exclusionHits.length > 0) {
    reasons.push({
      factor: "exclusion",
      points: WEIGHTS_.exclusion,
      detail: `Contains excluded term(s): ${exclusionHits.map((p) => `"${p}"`).join(", ")}`,
    });
  }

  // Known buyer.
  const buyer = normalize(opp.buyer.name);
  const buyerHit = profile.knownBuyers.find((b) => hasPhrase(buyer, b));
  if (buyerHit) {
    reasons.push({
      factor: "buyer",
      points: WEIGHTS_.knownBuyer,
      detail: `Past or current buyer: ${buyerHit}`,
    });
  }

  // Notice kind.
  const kp = kindPoints[opp.kind];
  if (kp) {
    reasons.push({ factor: "kind", points: kp, detail: `Notice type: ${opp.kindLabel ?? opp.kind}` });
  }

  const raw = reasons.reduce((sum, r) => sum + r.points, 0);
  const hasFitSignal = codeHits.length > 0 || capHits.length > 0;
  const score = hasFitSignal ? clamp(round(raw), 0, 100) : 0;

  let band: Match["band"];
  if (hardExclude) band = "excluded";
  else if (exclusionHits.length > 0 && score < BANDS_.strong) band = "excluded";
  else if (score >= BANDS_.strong) band = "strong";
  else if (score >= BANDS_.possible) band = "possible";
  else band = "weak";

  return {
    opportunityId: opp.id,
    profileId: profile.id,
    score,
    band,
    lane,
    reasons,
    scoredAt: now,
    scorerVersion: SCORER_VERSION,
  };
}

/** Whether a notice can be bid on, as opposed to market intelligence. Same rule as the match lane. */
export function isBiddable(kind: NoticeKind): boolean {
  return !isIntel(kind);
}

function round(n: number): number {
  return Math.round(n * 10) / 10;
}
function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}
