-- Competition and term details for federal awards (USAspending award page data). detail_for_hash records which
-- version of the search row the details were read for, so changed awards are re-read and unchanged ones are not.
ALTER TABLE market.federal_awards
  ADD COLUMN IF NOT EXISTS solicitation_id TEXT,
  ADD COLUMN IF NOT EXISTS offers_received INTEGER,
  ADD COLUMN IF NOT EXISTS extent_competed TEXT,
  ADD COLUMN IF NOT EXISTS extent_competed_name TEXT,
  ADD COLUMN IF NOT EXISTS set_aside TEXT,
  ADD COLUMN IF NOT EXISTS set_aside_name TEXT,
  ADD COLUMN IF NOT EXISTS pricing_type TEXT,
  ADD COLUMN IF NOT EXISTS base_and_all_options NUMERIC,
  ADD COLUMN IF NOT EXISTS total_obligation NUMERIC,
  ADD COLUMN IF NOT EXISTS potential_end_date DATE,
  ADD COLUMN IF NOT EXISTS parent_award_key TEXT,
  ADD COLUMN IF NOT EXISTS detail_hash TEXT,
  ADD COLUMN IF NOT EXISTS detail_for_hash TEXT,
  ADD COLUMN IF NOT EXISTS detail_capture_id BIGINT REFERENCES market.captures (id),
  ADD COLUMN IF NOT EXISTS detail_fetched_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS market_federal_awards_detail_idx
  ON market.federal_awards (updated_at) WHERE detail_for_hash IS DISTINCT FROM content_hash;
