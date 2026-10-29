# Architecture

## Goals

1. **Coverage, not volume.** Surface every opportunity a firm could credibly bid, explain why, and make it hard
   for one reviewer's view to filter good work out silently.
2. **Integrate anywhere.** One API powers RFP Pilot's backend, an MCP server for a customer's Claude, and an
   embeddable view. Any of the three can ship without changing the others.
3. **Survive diligence.** Clear data provenance, tenant isolation, tests that run real SQL, reproducible builds,
   and decisions written down.

## Components

```
apps/worker ──► packages/connectors ──► packages/core (normalize to Opportunity)
     │                                         │
     └──────────► packages/store ◄─────────────┘  Postgres: opportunities (+versions), profiles,
                        ▲                          matches, decisions, ingest_runs
                        │
apps/api (Fastify, OpenAPI, API keys) ◄── apps/mcp (MCP tools over the API)
                        ▲
packages/embed (<rfp-radar-matches>, calls the host's proxy, never holds a key)
```

### Data model

- **Opportunity**: one public notice, normalized, with the source's own identifiers and labels preserved
  verbatim. `provenance` records the public URL, fetch time, SHA-256 of the raw record and collection basis.
  Every content change is appended to `opportunity_versions` (including a revert to an earlier state). After a
  complete run of a source, open records that source no longer lists are closed, so matches stop showing them.
- **FirmProfile**: a tenant's targeting: states, classification-code prefixes (NAICS, PSC, UNSPSC, NIGP) with
  weights, capability phrases, exclusions, known buyers, minimum response time.
- **Match**: the score for one (profile, opportunity) pair: band, lane (bid or intel), the list of reasons
  whose points sum to the score, scorer version, and any semantic review. `first_good_at` records when it
  first reached strong or possible, which drives "new" in the digest. API and digest reads only return
  matches whose opportunity is still open and not past due.
- **Decision**: pursue / pass / watch, with reason and the opportunity's content hash at decision time.

### Scoring

Deterministic and explainable (`packages/core/src/scoring.ts`). Points come only from stated facts: matching
codes, capability phrases (title weighted higher), known buyer, notice type; minus exclusions and tight timing.
Geography, status and deadline are hard gates. With no code or capability signal, the score is zero, so kind
and buyer points alone cannot surface an irrelevant notice.

Optional semantic review (`review-ai.ts`): for in-scope, non-excluded matches below "strong", a reviewer model
returns fit / maybe / no with a one-sentence rationale. It adds a labeled reason (+30 / +15 / 0), never removes
rule reasons, never reviews excluded or out-of-geography items, and is reused until the opportunity or the
profile's capabilities/exclusions change.
The rules remain the floor; the reviewer can only widen coverage.

### Coverage safeguards

- **Intel lane**: award decisions, pre-solicitations and sources-sought notices are kept and scored separately,
  so a firm sees who is winning what in its market.
- **Second look**: items the firm passed on that were rated strong or possible, passed items that changed since
  the decision (new version or addendum), and undecided near misses within 5 points of the cutoff.
- **Digest window**: "new" means since the last delivered digest for that profile (stored in `digest_runs`), so
  a late or skipped run loses nothing and a second run the same day repeats nothing.

### Tenancy and security

Opportunities are public and shared. Everything a tenant creates is keyed to the tenant; every profile-scoped
query checks ownership, and cross-tenant reads return 404. See `SECURITY.md`.

## Running in production

- **Scheduler**: `radar daily` once per weekday morning (container job or cron), plus
  `radar ingest --sources tx-esbd` at midday if same-day freshness matters.
- **Database**: managed Postgres 16. Migrations run at API and worker startup and are idempotent.
- **Observability**: after each run the worker emails the operator (`RADAR_ALERT_EMAIL`) a list of failed,
  empty, refused, time-limited, unreadable or stale sources and failed profiles; `/healthz` checks the database.
  The worker also writes one JSON log line per event; `ingest_runs` holds per-source counts and
  errors for alerting (alert when a source returns zero records or errors twice in a row).
- **Secrets**: `RADAR_API_KEYS`, `SAM_API_KEY`, `ANTHROPIC_API_KEY` come from the platform's secret store.
