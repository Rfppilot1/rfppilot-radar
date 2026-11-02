-- Market Intelligence (Flight Deck): public award data, kept apart from opportunities and from any customer data.
-- Everything here is public-source data written only by the market collectors. Customer (tenant) data will live
-- in its own schema with row-level security; nothing from it is ever written here.
CREATE SCHEMA IF NOT EXISTS market;

-- Every raw response as fetched, compressed, for audit and re-parsing. A record points at the capture it came from,
-- so any figure can show its source and date.
CREATE TABLE IF NOT EXISTS market.captures (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  url          TEXT NOT NULL,
  request      JSONB,
  retrieved_at TIMESTAMPTZ NOT NULL,
  content_key  TEXT NOT NULL,
  body_gz      BYTEA NOT NULL,
  bytes        INTEGER NOT NULL,
  UNIQUE (source, content_key)
);

-- One row per collector run, for freshness lines and health alerts.
CREATE TABLE IF NOT EXISTS market.runs (
  id           BIGSERIAL PRIMARY KEY,
  source       TEXT NOT NULL,
  started_at   TIMESTAMPTZ NOT NULL,
  finished_at  TIMESTAMPTZ NOT NULL,
  window_since TIMESTAMPTZ,
  window_until TIMESTAMPTZ,
  fetched      INTEGER NOT NULL DEFAULT 0,
  inserted     INTEGER NOT NULL DEFAULT 0,
  updated      INTEGER NOT NULL DEFAULT 0,
  rejected     INTEGER NOT NULL DEFAULT 0,
  captures     INTEGER NOT NULL DEFAULT 0,
  complete     BOOLEAN NOT NULL,
  notes        JSONB NOT NULL DEFAULT '[]',
  error        TEXT
);
CREATE INDEX IF NOT EXISTS market_runs_source_finished_idx ON market.runs (source, finished_at);

-- Federal contract awards performed in a tracked state (USAspending). amount_type says what the amount measures;
-- figures are only summed within one type.
CREATE TABLE IF NOT EXISTS market.federal_awards (
  award_key          TEXT PRIMARY KEY,
  award_id           TEXT NOT NULL,
  recipient_name     TEXT NOT NULL,
  recipient_uei      TEXT,
  amount             NUMERIC,
  amount_type        TEXT NOT NULL,
  start_date         DATE,
  end_date           DATE,
  awarding_agency    TEXT,
  awarding_sub_agency TEXT,
  award_type         TEXT,
  naics              TEXT,
  naics_description  TEXT,
  psc                TEXT,
  psc_description    TEXT,
  pop_state          TEXT,
  description        TEXT,
  last_modified      TIMESTAMPTZ,
  source_url         TEXT NOT NULL,
  content_hash       TEXT NOT NULL,
  capture_id         BIGINT REFERENCES market.captures (id),
  first_seen_at      TIMESTAMPTZ NOT NULL,
  updated_at         TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS market_federal_awards_state_naics_idx ON market.federal_awards (pop_state, naics);
CREATE INDEX IF NOT EXISTS market_federal_awards_end_idx ON market.federal_awards (end_date);
CREATE INDEX IF NOT EXISTS market_federal_awards_uei_idx ON market.federal_awards (recipient_uei);

-- FEMA Public Assistance projects: disaster spending by applicant and county (no contractor names).
CREATE TABLE IF NOT EXISTS market.pa_projects (
  project_key             TEXT PRIMARY KEY,
  disaster_number         INTEGER NOT NULL,
  pw_number               INTEGER NOT NULL,
  applicant_id            TEXT NOT NULL,
  state                   TEXT NOT NULL,
  county                  TEXT,
  county_code             TEXT,
  damage_category         TEXT NOT NULL,
  damage_category_name    TEXT,
  title                   TEXT,
  status                  TEXT,
  process_step            TEXT,
  project_amount          NUMERIC,
  federal_share_obligated NUMERIC,
  total_obligated         NUMERIC,
  first_obligation_date   TIMESTAMPTZ,
  last_obligation_date    TIMESTAMPTZ,
  declaration_date        TIMESTAMPTZ,
  incident_type           TEXT,
  last_refresh            TIMESTAMPTZ,
  source_url              TEXT NOT NULL,
  content_hash            TEXT NOT NULL,
  capture_id              BIGINT REFERENCES market.captures (id),
  first_seen_at           TIMESTAMPTZ NOT NULL,
  updated_at              TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS market_pa_projects_state_cat_idx ON market.pa_projects (state, damage_category);
CREATE INDEX IF NOT EXISTS market_pa_projects_applicant_idx ON market.pa_projects (disaster_number, applicant_id);

CREATE TABLE IF NOT EXISTS market.pa_applicants (
  applicant_key   TEXT PRIMARY KEY,
  disaster_number INTEGER NOT NULL,
  applicant_id    TEXT NOT NULL,
  name            TEXT NOT NULL,
  state           TEXT,
  city            TEXT,
  last_refresh    TIMESTAMPTZ,
  content_hash    TEXT NOT NULL,
  first_seen_at   TIMESTAMPTZ NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL
);
