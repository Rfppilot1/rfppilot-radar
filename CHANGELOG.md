# Changelog

## 0.3.0 (2026-10-17)

- Per-profile scoring: a profile's optional `scoring` block overrides point values (`weights`), band cutoffs
  (`bands`) and notice-type points (`kindPoints`); anything omitted uses the defaults. Second look and the Claude
  reviewer use the profile's cutoffs.
- Florida: the live `timeRemaining` countdown and per-viewer flags no longer count as content changes (they made
  every record look updated on every run).
- Worker: digest file writes can no longer stop a run or the email; the container has a writable `/app/data`;
  Florida progress lines, synchronous logging and signal traces.
- Worker skips SAM.gov with a log line when no key is set, instead of failing the run.
- Container build reinstalls production dependencies (fixes missing workspace links); Railway is configured in
  the dashboard (see `docs/DEPLOY_RAILWAY.md`).

## 0.2.1 (2026-10-16)

- Digest recipients come from `RADAR_RECIPIENTS` (operator-set, outside the repository) and override stored
  recipients for the profiles listed. The Railway worker reloads the profile file on every run, so no shell
  session is needed to deploy a profile change.

## 0.2.0 (2026-10-15)

- Florida: direct public JSON endpoints replace the headless browser (no Chromium needed). Each biddable ad is
  enriched with UNSPSC codes, description, contact and original document names; ads with a posted Intent to
  Award leave the bid lane.
- Daily email digest through Resend (HTML and text), sent to each profile's `delivery.email` list; a failed send
  is not recorded as delivered.
- FEMA Public Assistance declarations appear in the digest as demand signals.
- Railway deployment config and guide; Claude Code review workflow for pull requests.
- Review fixes: a failed Florida detail never overwrites the stored record; Florida runs with unparsed rows are
  not complete; award detection ignores boilerplate and documents posted with the solicitation; email
  recipients are operator-only with a List-Unsubscribe header; FEMA lookups are shared across profiles.

## 0.1.0 (2026-10-15)

First working version. Hardened after an independent review before first release: authenticated route plugin,
tenant-scoped keys, closing records only after complete non-empty runs with a 20% safety limit (and reopening
records that reappear), first-good timestamps, digest windows from the last delivered digest, review cache keyed
to the profile, timeouts on every outbound call, strict date parsing.

- Canonical opportunity schema with provenance; NAICS, PSC, UNSPSC and NIGP code support.
- Connectors: Texas ESBD, Florida MFMP VIP (headless transport), SAM.gov API, OpenFEMA signal.
- Explainable scoring, intel lane, second-look review, text and Markdown digests.
- Optional Claude relevance review for rule misses.
- Postgres and in-memory repositories with tenant isolation; SQL migrations.
- REST API with OpenAPI 3.1 and tenant API keys; MCP server; embeddable web component.
- RFP Pilot handoff contract v1.0.
