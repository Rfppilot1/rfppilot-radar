-- State agency contracts, grant agreements and purchase orders (Florida FACTS first).
CREATE TABLE IF NOT EXISTS market.state_contracts (
  contract_key           TEXT PRIMARY KEY,
  state                  TEXT NOT NULL,
  agency                 TEXT NOT NULL,
  vendor                 TEXT,
  type                   TEXT,
  contract_id            TEXT,
  po_number              TEXT,
  grant_award_id         TEXT,
  flair_contract_id      TEXT,
  title                  TEXT,
  short_title            TEXT,
  status                 TEXT,
  original_amount        NUMERIC,
  total_amount           NUMERIC,
  amount_type            TEXT NOT NULL,
  commodity_code         TEXT,
  commodity_description  TEXT,
  procurement_method     TEXT,
  state_term_contract_id TEXT,
  agency_reference       TEXT,
  service_area           TEXT,
  recipient_type         TEXT,
  begin_date             DATE,
  original_end_date      DATE,
  new_end_date           DATE,
  executed_date          DATE,
  cfda                   TEXT,
  csfa                   TEXT,
  source_url             TEXT NOT NULL,
  content_hash           TEXT NOT NULL,
  capture_id             BIGINT REFERENCES market.captures (id),
  first_seen_at          TIMESTAMPTZ NOT NULL,
  updated_at             TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS market_state_contracts_vendor_idx ON market.state_contracts (state, vendor);
CREATE INDEX IF NOT EXISTS market_state_contracts_agency_idx ON market.state_contracts (state, agency);
CREATE INDEX IF NOT EXISTS market_state_contracts_end_idx
  ON market.state_contracts (COALESCE(new_end_date, original_end_date));
