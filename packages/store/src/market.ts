import { createHash } from "node:crypto";
import { gzipSync } from "node:zlib";
import type {
  FederalAward,
  FederalAwardDetail,
  MarketCapture,
  MarketSourceId,
  PaApplicant,
  PaProject,
} from "@radar/core";
import type { Queryable } from "./postgres.js";

/**
 * Storage for public market data (Flight Deck Market Intelligence). Separate from the opportunity repository on
 * purpose: these tables hold public-source data only, written only by the market collectors.
 */
export interface MarketRunRecord {
  source: MarketSourceId;
  startedAt: string;
  finishedAt: string;
  windowSince: string | null;
  windowUntil: string | null;
  fetched: number;
  inserted: number;
  updated: number;
  rejected: number;
  captures: number;
  complete: boolean;
  notes: string[];
  error: string | null;
}

export interface MarketUpsert {
  inserted: number;
  updated: number;
}

export interface MarketStore {
  /** Stores raw responses (de-duplicated by content) and returns their ids, in order. */
  saveCaptures(captures: MarketCapture[]): Promise<number[]>;
  upsertFederalAwards(awards: FederalAward[], captureIds: number[], now: string): Promise<MarketUpsert>;
  upsertPaProjects(projects: PaProject[], captureIds: number[], now: string): Promise<MarketUpsert>;
  upsertPaApplicants(applicants: PaApplicant[], now: string): Promise<MarketUpsert>;
  /**
   * Awards whose details were never read, or were read for an older version of the award, most recently changed
   * first. Awards still running (or ending within a year) come before long-finished ones, since they matter for
   * recompetes.
   */
  awardsNeedingDetail(limit: number, today: string): Promise<string[]>;
  /** Saves details and marks them as read for the award's current version. Returns how many awards were saved. */
  saveAwardDetails(details: FederalAwardDetail[], captureIds: number[], now: string): Promise<number>;
  recordMarketRun(run: MarketRunRecord): Promise<void>;
  /** End of the window of the source's latest complete, error-free run: where the next run picks up. */
  lastMarketWindowEnd(source: MarketSourceId): Promise<string | null>;
  /** Finish time of the source's latest error-free run, for staleness alerts. */
  lastMarketSuccessAt(source: MarketSourceId): Promise<string | null>;
}

/** Content key for a capture: the collector's own key, or a hash of the body. */
export const captureKey = (c: MarketCapture) =>
  c.contentKey ?? createHash("sha256").update(c.body).digest("hex");

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : v == null ? null : String(v));
const CHUNK = 200;

export class PostgresMarketStore implements MarketStore {
  constructor(private readonly db: Pick<Queryable, "query">) {}

  async saveCaptures(captures: MarketCapture[]): Promise<number[]> {
    const ids: number[] = [];
    for (const c of captures) {
      const gz = gzipSync(Buffer.from(c.body, "utf8"));
      const r = await this.db.query<{ id: string | number }>(
        `INSERT INTO market.captures (source, url, request, retrieved_at, content_key, body_gz, bytes)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (source, content_key) DO UPDATE SET retrieved_at = GREATEST(market.captures.retrieved_at, EXCLUDED.retrieved_at)
         RETURNING id`,
        [
          c.source,
          c.url,
          c.request === null ? null : JSON.stringify(c.request),
          c.retrievedAt,
          captureKey(c),
          gz,
          c.body.length,
        ],
      );
      ids.push(Number(r.rows[0]!.id));
    }
    return ids;
  }

  async upsertFederalAwards(
    awards: FederalAward[],
    captureIds: number[],
    now: string,
  ): Promise<MarketUpsert> {
    return this.upsert(
      "market.federal_awards",
      "award_key",
      [
        "award_key",
        "award_id",
        "recipient_name",
        "recipient_uei",
        "amount",
        "amount_type",
        "start_date",
        "end_date",
        "awarding_agency",
        "awarding_sub_agency",
        "award_type",
        "naics",
        "naics_description",
        "psc",
        "psc_description",
        "pop_state",
        "description",
        "last_modified",
        "source_url",
        "content_hash",
        "capture_id",
      ],
      awards.map((a) => [
        a.key,
        a.awardId,
        a.recipientName,
        a.recipientUei,
        a.amount,
        a.amountType,
        a.startDate,
        a.endDate,
        a.awardingAgency,
        a.awardingSubAgency,
        a.awardType,
        a.naics,
        a.naicsDescription,
        a.psc,
        a.pscDescription,
        a.popState,
        a.description,
        a.lastModified,
        a.sourceUrl,
        a.contentHash,
        captureId(captureIds, a.captureIndex),
      ]),
      now,
    );
  }

  async upsertPaProjects(projects: PaProject[], captureIds: number[], now: string): Promise<MarketUpsert> {
    return this.upsert(
      "market.pa_projects",
      "project_key",
      [
        "project_key",
        "disaster_number",
        "pw_number",
        "applicant_id",
        "state",
        "county",
        "county_code",
        "damage_category",
        "damage_category_name",
        "title",
        "status",
        "process_step",
        "project_amount",
        "federal_share_obligated",
        "total_obligated",
        "first_obligation_date",
        "last_obligation_date",
        "declaration_date",
        "incident_type",
        "last_refresh",
        "source_url",
        "content_hash",
        "capture_id",
      ],
      projects.map((p) => [
        p.key,
        p.disasterNumber,
        p.pwNumber,
        p.applicantId,
        p.state,
        p.county,
        p.countyCode,
        p.damageCategory,
        p.damageCategoryName,
        p.title,
        p.status,
        p.processStep,
        p.projectAmount,
        p.federalShareObligated,
        p.totalObligated,
        p.firstObligationDate,
        p.lastObligationDate,
        p.declarationDate,
        p.incidentType,
        p.lastRefresh,
        p.sourceUrl,
        p.contentHash,
        captureId(captureIds, p.captureIndex),
      ]),
      now,
    );
  }

  async upsertPaApplicants(applicants: PaApplicant[], now: string): Promise<MarketUpsert> {
    return this.upsert(
      "market.pa_applicants",
      "applicant_key",
      [
        "applicant_key",
        "disaster_number",
        "applicant_id",
        "name",
        "state",
        "city",
        "last_refresh",
        "content_hash",
      ],
      applicants.map((a) => [
        a.key,
        a.disasterNumber,
        a.applicantId,
        a.name,
        a.state,
        a.city,
        a.lastRefresh,
        a.contentHash,
      ]),
      now,
    );
  }

  /**
   * Inserts new rows and rewrites existing ones only when their content hash changed, in chunks. `xmax = 0` tells
   * an inserted row from an updated one; unchanged rows are left alone and counted as neither.
   */
  private async upsert(
    table: string,
    key: string,
    cols: string[],
    rows: unknown[][],
    now: string,
  ): Promise<MarketUpsert> {
    let inserted = 0;
    let updated = 0;
    const all = [...cols, "first_seen_at", "updated_at"];
    const set = [...cols.filter((c) => c !== key), "updated_at"]
      .map((c) => `${c} = EXCLUDED.${c}`)
      .join(", ");
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK);
      const params: unknown[] = [];
      const values = chunk
        .map((r) => {
          const row = [...r, now, now];
          return `(${row.map((v) => (params.push(v), `$${params.length}`)).join(",")})`;
        })
        .join(",");
      const res = await this.db.query<{ inserted: boolean }>(
        `INSERT INTO ${table} (${all.join(",")}) VALUES ${values}
         ON CONFLICT (${key}) DO UPDATE SET ${set}
         WHERE ${table}.content_hash IS DISTINCT FROM EXCLUDED.content_hash
         RETURNING (xmax = 0) AS inserted`,
        params,
      );
      for (const r of res.rows) r.inserted ? inserted++ : updated++;
    }
    return { inserted, updated };
  }

  async awardsNeedingDetail(limit: number, today: string): Promise<string[]> {
    const r = await this.db.query<{ award_key: string }>(
      `SELECT award_key FROM market.federal_awards
       WHERE detail_for_hash IS DISTINCT FROM content_hash
       ORDER BY (end_date IS NULL OR end_date >= ($2::date - INTERVAL '1 year')) DESC, updated_at DESC, award_key
       LIMIT $1`,
      [limit, today.slice(0, 10)],
    );
    return r.rows.map((x) => x.award_key);
  }

  async saveAwardDetails(details: FederalAwardDetail[], captureIds: number[], now: string): Promise<number> {
    let changed = 0;
    for (const d of details) {
      const r = await this.db.query<{ award_key: string }>(
        `UPDATE market.federal_awards SET
           solicitation_id=$2, offers_received=$3, extent_competed=$4, extent_competed_name=$5, set_aside=$6,
           set_aside_name=$7, pricing_type=$8, base_and_all_options=$9, total_obligation=$10, potential_end_date=$11,
           parent_award_key=$12, detail_capture_id=$14, detail_fetched_at=$15, detail_for_hash=content_hash,
           detail_hash=$13
         WHERE award_key=$1
         RETURNING award_key`,
        [
          d.key,
          d.solicitationId,
          d.offersReceived,
          d.extentCompeted,
          d.extentCompetedName,
          d.setAside,
          d.setAsideName,
          d.pricingType,
          d.baseAndAllOptions,
          d.totalObligation,
          d.potentialEndDate,
          d.parentAwardKey,
          d.contentHash,
          captureId(captureIds, d.captureIndex),
          now,
        ],
      );
      if (r.rows[0]) changed++;
    }
    return changed;
  }

  async recordMarketRun(r: MarketRunRecord): Promise<void> {
    await this.db.query(
      `INSERT INTO market.runs (source, started_at, finished_at, window_since, window_until, fetched, inserted, updated,
         rejected, captures, complete, notes, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
      [
        r.source,
        r.startedAt,
        r.finishedAt,
        r.windowSince,
        r.windowUntil,
        r.fetched,
        r.inserted,
        r.updated,
        r.rejected,
        r.captures,
        r.complete,
        JSON.stringify(r.notes),
        r.error,
      ],
    );
  }

  async lastMarketWindowEnd(source: MarketSourceId): Promise<string | null> {
    const r = await this.db.query<{ at: unknown }>(
      `SELECT max(window_until) AS at FROM market.runs WHERE source=$1 AND complete AND error IS NULL`,
      [source],
    );
    return iso(r.rows[0]?.at ?? null);
  }

  async lastMarketSuccessAt(source: MarketSourceId): Promise<string | null> {
    const r = await this.db.query<{ at: unknown }>(
      `SELECT max(finished_at) AS at FROM market.runs WHERE source=$1 AND error IS NULL`,
      [source],
    );
    return iso(r.rows[0]?.at ?? null);
  }
}

const captureId = (ids: number[], index: number | undefined) =>
  index === undefined ? null : (ids[index] ?? null);

/** In-memory store for tests and RADAR_ALLOW_MEMORY runs. Same semantics as the Postgres store. */
export class MemoryMarketStore implements MarketStore {
  readonly captures: (MarketCapture & { id: number })[] = [];
  readonly awards = new Map<string, FederalAward>();
  readonly projects = new Map<string, PaProject>();
  readonly applicants = new Map<string, PaApplicant>();
  readonly runs: MarketRunRecord[] = [];

  async saveCaptures(captures: MarketCapture[]): Promise<number[]> {
    return captures.map((c) => {
      const found = this.captures.find((x) => x.source === c.source && captureKey(x) === captureKey(c));
      if (found) return found.id;
      const id = this.captures.length + 1;
      this.captures.push({ ...c, id });
      return id;
    });
  }

  private put<T extends { key: string; contentHash: string }>(map: Map<string, T>, rows: T[]): MarketUpsert {
    let inserted = 0;
    let updated = 0;
    for (const r of rows) {
      const cur = map.get(r.key);
      if (!cur) inserted++;
      else if (cur.contentHash !== r.contentHash) updated++;
      else continue;
      map.set(r.key, r);
    }
    return { inserted, updated };
  }

  async upsertFederalAwards(a: FederalAward[], _captureIds?: number[], _now?: string) {
    return this.put(this.awards, a);
  }
  async upsertPaProjects(p: PaProject[], _captureIds?: number[], _now?: string) {
    return this.put(this.projects, p);
  }
  async upsertPaApplicants(a: PaApplicant[], _now?: string) {
    return this.put(this.applicants, a);
  }
  readonly details = new Map<string, FederalAwardDetail & { forHash: string }>();
  async awardsNeedingDetail(limit: number, today: string) {
    const cutoff = `${Number(today.slice(0, 4)) - 1}${today.slice(4, 10)}`;
    return [...this.awards.values()]
      .filter((a) => this.details.get(a.key)?.forHash !== a.contentHash)
      .sort((x, y) =>
        Number(!x.endDate || x.endDate >= cutoff) < Number(!y.endDate || y.endDate >= cutoff) ? 1 : -1,
      )
      .slice(0, limit)
      .map((a) => a.key);
  }
  async saveAwardDetails(details: FederalAwardDetail[], _captureIds?: number[], _now?: string) {
    let changed = 0;
    for (const d of details) {
      const a = this.awards.get(d.key);
      if (!a) continue;
      this.details.set(d.key, { ...d, forHash: a.contentHash });
      changed++;
    }
    return changed;
  }
  async recordMarketRun(r: MarketRunRecord) {
    this.runs.push(r);
  }
  async lastMarketWindowEnd(source: MarketSourceId) {
    const ends = this.runs
      .filter((r) => r.source === source && r.complete && !r.error && r.windowUntil)
      .map((r) => r.windowUntil!);
    return ends.sort().at(-1) ?? null;
  }
  async lastMarketSuccessAt(source: MarketSourceId) {
    const done = this.runs.filter((r) => r.source === source && !r.error).map((r) => r.finishedAt);
    return done.sort().at(-1) ?? null;
  }
}
