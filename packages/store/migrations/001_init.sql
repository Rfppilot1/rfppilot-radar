-- Radar initial schema. Opportunities are public records shared across tenants. Everything a tenant creates
-- (profiles, matches, decisions, digest runs) is keyed by (tenant_id, profile_id), so two tenants can use the
-- same profile id and no query can reach another tenant's rows without naming that tenant.

CREATE TABLE IF NOT EXISTS opportunities (
  id               TEXT PRIMARY KEY,
  source           TEXT NOT NULL,
  source_record_id TEXT NOT NULL,
  status           TEXT NOT NULL,
  kind             TEXT NOT NULL,
  state            TEXT,
  posted_at        TIMESTAMPTZ,
  due_at           TIMESTAMPTZ,
  content_hash     TEXT NOT NULL,
  first_seen_at    TIMESTAMPTZ NOT NULL,
  last_seen_at     TIMESTAMPTZ NOT NULL,
  last_changed_at  TIMESTAMPTZ NOT NULL,
  data             JSONB NOT NULL,
  UNIQUE (source, source_record_id)
);
CREATE INDEX IF NOT EXISTS opportunities_due_idx ON opportunities (due_at);
CREATE INDEX IF NOT EXISTS opportunities_state_status_idx ON opportunities (state, status);
CREATE INDEX IF NOT EXISTS opportunities_source_seen_idx ON opportunities (source, last_seen_at);

-- Append-only history: one row each time a record's content changes (including reverts to an earlier state).
CREATE TABLE IF NOT EXISTS opportunity_versions (
  id             BIGSERIAL PRIMARY KEY,
  opportunity_id TEXT NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
  content_hash   TEXT NOT NULL,
  seen_at        TIMESTAMPTZ NOT NULL,
  data           JSONB NOT NULL
);
CREATE INDEX IF NOT EXISTS opportunity_versions_opp_idx ON opportunity_versions (opportunity_id, seen_at);

CREATE TABLE IF NOT EXISTS profiles (
  tenant_id  TEXT NOT NULL,
  id         TEXT NOT NULL,
  data       JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, id)
);

CREATE TABLE IF NOT EXISTS matches (
  tenant_id        TEXT NOT NULL,
  profile_id       TEXT NOT NULL,
  opportunity_id   TEXT NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
  score            REAL NOT NULL,
  band             TEXT NOT NULL,
  lane             TEXT NOT NULL,
  first_matched_at TIMESTAMPTZ NOT NULL,
  -- First time this match reached "strong" or "possible"; drives "new matches" in the digest.
  first_good_at    TIMESTAMPTZ,
  scored_at        TIMESTAMPTZ NOT NULL,
  data             JSONB NOT NULL,
  PRIMARY KEY (tenant_id, profile_id, opportunity_id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS matches_profile_band_idx ON matches (tenant_id, profile_id, band, score DESC);

CREATE TABLE IF NOT EXISTS decisions (
  tenant_id        TEXT NOT NULL,
  profile_id       TEXT NOT NULL,
  opportunity_id   TEXT NOT NULL REFERENCES opportunities (id) ON DELETE CASCADE,
  decision         TEXT NOT NULL,
  hash_at_decision TEXT NOT NULL,
  decided_at       TIMESTAMPTZ NOT NULL,
  data             JSONB NOT NULL,
  PRIMARY KEY (tenant_id, profile_id, opportunity_id),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS digest_runs (
  tenant_id    TEXT NOT NULL,
  profile_id   TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  PRIMARY KEY (tenant_id, profile_id, generated_at),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles (tenant_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS ingest_runs (
  id          BIGSERIAL PRIMARY KEY,
  source      TEXT NOT NULL,
  started_at  TIMESTAMPTZ NOT NULL,
  finished_at TIMESTAMPTZ NOT NULL,
  fetched     INTEGER NOT NULL,
  inserted    INTEGER NOT NULL,
  updated     INTEGER NOT NULL,
  closed      INTEGER NOT NULL DEFAULT 0,
  rejected    INTEGER NOT NULL,
  complete    BOOLEAN NOT NULL DEFAULT FALSE,
  error       TEXT
);
