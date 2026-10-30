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

| Variable                    | api | worker | Value                                                                                                                  |
| --------------------------- | --- | ------ | ---------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`              | ✓   | ✓      | `${{Postgres.DATABASE_URL}}`                                                                                           |
| `RADAR_API_KEYS`            | ✓   |        | `isf:<long random key>` (generate with `openssl rand -hex 24`)                                                         |
| `SAM_API_KEY`               |     | ✓      | SAM.gov → Account Details → Public API Key                                                                             |
| `ANTHROPIC_API_KEY`         |     | ✓      | console.anthropic.com → API Keys (enables the Claude reviewer)                                                         |
| `RADAR_MAX_REVIEWS`         |     | ✓      | `50` (cap on reviewer calls per run)                                                                                   |
| `RESEND_API_KEY`            |     | ✓      | resend.com → API Keys                                                                                                  |
| `RADAR_EMAIL_FROM`          |     | ✓      | `Radar <radar@rfppilot.com>` (domain verified in Resend)                                                               |
| `RADAR_UNSUBSCRIBE_EMAIL`   |     | ✓      | A mailbox you read, e.g. `radar-unsubscribe@rfppilot.com` (honor requests within 10 business days)                     |
| `RADAR_RECIPIENTS`          |     | ✓      | `isf/isf-main=ben@rfppilot.com` at first; add Monica's address after the first clean digests                           |
| `RADAR_FEDERAL_MIN_SCORE`   |     | ✓      | Federal (SAM.gov) notices reach the email only at this fit or above; default `45`                                      |
| `RADAR_DIGEST_REPLAY_UNTIL` |     | ✓      | Optional. An ISO time; runs before it re-send the full current list (to preview a template change). Expires on its own |
| `RADAR_TX_MAX_DETAILS`      |     | ✓      | Optional. Cap on Texas detail requests per run (default 600); unchanged postings are never re-fetched                  |
| `RADAR_SAM_STATES`          |     | ✓      | `FL,TX`                                                                                                                |
| `RADAR_ALERT_EMAIL`         |     | ✓      | Operator address for the after-run problem list, e.g. `ben@rfppilot.com`                                               |
| `RADAR_SOURCE_DEADLINE_MIN` |     | ✓      | Optional. Minutes one source may run before it is stopped (default 45); what it fetched is kept                        |
| `RADAR_USER_AGENT`          |     | ✓      | `RFPPilotRadar/0.1 (+https://rfppilot.com; ben@rfppilot.com)`                                                          |

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
- Set `RADAR_ALERT_EMAIL` on the worker: after every run it emails that address a list of anything that went
  wrong (a failed, empty, refused, time-limited or stale source; a profile not scored or not emailed). The run
  also exits non-zero when a customer's email failed, so Railway marks it failed.

## Costs at this size

Hobby plan plus usage: roughly $5–20/month for the API, a daily cron and a small Postgres. Claude reviewer:
up to 50 short calls per day. Resend: free tier covers a few hundred emails a month.

## Web prototype (staging only)

A third service, `radar-web`, runs the website in `apps/web`.

1. New service from the repo, branch `staging`, Dockerfile path `apps/web/Dockerfile`, health check `/` is not
   used (the page needs the password); leave it off or point it at the default.
2. Variables: `RADAR_API_URL` (the staging API's URL), `RADAR_API_KEY`, `RADAR_PROFILE_ID=isf-main`,
   `WEB_PASSWORD`. On the staging API, add the same key to `RADAR_API_KEYS` as `isf:<key>`.
3. Generate a public domain. Share the URL and password only with people testing.

## Staging daily run (operator email only)

The staging worker runs on its own schedule, `15 11 * * 1-5` (7:15 AM Eastern in daylight time), 30 minutes
after production so the two never hit the sources at the same moment. It loads bids and emails only the
addresses in its own `RADAR_RECIPIENTS` (today `isf/isf-main=ben@rfppilot.com`). Every subject starts with
`[STAGING]` (`RADAR_SUBJECT_PREFIX`). To add a reader, append the address to that variable.
