# 3. Public sources only, no logins, documented basis per source

Date: 2026-10-15 · Status: accepted

## Context

Many procurement portals and aggregators require accounts or restrict automated access. Data provenance is a
standard diligence question, and scraping behind logins creates legal and reputational risk.

## Decision

Radar collects only from official APIs or public pages that require no sign-in, identifies itself, paces
requests, and records a collection basis per source in docs/SOURCES.md. Sources that require accounts are
added through official feeds or licensed data agreements, not automation of a person's login.

## Consequences

Coverage grows source by source with a clean record. Some local portals will need agreements or customer-side
integrations rather than collection by Radar.
