# 2. Explainable rules first; the model widens coverage, never narrows it

Date: 2026-10-15 · Status: accepted

## Context

Customers need to trust why something surfaced and, more importantly, that good work is not silently dropped.
Rules miss notices that do not use the firm's vocabulary; models are non-deterministic and cost money.

## Decision

A deterministic scorer attaches every point to a reason. An optional reviewer model may add one labeled reason
to in-scope matches below "strong". It never removes rule reasons and never overrides hard gates (geography,
status, deadline, exclusions). Reviews are cached against the opportunity's content hash.

## Consequences

Scores are reproducible from stored reasons, cost is bounded, and coverage improves where rules are weakest
(sources without codes, unusual titles).
