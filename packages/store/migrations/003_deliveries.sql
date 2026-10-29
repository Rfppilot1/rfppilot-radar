-- One row per digest email actually accepted by the mail provider, per recipient. A recipient's next digest
-- covers everything since their own last delivery, so a failed send to one person never makes the others get
-- the same items twice, and the failed recipient still gets them the next day. A failed send writes a row at
-- the start of that recipient's window with no message_id, pinning the window until a send succeeds.
CREATE TABLE IF NOT EXISTS digest_deliveries (
  tenant_id    TEXT NOT NULL,
  profile_id   TEXT NOT NULL,
  recipient    TEXT NOT NULL,
  generated_at TIMESTAMPTZ NOT NULL,
  message_id   TEXT,
  PRIMARY KEY (tenant_id, profile_id, recipient, generated_at),
  FOREIGN KEY (tenant_id, profile_id) REFERENCES profiles (tenant_id, id) ON DELETE CASCADE
);

-- Health checks look up the latest runs per source.
CREATE INDEX IF NOT EXISTS ingest_runs_source_finished_idx ON ingest_runs (source, finished_at);
