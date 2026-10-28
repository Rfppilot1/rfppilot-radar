#!/usr/bin/env node
import { writeSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  FlMfmpConnector,
  OpenGovConnector,
  BonfireConnector,
  VendorLinkConnector,
  HttpClient,
  HttpFlTransport,
  SamGovConnector,
  TxEsbdConnector,
  TX_DETAIL_VERSION,
  normalizeFlAd,
  normalizeSam,
  normalizeTxEsbd,
  type ConnectorRun,
  type SourceConnector,
} from "@radar/connectors";
import {
  FirmProfile,
  renderDigestHtml,
  renderDigestMarkdown,
  renderDigestText,
  type Opportunity,
  type SourceId,
  type FeedbackVote,
  fallbackSummary,
  feedbackUrl,
  signFeedbackToken,
} from "@radar/core";
import {
  MemoryRepository,
  PostgresRepository,
  buildDigest,
  FEDERAL_MIN_SCORE,
  ingestRun,
  migrate,
  rescoreProfile,
  type Repository,
} from "@radar/store";
import pg from "pg";
import { AnthropicReviewer } from "./anthropic-reviewer.js";
import { AnthropicSummarizer } from "./anthropic-summarizer.js";
import { ResendMailer, digestSubject, parseRecipients, recipientsFor, type Mailer } from "./mailer.js";
import { recentSignals } from "./signals.js";

/**
 * Radar operations CLI. Production runs `radar daily` on a schedule (cron, a container job, or a queue worker).
 *
 *   radar profile load <file.json>                 create/replace a firm profile
 *   radar ingest [--sources tx-esbd,fl-mfmp,opengov,bonfire,vendorlink,sam-gov] [--max N]
 *   radar import --source <id> --file <raw.json>   load raw source records captured elsewhere
 *   radar score                                     rescore every profile
 *   radar digest --tenant T --profile P [--since ISO] [--format text|markdown|json] [--out file]
 *   radar daily [--out-dir data/digests] [--profiles a.json,b.json] [--imports src=file.json,...] [--sources none]
 *                                                  ingest + score + one digest per profile
 */
const USER_AGENT = process.env.RADAR_USER_AGENT ?? "RFPPilotRadar/0.1 (+https://rfppilot.com)";

async function openRepo(): Promise<Repository> {
  if (process.env.DATABASE_URL) {
    const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 4 });
    await migrate(pool);
    return new PostgresRepository(pool);
  }
  if (process.env.RADAR_ALLOW_MEMORY !== "1") {
    throw new Error(
      "DATABASE_URL is not set. Set RADAR_ALLOW_MEMORY=1 to run against a throwaway in-memory store.",
    );
  }
  return new MemoryRepository();
}

function connectors(
  sources: SourceId[],
  txKnown: ReadonlyMap<string, string> = new Map(),
): SourceConnector[] {
  const http = new HttpClient({ userAgent: USER_AGENT, minIntervalMs: 1500 });
  const out: SourceConnector[] = [];
  for (const s of sources) {
    if (s === "tx-esbd")
      out.push(
        new TxEsbdConnector({
          http,
          details: {
            known: txKnown,
            max: Number(process.env.RADAR_TX_MAX_DETAILS ?? 600),
            onProgress: (p) => log({ event: "progress", source: s, ...p }),
          },
        }),
      );
    else if (s === "fl-mfmp")
      out.push(
        new FlMfmpConnector({
          transport: new HttpFlTransport(http),
          onProgress: (p) => log({ event: "progress", source: s, ...p }),
        }),
      );
    else if (s === "opengov")
      out.push(
        new OpenGovConnector({
          http,
          states: (process.env.RADAR_OPENGOV_STATES ?? "FL").split(","),
          exclude: (process.env.RADAR_OPENGOV_EXCLUDE ?? "").split(",").filter(Boolean),
          onProgress: (p) => log({ event: "progress", source: s, ...p }),
        }),
      );
    else if (s === "bonfire") out.push(new BonfireConnector({ http }));
    else if (s === "vendorlink") out.push(new VendorLinkConnector({ http }));
    else if (s === "sam-gov") {
      // Federal coverage is optional: without a key the run continues with the state sources.
      if (!process.env.SAM_API_KEY) {
        log({ event: "source_skipped", source: s, reason: "SAM_API_KEY is not set" });
        continue;
      }
      out.push(
        new SamGovConnector({
          http,
          apiKey: process.env.SAM_API_KEY ?? "",
          states: (process.env.RADAR_SAM_STATES ?? "FL,TX").split(","),
          onNoData: (q) => log({ event: "sam_no_data", ...q }),
          onProbe: (p) => log({ event: "sam_probe", ...p }),
        }),
      );
    }
  }
  return out;
}

const NORMALIZERS: Record<string, (raw: unknown, at: string) => Opportunity> = {
  "tx-esbd": normalizeTxEsbd,
  "fl-mfmp": normalizeFlAd,
  "sam-gov": normalizeSam,
};

/** Texas records already stored with their detail, so unchanged postings are not fetched again. */
async function txKnown(repo: Repository): Promise<Map<string, string>> {
  const stored = await repo.listOpportunities({ sources: ["tx-esbd"], openOnly: true, limit: 20_000 });
  return new Map(
    stored
      .filter((o) => o.provenance.detailVersion === TX_DETAIL_VERSION && o.provenance.listHash)
      .map((o) => [o.id, o.provenance.listHash!] as const),
  );
}

async function ingest(repo: Repository, sources: SourceId[], max?: number) {
  const known = sources.includes("tx-esbd") ? await txKnown(repo) : new Map<string, string>();
  for (const c of connectors(sources, known)) {
    const started = new Date().toISOString();
    try {
      log({ event: "ingest_start", source: c.id, rssMb: Math.round(process.memoryUsage().rss / 1e6) });
      const run = await c.fetch({ maxRecords: max });
      const r = await ingestRun(repo, run, started);
      log({
        event: "ingest",
        source: c.id,
        fetched: run.opportunities.length,
        inserted: r.inserted.length,
        updated: r.updated.length,
        closed: r.closed.length,
        rejected: run.rejected.length,
        // The first few rejects, so a failing portal or record shape shows up in the run log.
        rejectedSample: run.rejected.slice(0, 3),
        complete: run.complete,
      });
    } catch (err) {
      // One failing source must not stop the others; the failure is recorded for monitoring.
      await repo.recordRun({
        source: c.id,
        startedAt: started,
        finishedAt: new Date().toISOString(),
        fetched: 0,
        inserted: 0,
        updated: 0,
        closed: 0,
        rejected: 0,
        complete: false,
        error: (err as Error).message.slice(0, 500),
      });
      log({
        event: "ingest_failed",
        source: c.id,
        error: (err as Error).message,
        detail: (err as { body?: string }).body?.slice(0, 300),
      });
    }
  }
}

async function importFile(repo: Repository, source: string, file: string) {
  const normalize = NORMALIZERS[source];
  if (!normalize) throw new Error(`Unknown source ${source}`);
  const raw = JSON.parse(await readFile(file, "utf8"));
  const rows: unknown[] = Array.isArray(raw) ? raw : (raw.lines ?? raw.opportunitiesData ?? []);
  const fetchedAt = new Date().toISOString();
  // A manual import is never treated as the source's full list, so it never closes other records.
  const run: ConnectorRun = {
    source: source as SourceId,
    opportunities: [],
    rejected: [],
    fetchedAt,
    complete: false,
  };
  for (const r of rows) {
    try {
      // Florida captures may carry {list, detail} pairs (list row plus the public detail record).
      const pair = r as { list?: unknown; detail?: unknown };
      run.opportunities.push(
        source === "fl-mfmp" && pair && pair.list !== undefined
          ? normalizeFlAd(pair.list, fetchedAt, pair.detail)
          : normalize(r, fetchedAt),
      );
    } catch (err) {
      run.rejected.push({ sourceRecordId: null, error: (err as Error).message.slice(0, 300) });
    }
  }
  const res = await ingestRun(repo, run, fetchedAt);
  log({
    event: "import",
    source,
    inserted: res.inserted.length,
    updated: res.updated.length,
    rejected: run.rejected.length,
  });
}

async function scoreAll(repo: Repository) {
  const now = new Date().toISOString();
  // The semantic reviewer is optional: without ANTHROPIC_API_KEY, scoring is purely rule-based.
  const reviewer = process.env.ANTHROPIC_API_KEY
    ? new AnthropicReviewer(process.env.ANTHROPIC_API_KEY)
    : undefined;
  const maxReviews = Number(process.env.RADAR_MAX_REVIEWS ?? 50);
  for (const p of await repo.listAllProfilesForWorker()) {
    const scored = await rescoreProfile(repo, p, now, {
      reviewer,
      maxReviews,
      onReviewError: (id, err) =>
        log({ event: "review_failed", profile: p.id, opportunity: id, error: err.message }),
    });
    log({ event: "score", profile: p.id, scored, reviewer: reviewer?.id ?? null });
  }
}

function log(o: Record<string, unknown>) {
  // Synchronous write, so a line is never lost if the process exits or is killed right after.
  writeSync(1, `${JSON.stringify({ at: new Date().toISOString(), ...o })}\n`);
}

// Leave a trace for anything that ends the run outside the normal error path.
for (const sig of ["SIGTERM", "SIGINT"] as const)
  process.on(sig, () => {
    log({ event: "signal", signal: sig, rssMb: Math.round(process.memoryUsage().rss / 1e6) });
    process.exit(128 + (sig === "SIGTERM" ? 15 : 2));
  });
process.on("unhandledRejection", (err) => {
  log({ event: "fatal", error: `unhandled rejection: ${(err as Error)?.message ?? String(err)}` });
  process.exit(1);
});

async function main() {
  const { positionals, values } = parseArgs({
    allowPositionals: true,
    options: {
      sources: { type: "string" },
      source: { type: "string" },
      file: { type: "string" },
      max: { type: "string" },
      tenant: { type: "string" },
      profile: { type: "string" },
      since: { type: "string" },
      format: { type: "string" },
      out: { type: "string" },
      "out-dir": { type: "string" },
      profiles: { type: "string" },
      imports: { type: "string" },
      signals: { type: "string" },
    },
  });
  const [cmd, sub, arg] = positionals;
  const repo = await openRepo();
  try {
    const sources = (values.sources ?? "tx-esbd,fl-mfmp,opengov,bonfire,vendorlink,sam-gov").split(
      ",",
    ) as SourceId[];
    const max = values.max ? Number(values.max) : undefined;
    if (cmd === "profile" && sub === "load" && arg) {
      const p = FirmProfile.parse(JSON.parse(await readFile(arg, "utf8")));
      await repo.upsertProfile(p, new Date().toISOString());
      log({ event: "profile_loaded", profile: p.id, tenant: p.tenantId });
    } else if (cmd === "ingest") {
      await ingest(repo, sources, max);
    } else if (cmd === "import") {
      if (!values.source || !values.file) throw new Error("import needs --source and --file");
      await importFile(repo, values.source, values.file);
    } else if (cmd === "score") {
      await scoreAll(repo);
    } else if (cmd === "digest") {
      if (!values.tenant || !values.profile) throw new Error("digest needs --tenant and --profile");
      const now = new Date().toISOString();
      // Preview only: does not record a delivered digest.
      const since =
        values.since ??
        (await repo.lastDigestAt(values.tenant, values.profile)) ??
        new Date(Date.now() - 86_400_000).toISOString();
      const d = await buildDigest(repo, values.tenant, values.profile, {
        since,
        now,
        federalMinScore: Number(process.env.RADAR_FEDERAL_MIN_SCORE ?? FEDERAL_MIN_SCORE),
      });
      const out =
        values.format === "json"
          ? JSON.stringify(d, null, 2)
          : values.format === "text"
            ? renderDigestText(d)
            : renderDigestMarkdown(d);
      if (values.out) await writeFile(values.out, out);
      else process.stdout.write(`${out}\n`);
    } else if (cmd === "daily") {
      // Optional: load profiles and pre-captured raw files first (useful with the in-memory store).
      for (const f of (values.profiles ?? "").split(",").filter(Boolean)) {
        await repo.upsertProfile(
          FirmProfile.parse(JSON.parse(await readFile(f, "utf8"))),
          new Date().toISOString(),
        );
      }
      for (const spec of (values.imports ?? "").split(",").filter(Boolean)) {
        const [source, file] = spec.split("=");
        if (!source || !file) throw new Error("--imports entries look like source=file.json");
        await importFile(repo, source, file);
      }
      if (values.sources !== "none") await ingest(repo, sources, max);
      await scoreAll(repo);
      const dir = values["out-dir"] ?? "data/digests";
      await mkdir(dir, { recursive: true }).catch((err: Error) =>
        log({ event: "digest_files_failed", error: err.message }),
      );
      const now = new Date().toISOString();
      const mailer: Mailer | null =
        process.env.RESEND_API_KEY && process.env.RADAR_EMAIL_FROM
          ? new ResendMailer(process.env.RESEND_API_KEY, process.env.RADAR_EMAIL_FROM)
          : null;
      const recipientOverrides = parseRecipients(process.env.RADAR_RECIPIENTS);
      const summarizer =
        process.env.ANTHROPIC_API_KEY && process.env.RADAR_SUMMARY !== "off"
          ? new AnthropicSummarizer(process.env.ANTHROPIC_API_KEY)
          : null;
      const http = new HttpClient({ userAgent: USER_AGENT, minIntervalMs: 1000 });
      // Test send: RADAR_TEST_RECIPIENT gets the email instead of the real recipients, the subject is marked
      // [TEST], and the digest is NOT recorded as delivered, so the real recipients' next email is unchanged.
      // Active only until RADAR_TEST_UNTIL (ISO time), so a forgotten setting cannot divert real emails.
      const testTo =
        process.env.RADAR_TEST_RECIPIENT && (process.env.RADAR_TEST_UNTIL ?? "") > now
          ? process.env.RADAR_TEST_RECIPIENT.trim()
          : null;
      if (testTo && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(testTo))
        throw new Error("RADAR_TEST_RECIPIENT must be one email address");
      if (testTo) log({ event: "test_send", until: process.env.RADAR_TEST_UNTIL });
      // Yes/No feedback links need the signing secret and the API's public address. They appear in test
      // sends, and in real emails only once RADAR_FEEDBACK_LIVE=1, so the feature can be tried end to end
      // before any customer sees it.
      const feedback =
        process.env.RADAR_FEEDBACK_SECRET &&
        process.env.RADAR_PUBLIC_URL &&
        (testTo || process.env.RADAR_FEEDBACK_LIVE === "1")
          ? { secret: process.env.RADAR_FEEDBACK_SECRET, baseUrl: process.env.RADAR_PUBLIC_URL }
          : null;
      const unsubscribe = `mailto:${process.env.RADAR_UNSUBSCRIBE_EMAIL ?? "radar-unsubscribe@rfppilot.com"}?subject=unsubscribe`;
      // One FEMA lookup per (states, since) per run, shared across profiles.
      const signalCache = new Map<string, Promise<Awaited<ReturnType<typeof recentSignals>>>>();
      const signalsFor = (states: string[], since: string) => {
        const key = `${[...states].sort().join(",")}|${since.slice(0, 10)}`;
        if (!signalCache.has(key)) signalCache.set(key, recentSignals(http, states, since));
        return signalCache.get(key)!;
      };
      for (const p of await repo.listAllProfilesForWorker()) {
        // New = since the last delivered digest, so a skipped or late run loses nothing and a second run
        // the same day repeats nothing. The first digest for a profile lists everything current.
        const last = await repo.lastDigestAt(p.tenantId, p.id);
        // RADAR_DIGEST_REPLAY_UNTIL (ISO time) re-sends the full current list on runs before that time, for
        // previewing a template change. It expires on its own, so a forgotten setting cannot spam anyone.
        const replay = (process.env.RADAR_DIGEST_REPLAY_UNTIL ?? "") > now;
        const since = replay ? "1970-01-01T00:00:00.000Z" : (last ?? "1970-01-01T00:00:00.000Z");
        if (replay)
          log({ event: "digest_replay", profile: p.id, until: process.env.RADAR_DIGEST_REPLAY_UNTIL });
        const d = await buildDigest(repo, p.tenantId, p.id, {
          since,
          now,
          federalMinScore: Number(process.env.RADAR_FEDERAL_MIN_SCORE ?? FEDERAL_MIN_SCORE),
        });
        if (values.signals !== "off") {
          // FEMA signals are a bonus; a failure here never blocks the digest.
          const signalsSince = last ?? new Date(Date.now() - 30 * 86_400_000).toISOString();
          d.signals = await signalsFor(p.states, signalsSince).catch((err: Error) => {
            log({ event: "signals_failed", profile: p.id, error: err.message });
            return [];
          });
        }
        if (summarizer) {
          // The brief is a bonus too: on any failure the email goes out without it.
          d.summary = await summarizer.summarize(d).catch((err: Error) => {
            log({ event: "summary_failed", profile: p.id, error: err.message });
            return null;
          });
        }
        // Never send without a brief: fall back to one written straight from the digest's own facts.
        if (!d.summary) {
          d.summary = fallbackSummary(d);
          if (summarizer) log({ event: "summary_fallback", profile: p.id });
        }
        const stem = `${dir}/${p.tenantId}-${p.id}-${now.slice(0, 10)}`;
        const html = renderDigestHtml(d);
        const text = renderDigestText(d);
        // Local copies are a convenience; a disk problem must never stop the email.
        try {
          await writeFile(`${stem}.md`, renderDigestMarkdown(d));
          await writeFile(`${stem}.txt`, text);
          await writeFile(`${stem}.html`, html);
        } catch (err) {
          log({ event: "digest_files_failed", profile: p.id, error: (err as Error).message });
        }
        let emailed = false;
        const to = testTo ? [testTo] : recipientsFor(recipientOverrides, p.tenantId, p.id, p.delivery.email);
        if (mailer && to.length > 0) {
          const subject = `${testTo ? "[TEST] " : ""}${digestSubject(p.name, d.newMatches.length, d.closingSoon.length, now)}`;
          try {
            if (feedback) {
              // Yes/No links are signed per recipient, so each person gets their own copy.
              for (const r of to) {
                const opts = {
                  feedback: (opportunityId: string, vote?: FeedbackVote) =>
                    feedbackUrl(
                      feedback.baseUrl,
                      signFeedbackToken(
                        { t: p.tenantId, p: p.id, o: opportunityId, r },
                        feedback.secret,
                        now,
                      ),
                      vote,
                    ),
                };
                await mailer.send({
                  to: [r],
                  subject,
                  html: renderDigestHtml(d, opts),
                  text: renderDigestText(d, 5, opts),
                  unsubscribe,
                });
              }
            } else await mailer.send({ to, subject, html, text, unsubscribe });
            emailed = true;
          } catch (err) {
            // Not recorded as delivered, so tomorrow's digest still includes today's new items.
            log({ event: "email_failed", profile: p.id, error: (err as Error).message });
            continue;
          }
        }
        if (!testTo) await repo.recordDigest(p.tenantId, p.id, now);
        log({
          event: "digest",
          profile: p.id,
          new: d.newMatches.length,
          closing: d.closingSoon.length,
          secondLook: d.secondLook.length,
          signals: d.signals?.length ?? 0,
          emailed,
          test: Boolean(testTo),
        });
      }
    } else {
      process.stderr.write("Usage: radar <profile load|ingest|import|score|digest|daily> [options]\n");
      process.exitCode = 2;
    }
  } finally {
    await repo.close();
  }
}

main().catch((err) => {
  log({ event: "fatal", error: (err as Error).message });
  process.exit(1);
});
