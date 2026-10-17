-- Digest change alerts look up versions recorded since the last digest.
CREATE INDEX IF NOT EXISTS opportunity_versions_seen_idx ON opportunity_versions (seen_at);
