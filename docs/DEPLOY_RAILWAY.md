# Deploying on Railway

Three pieces in one Railway project: Postgres, the API service, and the worker as a cron service. All three
build from this repository.

## 1. Create the project

Railway no longer accepts config files for new services, so each service is configured in its Settings.

1. railway.com → New Project → GitHub Repository → `Rfppilot1/rfppilot-radar`. Railway proposes one service per
   app; keep **@radar/api** and **@radar/worker** and discard **@radar/mcp** (the MCP server runs on the
   customer's machine).
2. Add → Database → **PostgreSQL**.
3. Both services, Settings → Build: **Builder: Dockerfile** (`/Dockerfile`), no custom build command, no watch
   paths (a change in any package must redeploy both).
4. **@radar/api**, Settings → Deploy: start command `node apps/api/dist/server.js`, healthcheck path `/healthz`.
   Networking → Generate Domain.
5. **@radar/worker**, Settings → Deploy: start command
   `node apps/worker/dist/cli.js daily --profiles profiles/isf.example.json`, restart policy **Never**, cron
   schedule `45 10 * * 1-5` (6:45 AM Eastern in daylight time, 5:45 AM in standard time; Railway cron is UTC).
   For a first test, deploy before adding the schedule: the worker then runs once immediately. The worker
   reloads the profile from the repository on every run, so a profile change ships with a commit.

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
| `RADAR_RECIPIENTS`        |     | ✓      | `isf/isf-main=ben@rfppilot.com` at first; add Monica's address after the first clean digests       |
| `RADAR_SAM_STATES`        |     | ✓      | `FL,TX`                                                                                            |
| `RADAR_USER_AGENT`        |     | ✓      | `RFPPilotRadar/0.1 (+https://rfppilot.com; ben@rfppilot.com)`                                      |

Never paste these values into chat, email, issues or code.

## 3. Profile and recipients

The worker loads `profiles/isf.example.json` on every run (start command above). Recipients come only from
`RADAR_RECIPIENTS`, never from the repository, so addresses stay out of git and the tenant API cannot change them.
Start with the operator's address only; add the customer's after two or three clean digests. The first digest
for a profile lists everything currently open, so expect a long first email.

While the profile is loaded from the file each run, edits made through `PUT /v1/profiles/isf-main` are
overwritten the next morning. Change targeting in the file instead until tenants manage their own profiles.

## 4. Check it

- `https://<api-domain>/healthz` returns `{"ok":true}`.
- The worker's first run logs one JSON line per source (`ingest`), then `score`, then `digest` with
  `emailed: true`.
- Alert on: a source with `fetched: 0`, any `ingest_failed`, `close refused`, or `email_failed`.

## Costs at this size

Hobby plan plus usage: roughly $5–20/month for the API, a daily cron and a small Postgres. Claude reviewer:
up to 50 short calls per day. Resend: free tier covers a few hundred emails a month.
