import { z } from "zod";

/**
 * Canonical opportunity model shared by every Radar source and by the RFP Pilot handoff.
 *
 * Design rules:
 *  - Every record carries provenance: where it came from, when, and under what basis we collected it.
 *  - Source-native identifiers and codes are preserved verbatim; normalized fields sit alongside them.
 *  - Nothing is inferred into a field that the source did not state. Unknown stays null.
 */

export const SourceId = z.enum(["sam-gov", "tx-esbd", "fl-mfmp", "openfema"]);
export type SourceId = z.infer<typeof SourceId>;

/** Classification systems used by public buyers. Florida uses UNSPSC, Texas uses NIGP, federal uses NAICS/PSC. */
export const CodeSystem = z.enum(["NAICS", "PSC", "UNSPSC", "NIGP"]);
export type CodeSystem = z.infer<typeof CodeSystem>;

export const ClassificationCode = z.object({
  system: CodeSystem,
  code: z.string().min(1),
  description: z.string().nullable(),
});
export type ClassificationCode = z.infer<typeof ClassificationCode>;

/**
 * What kind of notice this is. "Solicitation" types are biddable; the others are market intelligence
 * (award decisions, bid tabulations, pre-solicitations) and are routed differently.
 */
export const NoticeKind = z.enum([
  "rfp",
  "rfq",
  "rfi",
  "itb",
  "itn",
  "soq",
  "presolicitation",
  "sources_sought",
  "grant",
  "award_decision",
  "informational",
  "single_source",
  "other",
]);
export type NoticeKind = z.infer<typeof NoticeKind>;

/**
 * Notice kinds that are market intelligence rather than something to bid. Every other kind, including
 * "other" (sources that do not label notice types, such as Texas ESBD), is treated as biddable.
 */
export const INTEL_KINDS: ReadonlySet<NoticeKind> = new Set([
  "award_decision",
  "presolicitation",
  "sources_sought",
  "informational",
  "single_source",
]);

export function isIntel(kind: NoticeKind): boolean {
  return INTEL_KINDS.has(kind);
}

export const OpportunityStatus = z.enum(["open", "preview", "closed", "awarded", "cancelled", "unknown"]);
export type OpportunityStatus = z.infer<typeof OpportunityStatus>;

export const Provenance = z.object({
  source: SourceId,
  /** Public page a human can open to verify the record. */
  sourceUrl: z.string().url(),
  fetchedAt: z.string().datetime(),
  /** SHA-256 of the raw source payload for this record, so changes (addenda, date moves) are detectable. */
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  /** Short reference to the documented collection basis in docs/SOURCES.md. */
  basis: z.string().min(1),
});
export type Provenance = z.infer<typeof Provenance>;

export const Contact = z.object({
  name: z.string().nullable(),
  email: z.string().nullable(),
  phone: z.string().nullable(),
});
export type Contact = z.infer<typeof Contact>;

export const DocumentRef = z.object({
  /** Original filename exactly as posted. Never renamed. */
  filename: z.string().nullable(),
  url: z.string().url(),
  description: z.string().nullable(),
  postedAt: z.string().datetime().nullable(),
});
export type DocumentRef = z.infer<typeof DocumentRef>;

/**
 * A dated event in a solicitation other than the response deadline, taken from the posting's own text.
 * Dates are kept as the agency wrote them (local calendar date and clock time), not converted, so nothing
 * shifts across time zones.
 */
export const KeyDate = z.object({
  kind: z.enum(["pre_bid", "site_visit", "questions_due", "bid_opening"]),
  /** Local calendar date, YYYY-MM-DD; null when the posting mentions the event without a date. */
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable(),
  /** Local clock time as written ("10:00 AM"), when stated. */
  time: z.string().nullable(),
  /** True or false only when the posting says so ("mandatory", "non-mandatory"). */
  mandatory: z.boolean().nullable(),
  /** The sentence the date came from, verbatim and trimmed, so a reader can check it. */
  note: z.string().max(300),
});
export type KeyDate = z.infer<typeof KeyDate>;

export const Opportunity = z.object({
  /** Stable Radar id: `${source}:${sourceRecordId}`. */
  id: z.string().min(3),
  source: SourceId,
  sourceRecordId: z.string().min(1),
  /** Agency's own solicitation number (e.g. "RFP 26/27-04"), verbatim. */
  solicitationNumber: z.string().nullable(),
  title: z.string().min(1),
  description: z.string().nullable(),
  kind: NoticeKind,
  /** The source's own label for the notice type, verbatim. */
  kindLabel: z.string().nullable(),
  status: OpportunityStatus,
  buyer: z.object({
    name: z.string().min(1),
    id: z.string().nullable(),
    level: z.enum(["federal", "state", "local", "other"]),
  }),
  /** Two-letter state of the buyer or place of performance, when stated. */
  state: z.string().length(2).nullable(),
  postedAt: z.string().datetime().nullable(),
  dueAt: z.string().datetime().nullable(),
  /** Timezone the due date was stated in, when the source gives one. */
  dueTimezone: z.string().nullable(),
  codes: z.array(ClassificationCode),
  setAside: z.string().nullable(),
  contact: Contact.nullable(),
  documents: z.array(DocumentRef),
  /** Source version counter or addendum indicator, when the source exposes it. */
  version: z.number().int().nullable(),
  hasAddendum: z.boolean(),
  /** Pre-bid conferences, site visits, question deadlines and bid openings found in the posting. */
  keyDates: z.array(KeyDate).default([]),
  provenance: Provenance,
});
export type Opportunity = z.infer<typeof Opportunity>;

/** Two-letter state code, normalized to upper case ("fl" becomes "FL"). */
const StateCode = z
  .string()
  .transform((s) => s.trim().toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{2}$/, "Expected a two-letter state code"));

const points = (min: number, max: number) => z.number().min(min).max(max);

/**
 * Per-profile scoring overrides. Anything left out uses the defaults in scoring.ts, so a customer can say
 * "known buyers matter more" or "raise the strong cutoff" without a code change.
 */
export const ScoringOverrides = z
  .object({
    weights: z
      .object({
        codePrimary: points(0, 100),
        codeExtra: points(0, 50),
        codeExtraCap: points(0, 100),
        capability: points(0, 100),
        capabilityTitleMultiplier: points(1, 5),
        capabilityCap: points(0, 100),
        knownBuyer: points(0, 100),
        exclusion: points(-100, 0),
        tightTiming: points(-100, 0),
      })
      .partial()
      .strict()
      .default({}),
    bands: z
      .object({ strong: points(1, 100), possible: points(1, 100) })
      .partial()
      .strict()
      .default({}),
    kindPoints: z.record(NoticeKind, points(-50, 50)).default({}),
  })
  .strict()
  .default({});
export type ScoringOverrides = z.infer<typeof ScoringOverrides>;

/** A firm's targeting profile. One per tenant (or several, e.g. per practice). */
export const FirmProfile = z.object({
  id: z.string().min(1),
  tenantId: z.string().min(1),
  name: z.string().min(1),
  states: z.array(StateCode).min(1),
  /** Include federal opportunities whose place of performance is in `states`. */
  includeFederal: z.boolean().default(true),
  codes: z.array(
    z.object({
      system: CodeSystem,
      /** Prefix match: "8010" matches UNSPSC 80101500 etc. */
      prefix: z.string().min(2),
      weight: z.number().min(0).max(1).default(1),
      label: z.string().optional(),
    }),
  ),
  /** Capability phrases. Each is matched as a whole phrase, case-insensitive. */
  capabilities: z.array(z.object({ phrase: z.string().min(2), weight: z.number().min(0).max(1).default(1) })),
  /** Phrases that signal a poor fit (e.g. "janitorial", "road resurfacing"). */
  exclusions: z.array(z.string().min(2)).default([]),
  /** Buyers the firm has worked for; a modest boost, never a substitute for capability fit. */
  knownBuyers: z.array(z.string().min(2)).default([]),
  /** Minimum days before the due date for the firm to respond credibly. */
  minDaysToRespond: z.number().int().min(0).default(10),
  /** Optional per-profile point values and band cutoffs; defaults apply where omitted. */
  scoring: ScoringOverrides,
  /** Where the daily digest goes. Empty means the digest is only available through the API. */
  delivery: z.object({ email: z.array(z.string().email()).max(20).default([]) }).default({ email: [] }),
});
export type FirmProfile = z.infer<typeof FirmProfile>;
export type FirmProfileInput = z.input<typeof FirmProfile>;

export const Reason = z.object({
  factor: z.enum([
    "code",
    "capability",
    "semantic",
    "exclusion",
    "buyer",
    "kind",
    "timing",
    "geography",
    "status",
  ]),
  /** Signed points contributed to the score. */
  points: z.number(),
  detail: z.string(),
});
export type Reason = z.infer<typeof Reason>;

export const Match = z.object({
  opportunityId: z.string(),
  profileId: z.string(),
  score: z.number().min(0).max(100),
  band: z.enum(["strong", "possible", "weak", "excluded"]),
  /** Biddable now, or intelligence only (award notices, pre-solicitations). */
  lane: z.enum(["bid", "intel"]),
  reasons: z.array(Reason),
  scoredAt: z.string().datetime(),
  scorerVersion: z.string(),
  /** Semantic review applied to this match, keyed to the opportunity version it reviewed. */
  review: z
    .object({
      contentHash: z.string(),
      /** Hash of the profile the review was made against; a profile edit invalidates the review. */
      profileHash: z.string(),
      verdict: z.enum(["fit", "maybe", "no"]),
      rationale: z.string(),
      reviewer: z.string(),
    })
    .nullable()
    .optional(),
});
export type Match = z.infer<typeof Match>;

/** A firm's decision on a match. Passes are kept so the second-look review can revisit them. */
export const Decision = z.object({
  opportunityId: z.string(),
  profileId: z.string(),
  decision: z.enum(["pursue", "pass", "watch"]),
  reason: z.string().nullable(),
  decidedBy: z.string().nullable(),
  decidedAt: z.string().datetime(),
});
export type Decision = z.infer<typeof Decision>;
