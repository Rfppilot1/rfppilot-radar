# 1. Radar is a standalone service with one API

Date: 2026-10-15 · Status: accepted

## Context

Radar must work inside RFP Pilot (embedded), alongside it (backend calls), and inside a customer's Claude (MCP).
RFP Pilot's codebase is owned by a separate dev team on its own release cycle.

## Decision

Build Radar as its own service and repository with a versioned REST API. The MCP server and the embed are thin
clients of that API. RFP Pilot integrates through the API and the versioned handoff payload.

## Consequences

Radar can ship and be evaluated independently, and can be folded into RFP Pilot's monorepo later without
changing consumers. Costs: one more deployable and an auth boundary between the two systems.
