# Acquisition and diligence readiness

What a buyer's technical and legal review will ask about Radar, and where the answer lives. Items marked
**Owner: Ben** are business or legal actions that code cannot close.

## Ownership and legal

| Item                                                                                                     | Status                                                                                                          |
| -------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| IP assignment from every contributor (founder, dev team, contractors, AI-assisted work directed by them) | **Owner: Ben.** Signed invention-assignment agreements assigning to the RFP Pilot entity. Highest-priority item |
| License                                                                                                  | Proprietary, `LICENSE`                                                                                          |
| Third-party licenses                                                                                     | All dependencies are MIT/Apache-2.0/ISC/BSD. Generate the list with `pnpm licenses list` per release            |
| Data collection basis                                                                                    | `docs/SOURCES.md`, per source, with open items before commercial use                                            |
| Terms of use reviews (TxSmartBuy, MFMP)                                                                  | **Owner: Ben**, open                                                                                            |
| Customer data                                                                                            | Firm profiles and decisions only; no personal data beyond public buyer contacts                                 |

## Engineering

| Item                              | Where                                                                                                                                     |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Architecture and design decisions | `docs/ARCHITECTURE.md`, `docs/adr/`                                                                                                       |
| Tests                             | `pnpm test`: unit, connector contract tests on live-captured fixtures, repository tests running real SQL (PGlite), API and MCP end-to-end |
| CI                                | `.github/workflows/ci.yml`: typecheck, format, tests on every push and PR                                                                 |
| Reproducible build                | `pnpm-lock.yaml`, `Dockerfile`, `docker-compose.yml`, Node version pinned in `.nvmrc`                                                     |
| Migrations                        | `packages/store/migrations/`, applied idempotently at startup                                                                             |
| Security model                    | `SECURITY.md`                                                                                                                             |
| Operational visibility            | JSON event logs; `ingest_runs` table per source                                                                                           |
| Integration contract              | `docs/RFP_PILOT_INTEGRATION.md`, versioned handoff schema                                                                                 |
| Scoring explainability            | Every point attached to a reason; scorer version stored with each match                                                                   |

## Commercial metrics to start tracking now

Opportunities ingested per source per day; matches per tenant per week; share of matches pursued; proposals
started from Radar handoffs; wins attributed to Radar. These are the numbers that turn Radar from a feature into
a valuation driver.
