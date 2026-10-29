# Radar web (staging prototype)

The Radar website: an **Opportunities** list with Florida / Texas / Federal / All tabs and filters, and a
**Market** view with a county map, a 30-day closing timeline, top buyers, the screened-to-strong funnel and
open dollar value with how many bids state one.

## How it works

- Next.js App Router. Every page renders on the server and calls the Radar API with a key held only in the
  server's environment. The browser never sees the key; Yes/No answers go through a server action.
- The whole view is in the URL (`?tab=fl&fit=strong&due=14&county=12095`), so any filtered view can be
  bookmarked or sent to a colleague.
- County placement (`lib/counties.ts`) reads the buyer name: state agencies are statewide, "<Name> County",
  "School District of <Name>" and similar map to that county, and listed cities, universities and utilities map
  to the county they sit in. Anything else is reported as "could not place", never guessed.
- County shapes are the Census Bureau's cartographic boundaries (public domain) via `us-atlas`, drawn to SVG on
  the server.

## Environment

| Variable           | Purpose                                                                        |
| ------------------ | ------------------------------------------------------------------------------ |
| `RADAR_API_URL`    | Radar API base URL                                                             |
| `RADAR_API_KEY`    | API key for the tenant (server-side only)                                      |
| `RADAR_PROFILE_ID` | Profile to show, e.g. `isf-main`                                               |
| `WEB_PASSWORD`     | Staging gate (HTTP Basic, any user name). Production replaces this with WorkOS |
| `RADAR_TIME_ZONE`  | Display time zone, default `America/New_York`                                  |
| `RADAR_NOW`        | Pins the clock for demos and screenshots only. Never set in staging or prod    |

## Run locally against synthetic data

```sh
pnpm --filter @radar/api demo        # API on :8090 with synthetic records (ids start "demo:")
RADAR_API_URL=http://127.0.0.1:8090 RADAR_API_KEY=demo-key-0123456789abcdef RADAR_PROFILE_ID=isf-main \
  RADAR_NOW=2026-10-20T14:00:00.000Z pnpm --filter @radar/web dev   # http://localhost:3100
```

## Deploy (Railway)

Service built from `apps/web/Dockerfile` at the repository root. See `docs/DEPLOY_RAILWAY.md`.

## Not in this prototype

Accounts and paid plans (Phase 2: WorkOS, Stripe), "Send to RFP Pilot" (D0), and saved searches.
