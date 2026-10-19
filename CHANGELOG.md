# Changelog

## 0.4.2 (2026-10-19)

- Federal fit bar: SAM.gov notices appear in the email only at fit 45 or above (`RADAR_FEDERAL_MIN_SCORE`); below it they count as screened out. Broad consulting codes matched Defense and NASA work that does not fit a state and local firm.
- Federal agency names are shown in title case with acronyms kept and repeated offices dropped ("Dept of Defense / Dept of the Navy").

- SAM.gov fixed: dates are sent with literal slashes ("10/16/2026"). URLSearchParams encoded them as %2F, and SAM answered every query with 404 "no data". Confirmed by the same request with literal slashes returning 1,210 records.

- New email section, "Strong matches still open": strong-fit bids from earlier emails that are still open and not closing this week, best fit first (up to 10). "Today in brief" may name the best one when nothing new is strong.
- SAM.gov diagnostics: when every query answers "no data", the run makes one minimal unfiltered request against the documented endpoint and the older "/prod" path and logs the status and record count (`sam_probe`), without the key.

- Change alerts: a key date is reported only when the posting's text changed and the date is still ahead. A parser upgrade re-reading the same text, or a date already past, is no longer news (first live run flagged a past "questions due" date on an unchanged Florida posting).
- ISF profile display name is now "ISF, Inc." (the scoring was reviewed and tuned with ISF).

## 0.4.1 (2026-10-18)

- **Estimated contract value** on every card that states one: Texas from the agency's estimate field
  ("Est. $59.5K"); Florida (which has no value field) and Texas postings without one from the posting's own
  words, read conservatively and marked "≈". Bonds, insurance, fees and hourly rates are never read as values.
  Parser versions are now part of the content hash, so the next run re-reads and stores every record once.
- **SAM.gov:** stopped sending four repeated `ptype` values in one query (only one is documented, and the
  combination can match nothing); all notice types now come back and the scorer's lanes sort them. A
  `sam_no_data` log line records any query SAM answers with "No Data found" (never the key).
- ISF profile tuned from Monica's feedback: project management at full weight; program management, PMO and
  consulting services added; the short-deadline penalty applies under 7 days.

## 0.4.0 (2026-10-17)

- **Today in brief.** Two or three plain sentences at the top of the email, written by Claude from the digest's
  own facts only (changed deadlines and mandatory meetings first, then the strongest new match, then what closes
  soon). Any summary containing a number not found in the digest is dropped, and the email goes out without it.
  `RADAR_SUMMARY_MODEL` (default `claude-sonnet-5-5`) and `RADAR_SUMMARY=off` control it.
- **Change alerts.** The digest opens with "Changed since last email": tracked bids (strong or possible matches, or
  ones marked pursue/watch) whose deadline moved, that got an addendum or new documents, a new or moved key date,
  or that were cancelled or pulled before their deadline. Changes are computed from stored version history, and
  detail Radar only just started reading is never reported as a change. Closes by absence are now recorded as
  versions.
- **Key dates.** Pre-bid conferences, site visits, question deadlines and bid openings are read from each
  posting's own text (conservatively: a date is shown only when the same sentence states it) and shown as chips on
  every card, mandatory events in red. Florida also flags its pre-solicitation-conference indicator.
- **Texas detail.** The Texas connector reads each new or changed posting's detail (description, contact,
  attachments with original file names), which also gives the scorer and the AI reviewer real text for Texas.
  `RADAR_TX_MAX_DETAILS` caps detail requests per run (default 600).
- Fixes: the AI reviewer's rationale is clipped at a clause boundary instead of mid-word; "points short of Strong"
  is computed from the displayed score.

## 0.3.1 (2026-10-17)

- Digest email opens with an "At a glance" panel: open solicitations read (by source), green/amber/red tiles for
  strong, possible and screened out, a proportion bar, new and closing counts, the top match and the next deadline.
- Score pills and card edges are colored by fit band (green strong, amber possible), and every card explains its
  score: a headline ("Strong fit, 74 of 100"), how far it sits from Strong, and the signed points behind it, largest
  first, with the AI reviewer's one-sentence rationale in plain words.
- `RADAR_DIGEST_REPLAY_UNTIL`: an ISO time before which digests re-send the full current list, for previewing a
  template change; it expires on its own.
- SAM.gov 404 (documented as "No Data found", often with an empty body) is treated as an empty result; HTTP error bodies are logged; the Claude reviewer has
  more output headroom and reports what it got back when it cannot parse a verdict.

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
