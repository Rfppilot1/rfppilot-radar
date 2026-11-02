import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { FirmProfile, Opportunity, type Decision, type Match } from "@radar/core";
import {
  MAX_CLOSE_SHARE,
  NotFoundError,
  type CloseResult,
  type DeliveryRecord,
  type IngestRunRecord,
  type MatchQuery,
  type OpportunityQuery,
  type Repository,
  type RunLock,
  type StoredDecision,
  type StoredMatch,
  type UpsertResult,
} from "./repository.js";

/** Minimal query surface satisfied by `pg.Pool`, `pg.Client` and PGlite, so tests run real SQL without a server. */
export interface Queryable {
  query<R = Record<string, unknown>>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  end?(): Promise<void>;
  close?(): Promise<void>;
  exec?(sql: string): Promise<unknown>;
}

/** A pool that can lend a single connection (pg.Pool); needed to hold a session-level advisory lock. */
interface PoolLike extends Queryable {
  connect(): Promise<
    Pick<Queryable, "query"> & {
      release(err?: Error | boolean): void;
      on?(event: "error", fn: (err: Error) => void): unknown;
      off?(event: "error", fn: (err: Error) => void): unknown;
    }
  >;
}

const MIGRATIONS_DIR = fileURLToPath(new URL("../migrations/", import.meta.url));
const MIGRATION_LOCK = 72_727_001;
/** Namespace for worker run locks (`tryRunLock`); the second key is hashtext(name). */
const RUN_LOCK_NS = 72_727_002;
/** Records written per transaction during ingest. */
const UPSERT_CHUNK = 200;

/**
 * Applies pending SQL migrations in filename order, each recorded in schema_migrations. Holds a Postgres
 * advisory lock on one connection so an API and a worker starting together cannot run migrations twice.
 */
export async function migrate(pool: Queryable | PoolLike, dir = MIGRATIONS_DIR): Promise<string[]> {
  const client = "connect" in pool && typeof pool.connect === "function" ? await pool.connect() : null;
  const db: Pick<Queryable, "query" | "exec"> = client ?? pool;
  try {
    await db.query(`SELECT pg_advisory_lock($1)`, [MIGRATION_LOCK]);
    await db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`,
    );
    const done = new Set(
      (await db.query<{ name: string }>(`SELECT name FROM schema_migrations`)).rows.map((r) => r.name),
    );
    const applied: string[] = [];
    for (const file of (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort()) {
      if (done.has(file)) continue;
      const sql = await readFile(`${dir}${file}`, "utf8");
      // A migration and its record land together or not at all, so a failed one is retried whole. (So a
      // migration cannot use CREATE INDEX CONCURRENTLY, which refuses to run inside a transaction.)
      await db.query("BEGIN");
      try {
        if (db.exec) await db.exec(sql);
        else await db.query(sql);
        await db.query(`INSERT INTO schema_migrations (name) VALUES ($1)`, [file]);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK").catch(() => {});
        throw err;
      }
      applied.push(file);
    }
    return applied;
  } finally {
    await db.query(`SELECT pg_advisory_unlock($1)`, [MIGRATION_LOCK]).catch(() => {});
    client?.release();
  }
}

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const json = (v: unknown) => (typeof v === "string" ? JSON.parse(v) : v);

type MatchRow = { data: unknown; first_matched_at: unknown; first_good_at: unknown };
const toStoredMatch = (r: MatchRow): StoredMatch => ({
  ...(json(r.data) as Match),
  firstMatchedAt: iso(r.first_matched_at)!,
  firstGoodAt: iso(r.first_good_at),
});

type Q = Pick<Queryable, "query">;
const limitSql = (limit: number | "all" | undefined, p: unknown[]) => {
  if (limit === "all") return "";
  p.push(limit ?? 500);
  return ` LIMIT $${p.length}`;
};

export class PostgresRepository implements Repository {
  constructor(private readonly db: Queryable) {}

  /** A dedicated pooled connection when the driver has a pool (pg.Pool); otherwise the single connection. */
  private async lease(): Promise<{ q: Q; release: () => void }> {
    const pool = this.db as Partial<PoolLike>;
    if (typeof pool.connect === "function") {
      const c = await pool.connect.call(this.db);
      // A checked-out client has no pool error listener; without one, a dropped connection (database restart,
      // idle timeout) would be an uncaught exception that kills the process mid-run. Record the error instead,
      // and hand a broken client back as broken so the pool discards it. Losing the session also drops any
      // advisory lock it held; the next query on it fails and the run reports that failure.
      let broken: Error | null = null;
      const onError = (err: Error) => {
        broken = err;
      };
      c.on?.("error", onError);
      return {
        q: c,
        release: () => {
          c.off?.("error", onError);
          c.release(broken ?? undefined);
        },
      };
    }
    return { q: this.db, release: () => {} };
  }

  /** Runs `fn` in one transaction on one connection; rolls back on any error. */
  private async tx<T>(fn: (q: Q) => Promise<T>): Promise<T> {
    const { q, release } = await this.lease();
    try {
      await q.query("BEGIN");
      try {
        const out = await fn(q);
        await q.query("COMMIT");
        return out;
      } catch (err) {
        await q.query("ROLLBACK").catch(() => {});
        throw err;
      }
    } finally {
      release();
    }
  }

  /**
   * Each record's row and its version row are written in the same transaction (chunks of UPSERT_CHUNK), so a
   * crash can never leave a changed record without the version that change alerts are computed from.
   * Records are written in id order, so two concurrent runs take row locks in the same order. Concurrent runs
   * may both try to insert; only one wins the INSERT and the other falls through to the conditional UPDATE.
   */
  async upsertOpportunities(opps: Opportunity[], seenAt: string): Promise<UpsertResult> {
    const r: UpsertResult = { inserted: [], updated: [], unchanged: 0 };
    const sorted = [...opps].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (let i = 0; i < sorted.length; i += UPSERT_CHUNK) {
      const chunk = sorted.slice(i, i + UPSERT_CHUNK);
      const part = await this.tx((q) => this.upsertChunk(q, chunk, seenAt));
      r.inserted.push(...part.inserted);
      r.updated.push(...part.updated);
      r.unchanged += part.unchanged;
    }
    return r;
  }

  private async upsertChunk(db: Q, opps: Opportunity[], seenAt: string): Promise<UpsertResult> {
    const r: UpsertResult = { inserted: [], updated: [], unchanged: 0 };
    for (const o of opps) {
      const h = o.provenance.contentHash;
      const data = JSON.stringify(o);
      const ins = await db.query(
        `INSERT INTO opportunities (id, source, source_record_id, status, kind, state, posted_at, due_at, content_hash,
           first_seen_at, last_seen_at, last_changed_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10,$10,$11)
         ON CONFLICT (id) DO NOTHING RETURNING id`,
        [o.id, o.source, o.sourceRecordId, o.status, o.kind, o.state, o.postedAt, o.dueAt, h, seenAt, data],
      );
      if (ins.rows.length === 0) {
        const upd = await db.query(
          `UPDATE opportunities SET status=$2, kind=$3, state=$4, posted_at=$5, due_at=$6, content_hash=$7,
             last_seen_at=$8, last_changed_at=$8, data=$9
           WHERE id=$1 AND content_hash <> $7 RETURNING id`,
          [o.id, o.status, o.kind, o.state, o.postedAt, o.dueAt, h, seenAt, data],
        );
        if (upd.rows.length === 0) {
          // Same content but a different stored status: a record closed by absence has reappeared upstream.
          const reopened = await db.query(
            `UPDATE opportunities SET status=$2, data=$3, last_seen_at=GREATEST(last_seen_at, $4)
              WHERE id=$1 AND status <> $2 RETURNING id`,
            [o.id, o.status, data, seenAt],
          );
          if (reopened.rows.length > 0) {
            r.updated.push(o.id);
            continue;
          }
          await db.query(`UPDATE opportunities SET last_seen_at=GREATEST(last_seen_at, $2) WHERE id=$1`, [
            o.id,
            seenAt,
          ]);
          r.unchanged++;
          continue;
        }
        r.updated.push(o.id);
      } else {
        r.inserted.push(o.id);
      }
      await db.query(
        `INSERT INTO opportunity_versions (opportunity_id, content_hash, seen_at, data) VALUES ($1,$2,$3,$4)`,
        [o.id, h, seenAt, data],
      );
    }
    return r;
  }

  async closeMissing(source: string, seenSince: string, maxShare = MAX_CLOSE_SHARE): Promise<CloseResult> {
    const c = (
      await this.db.query<{ open: number | string; missing: number | string }>(
        `SELECT count(*) AS open, count(*) FILTER (WHERE last_seen_at < $2) AS missing
           FROM opportunities WHERE source = $1 AND status IN ('open','preview')`,
        [source, seenSince],
      )
    ).rows[0];
    const open = Number(c?.open ?? 0);
    const missing = Number(c?.missing ?? 0);
    const result = { closed: [] as string[], refused: false, wouldClose: missing, open };
    if (missing === 0) return result;
    if (missing > open * maxShare) return { ...result, refused: true };
    // The close and its version rows commit together, so a digest never misses a pulled posting.
    const closed = await this.tx(async (db) => {
      const rows = (
        await db.query<{ id: string }>(
          `UPDATE opportunities
            SET status = 'closed', data = jsonb_set(data, '{status}', '"closed"')
          WHERE source = $1 AND status IN ('open','preview') AND last_seen_at < $2
          RETURNING id`,
          [source, seenSince],
        )
      ).rows;
      // Record the close as a version, so a digest can tell a reader that a tracked posting was pulled.
      if (rows.length)
        await db.query(
          `INSERT INTO opportunity_versions (opportunity_id, content_hash, seen_at, data)
         SELECT id, content_hash, $2, data FROM opportunities WHERE id = ANY($1)`,
          [rows.map((r) => r.id), seenSince],
        );
      return rows.map((r) => r.id);
    });
    return { ...result, closed };
  }

  async touchSeen(ids: string[], seenAt: string) {
    if (ids.length === 0) return;
    await this.db.query(
      `UPDATE opportunities SET last_seen_at = GREATEST(last_seen_at, $2) WHERE id = ANY($1)`,
      [ids, seenAt],
    );
  }

  async getOpportunity(id: string) {
    const row = (await this.db.query<{ data: unknown }>(`SELECT data FROM opportunities WHERE id=$1`, [id]))
      .rows[0];
    return row ? Opportunity.parse(json(row.data)) : null;
  }

  async getOpportunities(ids: string[]) {
    const m = new Map<string, Opportunity>();
    if (ids.length === 0) return m;
    const rows = (
      await this.db.query<{ data: unknown }>(`SELECT data FROM opportunities WHERE id = ANY($1)`, [ids])
    ).rows;
    for (const r of rows) {
      const o = Opportunity.parse(json(r.data));
      m.set(o.id, o);
    }
    return m;
  }

  async changedSince(since: string) {
    return (
      await this.db.query<{ id: string }>(
        `SELECT DISTINCT opportunity_id AS id FROM opportunity_versions WHERE seen_at >= $1`,
        [since],
      )
    ).rows.map((r) => r.id);
  }

  async versionsBefore(ids: string[], before: string) {
    const m = new Map<string, Opportunity>();
    if (ids.length === 0) return m;
    const rows = (
      await this.db.query<{ id: string; data: unknown }>(
        `SELECT DISTINCT ON (opportunity_id) opportunity_id AS id, data FROM opportunity_versions
          WHERE opportunity_id = ANY($1) AND seen_at < $2 ORDER BY opportunity_id, seen_at DESC, id DESC`,
        [ids, before],
      )
    ).rows;
    for (const r of rows) m.set(r.id, Opportunity.parse(json(r.data)));
    return m;
  }

  async listOpportunities(q: OpportunityQuery) {
    const where: string[] = [];
    const p: unknown[] = [];
    if (q.states) {
      p.push(q.states);
      where.push(`(state = ANY($${p.length}) OR (state IS NULL AND data->'buyer'->>'level' = 'federal'))`);
    }
    if (q.sources) {
      p.push(q.sources);
      where.push(`source = ANY($${p.length})`);
    }
    if (q.openOnly) where.push(`status IN ('open','preview')`);
    if (q.dueAfter) {
      p.push(q.dueAfter);
      where.push(`(due_at IS NULL OR due_at >= $${p.length})`);
    }
    const sql = `SELECT data FROM opportunities ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                 ORDER BY due_at ASC NULLS LAST, id${limitSql(q.limit, p)}`;
    return (await this.db.query<{ data: unknown }>(sql, p)).rows.map((r) => Opportunity.parse(json(r.data)));
  }

  async upsertProfile(profile: FirmProfile, at: string) {
    await this.db.query(
      `INSERT INTO profiles (tenant_id, id, data, updated_at) VALUES ($1,$2,$3,$4)
       ON CONFLICT (tenant_id, id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`,
      [profile.tenantId, profile.id, JSON.stringify(profile), at],
    );
  }

  async getProfile(tenantId: string, profileId: string) {
    if (!tenantId) return null;
    const row = (
      await this.db.query<{ data: unknown }>(`SELECT data FROM profiles WHERE tenant_id=$1 AND id=$2`, [
        tenantId,
        profileId,
      ])
    ).rows[0];
    return row ? FirmProfile.parse(json(row.data)) : null;
  }

  async listProfiles(tenantId: string) {
    if (!tenantId) throw new Error("tenantId is required");
    const rows = (
      await this.db.query<{ data: unknown }>(`SELECT data FROM profiles WHERE tenant_id=$1 ORDER BY id`, [
        tenantId,
      ])
    ).rows;
    return rows.map((r) => FirmProfile.parse(json(r.data)));
  }

  async listAllProfilesForWorker() {
    const rows = (await this.db.query<{ data: unknown }>(`SELECT data FROM profiles ORDER BY tenant_id, id`))
      .rows;
    return rows.map((r) => FirmProfile.parse(json(r.data)));
  }

  private async assertProfile(tenantId: string, profileId: string) {
    if (!(await this.getProfile(tenantId, profileId))) throw new NotFoundError("Profile");
  }

  async saveMatches(tenantId: string, matches: Match[]) {
    const profiles = new Set(matches.map((m) => m.profileId));
    for (const p of profiles) await this.assertProfile(tenantId, p);
    for (const m of matches) {
      const good = m.band === "strong" || m.band === "possible";
      await this.db.query(
        `INSERT INTO matches (tenant_id, profile_id, opportunity_id, score, band, lane, first_matched_at, first_good_at,
           scored_at, data)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$7,$9)
         ON CONFLICT (tenant_id, profile_id, opportunity_id) DO UPDATE SET score=EXCLUDED.score, band=EXCLUDED.band,
           lane=EXCLUDED.lane, scored_at=EXCLUDED.scored_at, data=EXCLUDED.data,
           first_good_at=COALESCE(matches.first_good_at, EXCLUDED.first_good_at)`,
        [
          tenantId,
          m.profileId,
          m.opportunityId,
          m.score,
          m.band,
          m.lane,
          m.scoredAt,
          good ? m.scoredAt : null,
          JSON.stringify(m),
        ],
      );
    }
  }

  async listMatches(tenantId: string, profileId: string, q: MatchQuery = {}) {
    await this.assertProfile(tenantId, profileId);
    const p: unknown[] = [tenantId, profileId];
    const where = [`m.tenant_id = $1`, `m.profile_id = $2`];
    if (q.bands) {
      p.push(q.bands);
      where.push(`m.band = ANY($${p.length})`);
    }
    if (q.lane) {
      p.push(q.lane);
      where.push(`m.lane = $${p.length}`);
    }
    if (q.firstGoodSince) {
      p.push(q.firstGoodSince);
      where.push(`m.first_good_at >= $${p.length}`);
    }
    if (q.activeAt) {
      p.push(q.activeAt);
      where.push(`o.status IN ('open','preview') AND (o.due_at IS NULL OR o.due_at >= $${p.length})`);
    }
    const lim = limitSql(q.limit, p);
    const rows = (
      await this.db.query<MatchRow>(
        `SELECT m.data, m.first_matched_at, m.first_good_at
           FROM matches m JOIN opportunities o ON o.id = m.opportunity_id
          WHERE ${where.join(" AND ")}
          ORDER BY m.score DESC, m.opportunity_id${lim}`,
        p,
      )
    ).rows;
    return rows.map(toStoredMatch);
  }

  async getMatch(tenantId: string, profileId: string, opportunityId: string): Promise<StoredMatch | null> {
    await this.assertProfile(tenantId, profileId);
    const r = (
      await this.db.query<MatchRow>(
        `SELECT data, first_matched_at, first_good_at FROM matches
          WHERE tenant_id=$1 AND profile_id=$2 AND opportunity_id=$3`,
        [tenantId, profileId, opportunityId],
      )
    ).rows[0];
    return r ? toStoredMatch(r) : null;
  }

  async saveDecision(tenantId: string, d: Decision): Promise<StoredDecision> {
    await this.assertProfile(tenantId, d.profileId);
    const opp = await this.getOpportunity(d.opportunityId);
    if (!opp) throw new NotFoundError("Opportunity");
    const hash = opp.provenance.contentHash;
    await this.db.query(
      `INSERT INTO decisions (tenant_id, profile_id, opportunity_id, decision, hash_at_decision, decided_at, data)
       VALUES ($1,$2,$3,$4,$5,$6,$7)
       ON CONFLICT (tenant_id, profile_id, opportunity_id) DO UPDATE SET decision=EXCLUDED.decision,
         hash_at_decision=EXCLUDED.hash_at_decision, decided_at=EXCLUDED.decided_at, data=EXCLUDED.data`,
      [tenantId, d.profileId, d.opportunityId, d.decision, hash, d.decidedAt, JSON.stringify(d)],
    );
    return { ...d, hashAtDecision: hash };
  }

  async listDecisions(tenantId: string, profileId: string) {
    await this.assertProfile(tenantId, profileId);
    const rows = (
      await this.db.query<{ data: unknown; hash_at_decision: string }>(
        `SELECT data, hash_at_decision FROM decisions WHERE tenant_id=$1 AND profile_id=$2`,
        [tenantId, profileId],
      )
    ).rows;
    return rows.map((r) => ({ ...(json(r.data) as Decision), hashAtDecision: r.hash_at_decision }));
  }

  async lastDigestAt(tenantId: string, profileId: string) {
    await this.assertProfile(tenantId, profileId);
    const r = (
      await this.db.query<{ at: unknown }>(
        `SELECT max(generated_at) AS at FROM digest_runs WHERE tenant_id=$1 AND profile_id=$2`,
        [tenantId, profileId],
      )
    ).rows[0];
    return iso(r?.at ?? null);
  }

  async recordDigest(tenantId: string, profileId: string, generatedAt: string) {
    await this.assertProfile(tenantId, profileId);
    await this.db.query(
      `INSERT INTO digest_runs (tenant_id, profile_id, generated_at) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [tenantId, profileId, generatedAt],
    );
  }

  async lastDeliveryAt(tenantId: string, profileId: string, recipient: string) {
    await this.assertProfile(tenantId, profileId);
    const r = (
      await this.db.query<{ at: unknown }>(
        `SELECT max(generated_at) AS at FROM digest_deliveries
          WHERE tenant_id=$1 AND profile_id=$2 AND recipient=$3`,
        [tenantId, profileId, recipient.trim().toLowerCase()],
      )
    ).rows[0];
    return iso(r?.at ?? null) ?? (await this.lastDigestAt(tenantId, profileId));
  }

  async recordDelivery(d: DeliveryRecord) {
    await this.assertProfile(d.tenantId, d.profileId);
    await this.db.query(
      `INSERT INTO digest_deliveries (tenant_id, profile_id, recipient, generated_at, message_id)
       VALUES ($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,
      [d.tenantId, d.profileId, d.recipient.trim().toLowerCase(), d.generatedAt, d.messageId],
    );
  }

  async lastCompleteRunAt(source: string) {
    const r = (
      await this.db.query<{ at: unknown }>(
        `SELECT max(finished_at) AS at FROM ingest_runs WHERE source=$1 AND complete`,
        [source],
      )
    ).rows[0];
    return iso(r?.at ?? null);
  }

  async lastSuccessfulRunAt(source: string) {
    const r = (
      await this.db.query<{ at: unknown }>(
        `SELECT max(finished_at) AS at FROM ingest_runs WHERE source=$1 AND error IS NULL`,
        [source],
      )
    ).rows[0];
    return iso(r?.at ?? null);
  }

  /** Session-level advisory lock held on one pooled connection for the length of the run. */
  async tryRunLock(name: string): Promise<RunLock | null> {
    const { q, release } = await this.lease();
    try {
      const got = (
        await q.query<{ ok: boolean }>(`SELECT pg_try_advisory_lock($1::int, hashtext($2)) AS ok`, [
          RUN_LOCK_NS,
          name,
        ])
      ).rows[0]?.ok;
      if (!got) {
        release();
        return null;
      }
    } catch (err) {
      release();
      throw err;
    }
    return {
      release: async () => {
        try {
          await q.query(`SELECT pg_advisory_unlock($1::int, hashtext($2))`, [RUN_LOCK_NS, name]);
        } finally {
          release();
        }
      },
    };
  }

  async ping() {
    await this.db.query(`SELECT 1`);
  }

  async recordRun(run: IngestRunRecord) {
    await this.db.query(
      `INSERT INTO ingest_runs (source, started_at, finished_at, fetched, inserted, updated, closed, rejected, complete, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        run.source,
        run.startedAt,
        run.finishedAt,
        run.fetched,
        run.inserted,
        run.updated,
        run.closed,
        run.rejected,
        run.complete,
        run.error,
      ],
    );
  }

  async close() {
    await (this.db.end?.() ?? this.db.close?.());
  }
}
