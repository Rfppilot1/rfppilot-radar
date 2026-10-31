-- Where a run stopped inside its window (request budget or rate limit), so the next run resumes there.
ALTER TABLE market.runs ADD COLUMN IF NOT EXISTS cursor JSONB;

-- SAM.gov contract actions (awards and modifications), transaction-level.
CREATE TABLE IF NOT EXISTS market.federal_actions (
  action_key               TEXT PRIMARY KEY,
  piid                     TEXT NOT NULL,
  modification_number      TEXT,
  referenced_idv_piid      TEXT,
  contracting_department   TEXT,
  contracting_office       TEXT,
  awardee_name             TEXT,
  awardee_uei              TEXT,
  naics                    TEXT,
  psc                      TEXT,
  pop_state                TEXT,
  action_obligation        NUMERIC,
  total_obligation         NUMERIC,
  base_and_all_options     NUMERIC,
  date_signed              DATE,
  current_completion_date  DATE,
  ultimate_completion_date DATE,
  offers_received          INTEGER,
  extent_competed          TEXT,
  extent_competed_name     TEXT,
  solicitation_id          TEXT,
  content_hash             TEXT NOT NULL,
  capture_id               BIGINT REFERENCES market.captures (id),
  first_seen_at            TIMESTAMPTZ NOT NULL,
  updated_at               TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS market_federal_actions_piid_idx ON market.federal_actions (piid);
CREATE INDEX IF NOT EXISTS market_federal_actions_uei_idx ON market.federal_actions (awardee_uei);
