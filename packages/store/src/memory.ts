import type { Decision, FirmProfile, Match, Opportunity } from "@radar/core";
import {
  ACTIVE_STATUSES,
  GOOD_BANDS,
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

const key = (...parts: string[]) => parts.join("\u0000");

/** In-memory repository with the same semantics as the Postgres one. Used for tests and local demos. */
export class MemoryRepository implements Repository {
  private opps = new Map<string, { opp: Opportunity; firstSeen: string; lastSeen: string }>();
  private profiles = new Map<string, FirmProfile>();
  private matches = new Map<string, StoredMatch & { tenantId: string }>();
  private decisions = new Map<string, StoredDecision & { tenantId: string }>();
  private digests = new Map<string, string>();
  readonly versions: { opportunityId: string; contentHash: string; seenAt: string; data: Opportunity }[] = [];
  readonly runs: IngestRunRecord[] = [];
  readonly deliveries: DeliveryRecord[] = [];
  private locks = new Set<string>();

  async upsertOpportunities(opps: Opportunity[], seenAt: string): Promise<UpsertResult> {
    const r: UpsertResult = { inserted: [], updated: [], unchanged: 0 };
    for (const o of opps) {
      const prev = this.opps.get(o.id);
      if (!prev) {
        this.opps.set(o.id, { opp: o, firstSeen: seenAt, lastSeen: seenAt });
        r.inserted.push(o.id);
      } else if (prev.opp.provenance.contentHash !== o.provenance.contentHash) {
        this.opps.set(o.id, { opp: o, firstSeen: prev.firstSeen, lastSeen: seenAt });
        r.updated.push(o.id);
      } else if (prev.opp.status !== o.status) {
        // Same content but a different status: a record closed by absence has reappeared upstream.
        this.opps.set(o.id, { opp: o, firstSeen: prev.firstSeen, lastSeen: seenAt });
        r.updated.push(o.id);
      } else {
        prev.lastSeen = seenAt;
        r.unchanged++;
        continue;
      }
      this.versions.push({ opportunityId: o.id, contentHash: o.provenance.contentHash, seenAt, data: o });
    }
    return r;
  }

  async closeMissing(source: string, seenSince: string, maxShare = MAX_CLOSE_SHARE): Promise<CloseResult> {
    const open = [...this.opps.values()].filter(
      (v) => v.opp.source === source && ACTIVE_STATUSES.has(v.opp.status),
    );
    const missing = open.filter((v) => v.lastSeen < seenSince);
    const result = { closed: [] as string[], refused: false, wouldClose: missing.length, open: open.length };
    if (missing.length === 0) return result;
    if (missing.length > open.length * maxShare) return { ...result, refused: true };
    for (const v of missing) {
      v.opp = { ...v.opp, status: "closed" };
      result.closed.push(v.opp.id);
      this.versions.push({
        opportunityId: v.opp.id,
        contentHash: v.opp.provenance.contentHash,
        seenAt: seenSince,
        data: v.opp,
      });
    }
    return result;
  }

  async touchSeen(ids: string[], seenAt: string) {
    for (const id of ids) {
      const v = this.opps.get(id);
      if (v && v.lastSeen < seenAt) v.lastSeen = seenAt;
    }
  }

  async changedSince(since: string) {
    return [...new Set(this.versions.filter((v) => v.seenAt >= since).map((v) => v.opportunityId))];
  }

  async versionsBefore(ids: string[], before: string) {
    const want = new Set(ids);
    const m = new Map<string, Opportunity>();
    for (const v of this.versions)
      if (want.has(v.opportunityId) && v.seenAt < before) m.set(v.opportunityId, v.data);
    return m;
  }

  async getOpportunity(id: string) {
    return this.opps.get(id)?.opp ?? null;
  }

  async getOpportunities(ids: string[]) {
    const m = new Map<string, Opportunity>();
    for (const id of ids) {
      const o = this.opps.get(id)?.opp;
      if (o) m.set(id, o);
    }
    return m;
  }

  async listOpportunities(q: OpportunityQuery) {
    return [...this.opps.values()]
      .map((v) => v.opp)
      .filter(
        (o) =>
          !q.states ||
          (o.state !== null && q.states.includes(o.state)) ||
          (o.buyer.level === "federal" && o.state === null),
      )
      .filter((o) => !q.sources || q.sources.includes(o.source))
      .filter((o) => !q.openOnly || ACTIVE_STATUSES.has(o.status))
      .filter((o) => !q.dueAfter || o.dueAt === null || o.dueAt >= q.dueAfter)
      .sort((a, b) => (a.dueAt ?? "9999").localeCompare(b.dueAt ?? "9999") || a.id.localeCompare(b.id))
      .slice(0, q.limit === "all" ? undefined : (q.limit ?? 500));
  }

  async upsertProfile(profile: FirmProfile, _at?: string) {
    this.profiles.set(key(profile.tenantId, profile.id), profile);
  }

  async getProfile(tenantId: string, profileId: string) {
    return this.profiles.get(key(tenantId, profileId)) ?? null;
  }

  async listProfiles(tenantId: string) {
    if (!tenantId) throw new Error("tenantId is required");
    return [...this.profiles.values()].filter((p) => p.tenantId === tenantId);
  }

  async listAllProfilesForWorker() {
    return [...this.profiles.values()];
  }

  private async assertProfile(tenantId: string, profileId: string) {
    if (!tenantId || !(await this.getProfile(tenantId, profileId))) throw new NotFoundError("Profile");
  }

  async saveMatches(tenantId: string, matches: Match[]) {
    for (const m of matches) {
      await this.assertProfile(tenantId, m.profileId);
      const k = key(tenantId, m.profileId, m.opportunityId);
      const prev = this.matches.get(k);
      const good = GOOD_BANDS.has(m.band);
      this.matches.set(k, {
        ...m,
        tenantId,
        firstMatchedAt: prev?.firstMatchedAt ?? m.scoredAt,
        firstGoodAt: prev?.firstGoodAt ?? (good ? m.scoredAt : null),
      });
    }
  }

  async listMatches(tenantId: string, profileId: string, q: MatchQuery = {}): Promise<StoredMatch[]> {
    await this.assertProfile(tenantId, profileId);
    return [...this.matches.values()]
      .filter((m) => m.tenantId === tenantId && m.profileId === profileId)
      .filter((m) => !q.bands || q.bands.includes(m.band))
      .filter((m) => !q.lane || m.lane === q.lane)
      .filter((m) => !q.firstGoodSince || (m.firstGoodAt !== null && m.firstGoodAt >= q.firstGoodSince))
      .filter((m) => {
        if (!q.activeAt) return true;
        const o = this.opps.get(m.opportunityId)?.opp;
        return !!o && ACTIVE_STATUSES.has(o.status) && (o.dueAt === null || o.dueAt >= q.activeAt);
      })
      .sort((a, b) => b.score - a.score || a.opportunityId.localeCompare(b.opportunityId))
      .slice(0, q.limit === "all" ? undefined : (q.limit ?? 500))
      .map(({ tenantId: _t, ...m }) => m);
  }

  async getMatch(tenantId: string, profileId: string, opportunityId: string) {
    await this.assertProfile(tenantId, profileId);
    const m = this.matches.get(key(tenantId, profileId, opportunityId));
    if (!m) return null;
    const { tenantId: _t, ...rest } = m;
    return rest;
  }

  async saveDecision(tenantId: string, d: Decision) {
    await this.assertProfile(tenantId, d.profileId);
    const opp = await this.getOpportunity(d.opportunityId);
    if (!opp) throw new NotFoundError("Opportunity");
    const stored = { ...d, hashAtDecision: opp.provenance.contentHash };
    this.decisions.set(key(tenantId, d.profileId, d.opportunityId), { ...stored, tenantId });
    return stored;
  }

  async listDecisions(tenantId: string, profileId: string) {
    await this.assertProfile(tenantId, profileId);
    return [...this.decisions.values()]
      .filter((d) => d.tenantId === tenantId && d.profileId === profileId)
      .map(({ tenantId: _t, ...d }) => d);
  }

  async lastDigestAt(tenantId: string, profileId: string) {
    await this.assertProfile(tenantId, profileId);
    return this.digests.get(key(tenantId, profileId)) ?? null;
  }

  async recordDigest(tenantId: string, profileId: string, generatedAt: string) {
    await this.assertProfile(tenantId, profileId);
    this.digests.set(key(tenantId, profileId), generatedAt);
  }

  async lastDeliveryAt(tenantId: string, profileId: string, recipient: string) {
    await this.assertProfile(tenantId, profileId);
    const r = recipient.trim().toLowerCase();
    const mine = this.deliveries
      .filter((d) => d.tenantId === tenantId && d.profileId === profileId && d.recipient === r)
      .map((d) => d.generatedAt)
      .sort();
    return mine.at(-1) ?? (await this.lastDigestAt(tenantId, profileId));
  }

  async recordDelivery(d: DeliveryRecord) {
    await this.assertProfile(d.tenantId, d.profileId);
    this.deliveries.push({ ...d, recipient: d.recipient.trim().toLowerCase() });
  }

  async recordRun(run: IngestRunRecord) {
    this.runs.push(run);
  }

  async lastCompleteRunAt(source: string) {
    const done = this.runs.filter((r) => r.source === source && r.complete).map((r) => r.finishedAt);
    return done.sort().at(-1) ?? null;
  }

  async lastSuccessfulRunAt(source: string) {
    const ok = this.runs.filter((r) => r.source === source && !r.error).map((r) => r.finishedAt);
    return ok.sort().at(-1) ?? null;
  }

  async tryRunLock(name: string): Promise<RunLock | null> {
    if (this.locks.has(name)) return null;
    this.locks.add(name);
    return { release: async () => void this.locks.delete(name) };
  }

  async ping() {}

  async close() {}
}
