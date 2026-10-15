# Deploying on Railway

Three pieces in one Railway project: Postgres, the API service, and the worker as a cron service. All three
build from this repository.

## 1. Create the project

1. railway.com → New Project → Deploy from GitHub repo → `Rfppilot1/rfppilot-radar`. This creates the **api**
   service using `railway.json` (Dockerfile build, `/healthz` health check).
2. In the project: New → Database → **PostgreSQL**.
3. New → GitHub Repo → the same repository again. Rename it **worker**. In its Settings:
   - Custom Start Command: `node apps/worker/dist/cli.js daily`
   - Cron Schedule: `45 10 * * 1-5` (6:45 AM Eastern on weekdays during daylight time; Railway cron is UTC)
   - Remove the health check (a cron job exits when done).

## 2. Variables

Set on **both** services (Railway → service → Variables). Use Railway's reference syntax for the database so the
password never appears in this repo.

| Variable                  | api | worker | Value                                                                                              |
| ------------------------- | --- | ------ | -------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`            | ✓   | ✓      | `${{Postgres.DATABASE_URL}}`                                                                       |
| `RADAR_API_KEYS`          | ✓   |        | `isf:<long random key>` (generate with `openssl rand -hex 24`)                                     |
| `SAM_API_KEY`             |     | ✓      | SAM.gov → Account Details → Public API Key                                                         |
| `ANTHROPIC_API_KEY`       |     | ✓      | console.anthropic.com → API Keys (enables the Claude reviewer)                                     |
| `RADAR_MAX_REVIEWS`       |     | ✓      | `50` (cap on reviewer calls per run)                                                               |
| `RESEND_API_KEY`          |     | ✓      | resend.com → API Keys                                                                              |
| `RADAR_EMAIL_FROM`        |     | ✓      | `Radar <radar@rfppilot.com>` (domain verified in Resend)                                           |
| `RADAR_UNSUBSCRIBE_EMAIL` |     | ✓      | A mailbox you read, e.g. `radar-unsubscribe@rfppilot.com` (honor requests within 10 business days) |
| `RADAR_SAM_STATES`        |     | ✓      | `FL,TX`                                                                                            |
| `RADAR_USER_AGENT`        |     | ✓      | `RFPPilotRadar/0.1 (+https://rfppilot.com; ben@rfppilot.com)`                                      |

Never paste these values into chat, email, issues or code.

## 3. Load ISF's profile (once, then whenever it changes)

Edit `profiles/isf.example.json` (set `delivery.email` to Monica's address once she agrees), then run from a
Railway shell on the worker service: `node apps/worker/dist/cli.js profile load profiles/isf.example.json`.
Recipients can only be set this way; the tenant API cannot change them. Tenants may update targeting (codes,
phrases, states) through `PUT /v1/profiles/isf-main`, which keeps the operator-set recipients.

## 4. Check it

- `https://<api-domain>/healthz` returns `{"ok":true}`.
- The worker's first run logs one JSON line per source (`ingest`), then `score`, then `digest` with
  `emailed: true`.
- Alert on: a source with `fetched: 0`, any `ingest_failed`, `close refused`, or `email_failed`.

## Costs at this size

Hobby plan plus usage: roughly $5–20/month for the API, a daily cron and a small Postgres. Claude reviewer:
up to 50 short calls per day. Resend: free tier covers a few hundred emails a month.
