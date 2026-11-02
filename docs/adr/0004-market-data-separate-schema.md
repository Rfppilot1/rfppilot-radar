# 4. Public market data lives in its own schema, with every raw response kept

Date: 2026-10-31 · Status: accepted

## Context

Flight Deck's Market Intelligence views show public award data (who won, at what price, until when) next to a
customer's own bids. Customers and acquirers will ask where each number came from, and customer data must never
leak into anything shared.

## Decision

Market collectors write only to the `market` schema: raw responses (`market.captures`, compressed, de-duplicated
by content), normalized records that point at their capture, and a run log. Opportunities, matches and digests
are untouched. Customer data, when it arrives, goes in a separate tenant schema with row-level security, and is
never written to `market`. Amounts carry an explicit type and are only summed within one type.

## Consequences

Any figure can show its source and retrieval date, and records can be re-parsed from stored captures when a
parser improves, without re-fetching. Collection can start before the Flight Deck UI exists. Storage grows with
captures; identical pages are stored once, and old captures can be pruned without losing the records.
