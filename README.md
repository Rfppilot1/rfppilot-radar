# RFP Pilot Radar

Radar finds public-sector opportunities, scores them against a firm's profile with a reason for every point, and
hands the good ones to RFP Pilot. It is built as a standalone service with one API, so RFP Pilot can call it,
embed it, or reach it through MCP without a rewrite.

```
 Sources                 Radar service                                  Consumers
 ───────                 ─────────────                                  ─────────
 SAM.gov (API)    ┐      connectors ─► normalize ─► store (Postgres)     REST API + OpenAPI ─► RFP Pilot backend
 Texas ESBD       ├────► provenance: URL, time, hash, collection basis   MCP server ─────────► customer's Claude
 Florida MFMP VIP │      scoring (rules + optional Claude review)        <rfp-radar-matches> ► embedded in RFP Pilot
 OpenFEMA signal  ┘      decisions, second look, digest                  digest (email / SMS text)
```

## What it does today

| Capability                                                                            | Status                                                                                                                                                                 |
| ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Texas ESBD connector (public JSON service behind the search page)                     | Built. Parser pinned to a record captured live on Oct 15, 2026. A manual live pull that day (473 open postings) normalized with no rejects; that data is not committed |
| Florida MFMP VIP connector (public JSON endpoints behind the search and detail pages) | Built. List and detail parsers pinned to records captured live on Oct 15, 2026; a manual live pull that day (179 ads, 134 details) normalized with no rejects          |
| SAM.gov connector (official API, free key)                                            | Built against the documented API, tested on synthetic records; needs a key to run live                                                                                 |
| OpenFEMA disaster-declaration signal                                                  | Built; Public Assistance declarations appear in the daily digest as demand signals                                                                                     |
| Explainable scoring, intel lane, second-look review, digest                           | Built, tested                                                                                                                                                          |
| Optional Claude relevance review for rule misses                                      | Built, tested with a stub; enable with `ANTHROPIC_API_KEY`                                                                                                             |
| REST API with tenant API keys and OpenAPI 3.1                                         | Built, tested                                                                                                                                                          |
| MCP server (6 tools)                                                                  | Built, tested end to end in-process                                                                                                                                    |
| Embeddable web component                                                              | Built (no key in the browser by design)                                                                                                                                |
| Daily email digest (Resend), plus text and Markdown files                             | Built, tested with a stub; enable with `RESEND_API_KEY`                                                                                                                |
| Railway deployment (API + cron worker + Postgres)                                     | Config and guide in `docs/DEPLOY_RAILWAY.md`                                                                                                                           |
| "Send to RFP Pilot" handoff contract v1.0                                             | Built, documented in `docs/RFP_PILOT_INTEGRATION.md`                                                                                                                   |

## Quick start

```bash
pnpm install
pnpm check                            # typecheck + format check + tests (PGlite runs real SQL, no server needed)

# Local demo with an in-memory store and the sample ISF profile:
RADAR_ALLOW_MEMORY=1 pnpm --filter @radar/worker radar daily \
  --profiles profiles/isf.example.json --sources tx-esbd --out-dir data/digests

# Real deployment:
docker compose up -d db               # Postgres 16
cp .env.example .env                  # fill DATABASE_URL, RADAR_API_KEYS, SAM_API_KEY
pnpm --filter @radar/worker radar profile load profiles/isf.example.json
pnpm --filter @radar/worker radar daily
pnpm --filter @radar/api dev          # http://localhost:8080/openapi.json
```

## Repository layout

| Path                  | Purpose                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------- |
| `packages/core`       | Canonical schemas (zod), scoring, second look, digest, semantic review, RFP Pilot handoff   |
| `packages/connectors` | One connector per source, polite HTTP client, provenance hashing                            |
| `packages/store`      | Repository interface, Postgres and in-memory implementations, SQL migrations, pipeline      |
| `packages/embed`      | `<rfp-radar-matches>` web component                                                         |
| `apps/api`            | Fastify REST API, API-key auth, OpenAPI                                                     |
| `apps/mcp`            | MCP server for a customer's Claude                                                          |
| `apps/worker`         | CLI and scheduled jobs (`radar daily`)                                                      |
| `profiles/`           | Example firm profiles                                                                       |
| `docs/`               | Architecture, sources and their basis, integration contract, decisions, diligence checklist |

## Documentation

- [Architecture](docs/ARCHITECTURE.md)
- [Sources and collection basis](docs/SOURCES.md): read before adding or running a connector
- [RFP Pilot integration](docs/RFP_PILOT_INTEGRATION.md)
- [Security](SECURITY.md)
- [Acquisition and diligence readiness](docs/DILIGENCE.md)
- [Deploying on Railway](docs/DEPLOY_RAILWAY.md)
- [Decision records](docs/adr/)

Proprietary. Copyright © 2026 RFP Pilot. All rights reserved. See [LICENSE](LICENSE).
