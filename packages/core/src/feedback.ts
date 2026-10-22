import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Decision, Opportunity } from "./schema.js";

/**
 * Yes/No feedback from the email. Each card carries a link to a small page where the reader confirms "good
 * fit" or "not a fit" and may add one sentence on why. The link holds a signed token naming the tenant,
 * profile, opportunity and recipient, so no login is needed and nobody can vote on another firm's profile.
 *
 * Opening the link never records anything: mail security scanners (Outlook Safe Links and the like) open
 * every link in a message, so a vote is saved only when the reader presses the button on the page (POST).
 *
 * A vote is stored as a decision: "yes" as `watch` (keep tracking it), "no" as `pass` (drop it from future
 * emails unless the posting changes). The reasons are shown to the AI reviewer for the same profile only.
 */
export interface FeedbackClaims {
  /** Tenant id. */
  t: string;
  /** Profile id. */
  p: string;
  /** Opportunity id. */
  o: string;
  /** Recipient email the link was sent to, recorded as who voted. */
  r: string;
  /** Expiry, seconds since the epoch. */
  e: number;
}

export type FeedbackVote = "yes" | "no";

export const FEEDBACK_TOKEN_DAYS = 45;
export const FEEDBACK_REASON_MAX = 500;
const MIN_SECRET = 32;

const b64 = (b: Buffer) => b.toString("base64url");
const mac = (secret: string, body: string) => createHmac("sha256", secret).update(body).digest();

function checkSecret(secret: string) {
  if (!secret || secret.length < MIN_SECRET)
    throw new Error(`RADAR_FEEDBACK_SECRET must be at least ${MIN_SECRET} characters`);
}

export function signFeedbackToken(
  claims: Omit<FeedbackClaims, "e">,
  secret: string,
  nowIso: string,
  days = FEEDBACK_TOKEN_DAYS,
): string {
  checkSecret(secret);
  const full: FeedbackClaims = { ...claims, e: Math.floor(Date.parse(nowIso) / 1000) + days * 86_400 };
  const body = b64(Buffer.from(JSON.stringify(full)));
  return `${body}.${b64(mac(secret, body))}`;
}

/** Returns the claims for a valid, unexpired token, or null. Never throws on bad input. */
export function verifyFeedbackToken(token: string, secret: string, nowIso: string): FeedbackClaims | null {
  checkSecret(secret);
  if (typeof token !== "string" || token.length > 2000) return null;
  const [body, sig, extra] = token.split(".");
  if (!body || !sig || extra !== undefined) return null;
  const want = mac(secret, body);
  let got: Buffer;
  try {
    got = Buffer.from(sig, "base64url");
  } catch {
    return null;
  }
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let c: FeedbackClaims;
  try {
    c = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as FeedbackClaims;
  } catch {
    return null;
  }
  if (![c.t, c.p, c.o, c.r].every((v) => typeof v === "string" && v.length > 0) || typeof c.e !== "number")
    return null;
  if (c.e * 1000 < Date.parse(nowIso)) return null;
  return c;
}

/** Builds the link a card points to. `vote` only preselects the choice on the page; it records nothing. */
export function feedbackUrl(baseUrl: string, token: string, vote?: FeedbackVote): string {
  const u = new URL("/feedback", baseUrl);
  u.searchParams.set("token", token);
  if (vote) u.searchParams.set("v", vote);
  return u.toString();
}

export const voteToDecision = (v: FeedbackVote): Decision["decision"] => (v === "yes" ? "watch" : "pass");
export const decisionToVote = (d: Decision["decision"]): FeedbackVote => (d === "pass" ? "no" : "yes");

/** One past call by the firm, shown to the AI reviewer as an example. */
export interface FeedbackExample {
  vote: FeedbackVote;
  title: string;
  buyer: string;
  reason: string | null;
}

/** The firm's most recent calls, newest first, each tied to the notice it was about. */
export function feedbackExamples(
  decisions: Pick<Decision, "opportunityId" | "decision" | "reason" | "decidedAt">[],
  opps: Map<string, Opportunity>,
  max = 20,
): FeedbackExample[] {
  return [...decisions]
    .sort((a, b) => b.decidedAt.localeCompare(a.decidedAt))
    .flatMap((d) => {
      const o = opps.get(d.opportunityId);
      return o
        ? [{ vote: decisionToVote(d.decision), title: o.title, buyer: o.buyer.name, reason: d.reason }]
        : [];
    })
    .slice(0, max);
}

/** Stable hash of the examples, so a cached review is redone after the firm gives new feedback. */
export function feedbackHash(examples: FeedbackExample[]): string {
  return createHash("sha256").update(JSON.stringify(examples)).digest("hex").slice(0, 16);
}
