# Security

## Model

- **Tenant isolation**: opportunities are public data shared across tenants. Profiles, matches, decisions and
  digest runs are keyed by (tenant, profile), so two tenants can use the same profile id and neither can see
  that the other exists. Every profile-scoped repository call requires the tenant id. Tests cover cross-tenant
  reads and writes for profiles, matches, decisions, second look, digest and handoff, on both repository
  implementations and through the API.
- **Routing**: every tenant route is registered inside one Fastify plugin whose auth hook runs for all of its
  routes, so the check does not depend on matching the raw URL (tests cover percent-encoded and odd paths).
- **Authentication**: bearer API keys, one tenant per key, at least 16 characters, stored as SHA-256 digests and
  compared in constant time. The `Authorization` header is redacted from logs.
- **Browser**: the embed never holds a key; the host application proxies.
- **Input**: every request body and query is validated with zod; body size is capped at 256 KB.
- **Outbound**: connectors only call documented source hosts, with timeouts on every request (body included)
  and a cap on server-requested retry delays; API keys are redacted from error messages and error objects.
- **Model input**: notice text sent to the optional reviewer is delimited, length-capped and marked as
  untrusted. A crafted notice could still sway a verdict, so a review alone cannot make a match "strong"
  (that needs rule-based evidence) and every review is stored with its rationale for audit.
- **Secrets**: never committed (`.env` is git-ignored; `.env.example` holds names only).
- **Data**: no personal data beyond the buyer contact details published in public notices.

## Roadmap before enterprise customers

- Keys issued and rotated through an admin endpoint, stored hashed in Postgres, with per-key scopes.
- Rate limiting per key.
- Audit log of decisions and profile changes (who/when), already partly covered by `decisions.decided_at/by`.
- Dependency and container scanning in CI; SBOM per release.

## Reporting

Email security@rfppilot.com. Do not open public issues for vulnerabilities.

## Accepted advisories

| Advisory                                                                            | Package                                                           | Why accepted                                                                                                                                                                                                  | Exit                                                                                        |
| ----------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) (Oct 2026) | zod 3.x (memory use validating oversized constrained collections) | Fixed only in zod 4.6.6+, a major-version migration (record and default semantics change). The API caps request bodies at 256 KB (16 KB on the feedback form), which bounds what any validator can be handed. | Migrate to zod 4 and remove the ignore from `package.json` (`pnpm.auditConfig.ignoreGhsas`) |
