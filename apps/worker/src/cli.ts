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
  renderDigestMarkdown,
  renderDigestText,
  type Opportunity,
  type SourceId,
} from "@radar/core";
import {
  MemoryRepository,
  PostgresRepository,
  buildDigest,
  FEDERAL_MIN_SCORE,
  ingestRun,
  migrate,
  type Repository,
} from "@radar/store";
import pg from "pg";
import { AnthropicReviewer } from "./anthropic-reviewer.js";
import { AnthropicSummarizer } from "./anthropic-summarizer.js";
import {
  deliverDigests,
  healthProblems,
  ingestSources,
  scoreProfiles,
  sendAlert,
  type IngestJob,
  type ProfileResult,
  type SourceResult,
} from "./daily.js";
import { ResendMailer, parseRecipients, withSubjectPrefix, type Mailer } from "./mailer.js";
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
    // An idle pooled connection that drops emits "error"; log it instead of crashing the run.
    pool.on("error", (err) => log({ event: "db_connection_error", error: err.message }));
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

/** Minutes a single source may run before it is stopped (its fetched records are kept). Default 45. */
const SOURCE_DEADLINE_MS = Number(process.env.RADAR_SOURCE_DEADLINE_MIN ?? 45) * 60_000;

/** One connector per source, each with its own HTTP client so a deadline stops only that source. */
function connectors(sources: SourceId[], txKnown: ReadonlyMap<string, string> = new Map()): IngestJob[] {
  const jobs: IngestJob[] = [];
  for (const s of sources) {
    const controller = new AbortController();
    const http = new HttpClient({ userAgent: USER_AGENT, minIntervalMs: 1500, signal: controller.signal });
    const out: SourceConnector[] = [];
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
    for (const connector of out) jobs.push({ connector, controller });
  }
  return jobs;
}

const NORMALIZERS: Record<string, (raw: unknown, at: string) => Opportunity> = {
  "tx-esbd": normalizeTxEsbd,
  "fl-mfmp": normalizeFlAd,
  "sam-gov": normalizeSam,
};

/** Texas records already stored with their detail, so unchanged postings are not fetched again. */
async function txKnown(repo: Repository): Promise<Map<string, string>> {
  const stored = await repo.listOpportunities({ sources: ["tx-esbd"], openOnly: true, limit: "all" });
  return new Map(
    stored
      .filter((o) => o.provenance.detailVersion === TX_DETAIL_VERSION && o.provenance.listHash)
      .map((o) => [o.id, o.provenance.listHash!] as const),
  );
}

async function ingest(repo: Repository, sources: SourceId[], max?: number): Promise<SourceResult[]> {
  const known = sources.includes("tx-esbd") ? await txKnown(repo) : new Map<string, string>();
  return ingestSources(repo, connectors(sources, known), { log, max, deadlineMs: SOURCE_DEADLINE_MS });
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

async function scoreAll(repo: Repository): Promise<ProfileResult[]> {
  // The semantic reviewer is optional: without ANTHROPIC_API_KEY, scoring is purely rule-based.
  const reviewer = process.env.ANTHROPIC_API_KEY
    ? new AnthropicReviewer(process.env.ANTHROPIC_API_KEY)
    : undefined;
  return scoreProfiles(repo, {
    log,
    now: new Date().toISOString(),
    reviewer,
    maxReviews: Number(process.env.RADAR_MAX_REVIEWS ?? 50),
  });
}

/**
 * Runs `fn` holding the worker lock, so an overlapping scheduled run (or a manual one during it) does not
 * ingest twice or send the same emails twice. Without the lock, the second run logs and exits cleanly.
 */
async function withWorkerLock(repo: Repository, fn: () => Promise<void>): Promise<void> {
  const lock = await repo.tryRunLock("worker");
  if (!lock) {
    log({ event: "run_skipped", reason: "another worker run holds the lock" });
    return;
  }
  try {
    await fn();
  } finally {
    await lock.release().catch((err: Error) => log({ event: "unlock_failed", error: err.message }));
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

async function daily(
  repo: Repository,
  values: { profiles?: string; imports?: string; signals?: string; "out-dir"?: string },
  sources: SourceId[],
  max: number | undefined,
): Promise<void> {
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
  const sourceResults = (sources as string[]).includes("none") ? [] : await ingest(repo, sources, max);
  const scoreResults = await scoreAll(repo);

  const dir = values["out-dir"] ?? "data/digests";
  await mkdir(dir, { recursive: true }).catch((err: Error) =>
    log({ event: "digest_files_failed", error: err.message }),
  );
  const now = new Date().toISOString();
  const mailer: Mailer | null =
    process.env.RESEND_API_KEY && process.env.RADAR_EMAIL_FROM
      ? withSubjectPrefix(
          new ResendMailer(process.env.RESEND_API_KEY, process.env.RADAR_EMAIL_FROM),
          process.env.RADAR_SUBJECT_PREFIX,
        )
      : null;
  // Test send: RADAR_TEST_RECIPIENT gets the email instead of the real recipients, the subject is marked
  // [TEST], and nothing is recorded as delivered, so the real recipients' next email is unchanged.
  // Active only until RADAR_TEST_UNTIL (ISO time), so a forgotten setting cannot divert real emails.
  const testTo =
    process.env.RADAR_TEST_RECIPIENT && (process.env.RADAR_TEST_UNTIL ?? "") > now
      ? process.env.RADAR_TEST_RECIPIENT.trim()
      : null;
  if (testTo && !/^[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+$/.test(testTo))
    throw new Error("RADAR_TEST_RECIPIENT must be one email address");
  if (testTo) log({ event: "test_send", until: process.env.RADAR_TEST_UNTIL });
  // Yes/No feedback links need the signing secret and the API's public address. They appear in test sends,
  // and in real emails only once RADAR_FEEDBACK_LIVE=1, so the feature can be tried end to end first.
  const feedback =
    process.env.RADAR_FEEDBACK_SECRET &&
    process.env.RADAR_PUBLIC_URL &&
    (testTo || process.env.RADAR_FEEDBACK_LIVE === "1")
      ? { secret: process.env.RADAR_FEEDBACK_SECRET, baseUrl: process.env.RADAR_PUBLIC_URL }
      : null;
  // One FEMA lookup per (states, since) per run, shared across profiles.
  const http = new HttpClient({ userAgent: USER_AGENT, minIntervalMs: 1000 });
  const signalCache = new Map<string, ReturnType<typeof recentSignals>>();
  const digestResults = await deliverDigests(repo, {
    log,
    now,
    mailer,
    recipientOverrides: parseRecipients(process.env.RADAR_RECIPIENTS),
    testTo,
    feedback,
    unsubscribe: `mailto:${process.env.RADAR_UNSUBSCRIBE_EMAIL ?? "radar-unsubscribe@rfppilot.com"}?subject=unsubscribe`,
    // RADAR_DIGEST_REPLAY_UNTIL (ISO time) re-sends the full current list on runs before that time, for
    // previewing a template change. It expires on its own, so a forgotten setting cannot spam anyone.
    replay: (process.env.RADAR_DIGEST_REPLAY_UNTIL ?? "") > now,
    federalMinScore: Number(process.env.RADAR_FEDERAL_MIN_SCORE ?? FEDERAL_MIN_SCORE),
    summarizer:
      process.env.ANTHROPIC_API_KEY && process.env.RADAR_SUMMARY !== "off"
        ? new AnthropicSummarizer(process.env.ANTHROPIC_API_KEY)
        : null,
    signalsFor:
      values.signals === "off"
        ? undefined
        : (states, since) => {
            const key = `${[...states].sort().join(",")}|${since.slice(0, 10)}`;
            if (!signalCache.has(key)) signalCache.set(key, recentSignals(http, states, since));
            return signalCache.get(key)!;
          },
    writeFiles: async (stem, files) => {
      for (const [ext, body] of Object.entries(files)) await writeFile(`${dir}/${stem}.${ext}`, body);
    },
  });

  // Health check: one email to the operator (RADAR_ALERT_EMAIL) listing anything that went wrong.
  const problems = await healthProblems(repo, sourceResults, [...scoreResults, ...digestResults], now);
  await sendAlert({ mailer, to: process.env.RADAR_ALERT_EMAIL?.trim() || null, log, now }, problems);
  // A customer-facing failure (a profile not scored or not emailed) fails the run, so the scheduler shows it.
  if ([...scoreResults, ...digestResults].some((r) => !r.ok)) process.exitCode = 1;
}

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
      await withWorkerLock(repo, async () => {
        await ingest(repo, sources, max);
      });
    } else if (cmd === "import") {
      if (!values.source || !values.file) throw new Error("import needs --source and --file");
      await importFile(repo, values.source, values.file);
    } else if (cmd === "score") {
      await withWorkerLock(repo, async () => {
        if ((await scoreAll(repo)).some((r) => !r.ok)) process.exitCode = 1;
      });
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
      await withWorkerLock(repo, () => daily(repo, values, sources, max));
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
