# Changelog

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
