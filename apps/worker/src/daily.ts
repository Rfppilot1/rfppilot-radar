import { createHash } from "node:crypto";
import type { SourceConnector } from "@radar/connectors";
import {
  fallbackSummary,
  feedbackUrl,
  renderDigestHtml,
  renderDigestMarkdown,
  renderDigestText,
  signFeedbackToken,
  type Digest,
  type DigestSignal,
  type FeedbackVote,
  type FirmProfile,
  type RelevanceReviewer,
} from "@radar/core";
import { buildDigest, ingestRun, rescoreProfile, type Repository } from "@radar/store";
import { digestSubject, recipientsFor, type Mailer } from "./mailer.js";

/**
 * The scheduled worker's steps (ingest, score, deliver, health check), kept apart from the CLI so each can be
 * tested with an in-memory store and fake mailer. Every step isolates its units: one failing source, profile
 * or recipient is recorded and reported, and never stops the others.
 */
export type Log = (event: Record<string, unknown>) => void;

const EPOCH = "1970-01-01T00:00:00.000Z";
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err)).slice(0, 500);

// ---------------------------------------------------------------------------------------------- ingest

export interface IngestJob {
  connector: SourceConnector;
  /** Aborted at the source's deadline; the connector's HTTP client must listen to its signal. */
  controller?: AbortController;
}

export interface SourceResult {
  source: string;
  ok: boolean;
  fetched: number;
  inserted: number;
  updated: number;
  closed: number;
  rejected: number;
  complete: boolean;
  closeRefused: boolean;
  deadlineHit: boolean;
  error: string | null;
}

export async function ingestSources(
  repo: Repository,
  jobs: IngestJob[],
  o: { log: Log; max?: number; deadlineMs?: number },
): Promise<SourceResult[]> {
  const out: SourceResult[] = [];
  for (const { connector: c, controller } of jobs) {
    const started = new Date().toISOString();
    // A source that runs past its deadline is stopped; what it fetched is kept and the run counts as
    // incomplete, so nothing is closed by absence.
    const timer =
      controller && o.deadlineMs
        ? setTimeout(() => controller.abort(new Error("source time limit")), o.deadlineMs)
        : null;
    try {
      o.log({ event: "ingest_start", source: c.id, rssMb: Math.round(process.memoryUsage().rss / 1e6) });
      const run = await c.fetch({ maxRecords: o.max });
      const deadlineHit = controller?.signal.aborted ?? false;
      if (deadlineHit) run.complete = false;
      const r = await ingestRun(repo, run, started);
      const res: SourceResult = {
        source: c.id,
        ok: true,
        fetched: run.opportunities.length,
        inserted: r.inserted.length,
        updated: r.updated.length,
        closed: r.closed.length,
        rejected: run.rejected.length,
        complete: run.complete,
        closeRefused: r.closeRefused !== null,
        deadlineHit,
        error: null,
      };
      out.push(res);
      // The first few rejects, so a failing portal or record shape shows up in the run log.
      o.log({ event: "ingest", ...res, rejectedSample: run.rejected.slice(0, 3) });
    } catch (err) {
      const error = errText(err);
      await repo
        .recordRun({
          source: c.id,
          startedAt: started,
          finishedAt: new Date().toISOString(),
          fetched: 0,
          inserted: 0,
          updated: 0,
          closed: 0,
          rejected: 0,
          complete: false,
          error,
        })
        .catch((e) => o.log({ event: "record_run_failed", source: c.id, error: errText(e) }));
      out.push({
        source: c.id,
        ok: false,
        fetched: 0,
        inserted: 0,
        updated: 0,
        closed: 0,
        rejected: 0,
        complete: false,
        closeRefused: false,
        deadlineHit: controller?.signal.aborted ?? false,
        error,
      });
      o.log({
        event: "ingest_failed",
        source: c.id,
        error,
        detail: (err as { body?: string }).body?.slice(0, 300),
      });
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- score

export interface ProfileResult {
  tenantId: string;
  profileId: string;
  step: "score" | "digest";
  ok: boolean;
  error: string | null;
}

export async function scoreProfiles(
  repo: Repository,
  o: { log: Log; now: string; reviewer?: RelevanceReviewer; maxReviews?: number },
): Promise<ProfileResult[]> {
  const out: ProfileResult[] = [];
  for (const p of await repo.listAllProfilesForWorker()) {
    try {
      const scored = await rescoreProfile(repo, p, o.now, {
        reviewer: o.reviewer,
        maxReviews: o.maxReviews,
        onReviewError: (id, err) =>
          o.log({ event: "review_failed", profile: p.id, opportunity: id, error: err.message }),
      });
      o.log({ event: "score", profile: p.id, scored, reviewer: o.reviewer?.id ?? null });
      out.push({ tenantId: p.tenantId, profileId: p.id, step: "score", ok: true, error: null });
    } catch (err) {
      o.log({ event: "score_failed", tenant: p.tenantId, profile: p.id, error: errText(err) });
      out.push({ tenantId: p.tenantId, profileId: p.id, step: "score", ok: false, error: errText(err) });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------------------------- deliver

export interface DeliveryOptions {
  log: Log;
  now: string;
  mailer: Mailer | null;
  /** Operator-set recipients (RADAR_RECIPIENTS), keyed "tenant/profile". */
  recipientOverrides: Map<string, string[]>;
  /** Test send: this address gets every email instead, marked [TEST], and nothing is recorded as delivered. */
  testTo: string | null;
  feedback: { secret: string; baseUrl: string } | null;
  unsubscribe: string;
  /** Re-send the full current list (template preview); nothing is recorded as delivered. */
  replay: boolean;
  federalMinScore: number;
  summarizer: { summarize(d: Digest): Promise<string | null> } | null;
  signalsFor?: (states: string[], since: string) => Promise<DigestSignal[]>;
  /** Local copies of each digest; failures are logged and never stop the email. */
  writeFiles?: (stem: string, files: Record<string, string>) => Promise<void>;
}

/** Stable per recipient and digest window: a resend after a crash reuses it, so Resend sends only once. */
export function deliveryKey(p: FirmProfile, recipient: string, since: string, mode: string): string {
  const h = createHash("sha256")
    .update([p.tenantId, p.id, recipient.toLowerCase(), since, mode].join("\u0000"))
    .digest("hex");
  return `radar-digest-${h.slice(0, 40)}`;
}

export async function deliverDigests(repo: Repository, o: DeliveryOptions): Promise<ProfileResult[]> {
  const out: ProfileResult[] = [];
  for (const p of await repo.listAllProfilesForWorker()) {
    try {
      const failures = await deliverProfile(repo, p, o);
      const ok = failures.length === 0;
      out.push({
        tenantId: p.tenantId,
        profileId: p.id,
        step: "digest",
        ok,
        error: ok ? null : `email failed for ${failures.length} recipient(s): ${failures.join("; ")}`,
      });
    } catch (err) {
      o.log({ event: "digest_failed", tenant: p.tenantId, profile: p.id, error: errText(err) });
      out.push({ tenantId: p.tenantId, profileId: p.id, step: "digest", ok: false, error: errText(err) });
    }
  }
  return out;
}

/** Builds and sends one profile's digest. Returns one line per failed recipient. */
async function deliverProfile(repo: Repository, p: FirmProfile, o: DeliveryOptions): Promise<string[]> {
  const last = await repo.lastDigestAt(p.tenantId, p.id);
  if (o.replay) o.log({ event: "digest_replay", profile: p.id });
  const to = o.testTo ? [o.testTo] : recipientsFor(o.recipientOverrides, p.tenantId, p.id, p.delivery.email);
  const sending = o.mailer !== null && to.length > 0;
  const record = !o.testTo && !o.replay;

  // Each recipient's digest covers everything since their own last delivery, so a send that failed for one
  // person yesterday reaches them today without repeating anything to the others. Usually there is one window.
  const windows = new Map<string, string[]>();
  if (sending) {
    for (const r of to) {
      const since = !record
        ? o.replay
          ? EPOCH
          : (last ?? EPOCH)
        : ((await repo.lastDeliveryAt(p.tenantId, p.id, r)) ?? EPOCH);
      windows.set(since, [...(windows.get(since) ?? []), r]);
    }
  } else {
    windows.set(o.replay ? EPOCH : (last ?? EPOCH), []);
  }

  const signalsSince = last ?? new Date(Date.parse(o.now) - 30 * 86_400_000).toISOString();
  const signals = o.signalsFor
    ? await o.signalsFor(p.states, signalsSince).catch((err: Error) => {
        // FEMA signals are a bonus; a failure here never blocks the digest.
        o.log({ event: "signals_failed", profile: p.id, error: err.message });
        return [] as DigestSignal[];
      })
    : undefined;

  const failures: string[] = [];
  let first: Digest | null = null;
  for (const [since, recipients] of windows) {
    const d = await buildDigest(repo, p.tenantId, p.id, {
      since,
      now: o.now,
      federalMinScore: o.federalMinScore,
    });
    if (signals) d.signals = signals;
    if (o.summarizer) {
      // The brief is a bonus too: on any failure the email goes out without the model's version.
      d.summary = await o.summarizer.summarize(d).catch((err: Error) => {
        o.log({ event: "summary_failed", profile: p.id, error: err.message });
        return null;
      });
    }
    // Never send without a brief: fall back to one written straight from the digest's own facts.
    if (!d.summary) {
      d.summary = fallbackSummary(d);
      if (o.summarizer) o.log({ event: "summary_fallback", profile: p.id });
    }
    first ??= d;

    const subject = `${o.testTo ? "[TEST] " : ""}${digestSubject(p.name, d.newMatches.length, d.closingSoon.length, o.now)}`;
    const mode = o.testTo ? "test" : o.replay ? `replay-${o.now.slice(0, 10)}` : "live";
    for (const r of recipients) {
      // One email per recipient: addresses stay private, and Yes/No links are signed for that person.
      const opts = o.feedback
        ? {
            feedback: (opportunityId: string, vote?: FeedbackVote) =>
              feedbackUrl(
                o.feedback!.baseUrl,
                signFeedbackToken({ t: p.tenantId, p: p.id, o: opportunityId, r }, o.feedback!.secret, o.now),
                vote,
              ),
          }
        : {};
      try {
        const sent = await o.mailer!.send({
          to: [r],
          subject,
          html: renderDigestHtml(d, opts),
          text: renderDigestText(d, 5, opts),
          unsubscribe: o.unsubscribe,
          idempotencyKey: deliveryKey(p, r, since, mode),
        });
        if (record)
          await repo.recordDelivery({
            tenantId: p.tenantId,
            profileId: p.id,
            recipient: r,
            generatedAt: o.now,
            messageId: sent.id,
          });
      } catch (err) {
        // Not recorded, so this recipient's next digest still includes today's items.
        failures.push(`${maskEmail(r)}: ${errText(err).slice(0, 160)}`);
        o.log({ event: "email_failed", profile: p.id, recipient: maskEmail(r), error: errText(err) });
      }
    }
  }

  if (first && o.writeFiles) {
    const stem = `${p.tenantId}-${p.id}-${o.now.slice(0, 10)}`;
    await o
      .writeFiles(stem, {
        md: renderDigestMarkdown(first),
        txt: renderDigestText(first),
        html: renderDigestHtml(first),
      })
      .catch((err: Error) => o.log({ event: "digest_files_failed", profile: p.id, error: err.message }));
  }
  // The profile-level mark moves only when everyone got today's email (or no email is configured): it is the
  // starting point for recipients who have no delivery rows yet.
  if (record && failures.length === 0) await repo.recordDigest(p.tenantId, p.id, o.now);
  o.log({
    event: "digest",
    profile: p.id,
    new: first?.newMatches.length ?? 0,
    closing: first?.closingSoon.length ?? 0,
    secondLook: first?.secondLook.length ?? 0,
    signals: first?.signals?.length ?? 0,
    recipients: sending ? to.length : 0,
    failed: failures.length,
    windows: windows.size,
    test: Boolean(o.testTo),
  });
  return failures;
}

/** "monica@isf.com" → "m***@isf.com", so logs and alerts do not carry full addresses. */
export function maskEmail(e: string): string {
  const at = e.indexOf("@");
  return at > 0 ? `${e[0]}***${e.slice(at)}` : "***";
}

// ---------------------------------------------------------------------------------------------- health

/** No complete run for this long, after having had one, is reported (covers a weekend without weekday runs). */
export const STALE_AFTER_MS = 4 * 86_400_000;

/**
 * Plain-language problems from today's run, for the operator alert. Empty when all is well. A source that has
 * never completed a run is not reported as stale, so a source that is normally partial does not alert daily.
 */
export async function healthProblems(
  repo: Repository,
  sources: SourceResult[],
  profiles: ProfileResult[],
  now: string,
): Promise<string[]> {
  const problems: string[] = [];
  for (const s of sources) {
    if (!s.ok) problems.push(`${s.source}: failed (${s.error})`);
    else if (s.fetched === 0) problems.push(`${s.source}: returned 0 records`);
    if (s.closeRefused)
      problems.push(`${s.source}: too many open records were missing from the run, so none were closed`);
    if (s.deadlineHit) problems.push(`${s.source}: stopped at its time limit; what it fetched was kept`);
    const seen = s.fetched + s.rejected;
    if (s.rejected >= 5 && s.rejected > seen * 0.25)
      problems.push(`${s.source}: ${s.rejected} of ${seen} records could not be read`);
    const lastComplete = await repo.lastCompleteRunAt(s.source).catch(() => null);
    if (lastComplete && Date.parse(now) - Date.parse(lastComplete) > STALE_AFTER_MS)
      problems.push(`${s.source}: no complete run since ${lastComplete.slice(0, 10)}`);
  }
  for (const p of profiles)
    if (!p.ok) problems.push(`${p.tenantId}/${p.profileId}: ${p.step} failed (${p.error})`);
  return problems;
}

/** Emails the operator the problem list. Never throws: an alert failure is logged, not fatal. */
export async function sendAlert(
  o: { mailer: Mailer | null; to: string | null; log: Log; now: string },
  problems: string[],
): Promise<boolean> {
  o.log({ event: "health", ok: problems.length === 0, problems });
  if (problems.length === 0 || !o.mailer || !o.to) return false;
  const day = o.now.slice(0, 10);
  const text = [`Radar's run on ${day} needs a look:`, "", ...problems.map((p) => `- ${p}`)].join("\n");
  const esc = (s: string) =>
    s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!);
  try {
    await o.mailer.send({
      to: [o.to],
      subject: `[Radar alert] ${problems.length} problem${problems.length === 1 ? "" : "s"} in the ${day} run`,
      text,
      html: `<p>Radar's run on ${day} needs a look:</p><ul>${problems.map((p) => `<li>${esc(p)}</li>`).join("")}</ul>`,
      idempotencyKey: `radar-alert-${createHash("sha256")
        .update(day + text)
        .digest("hex")
        .slice(0, 40)}`,
    });
    return true;
  } catch (err) {
    o.log({ event: "alert_failed", error: errText(err) });
    return false;
  }
}
