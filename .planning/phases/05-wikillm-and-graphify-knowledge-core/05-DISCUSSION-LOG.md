# Phase 5: wikiLLM and Graphify Knowledge Core - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md.

**Date:** 2026-04-25
**Phase:** 5 - wikiLLM and Graphify Knowledge Core
**Mode:** `--auto --chain`
**Areas analyzed:** Knowledge source of truth, wiki shape, graph shape, incremental projection, product boundary

---

## Knowledge Source Of Truth

| Option | Description | Selected |
|--------|-------------|----------|
| RT2 domain events | Build knowledge projectors from the Phase 4 event stream | yes |
| Daily wiki/activity log | Faster but keeps knowledge tied to legacy daily fragments | no |
| Route-level materialization | Easy to add but not replay-safe | no |

**Selected:** RT2 domain events.
**Notes:** Phase 5 must build on Phase 4 projector state and processed-event tracking.

---

## Wiki Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Cumulative `index.md`, `log.md`, topic pages | Matches wikiLLM and RT2 cumulative memory direction | yes |
| Only daily wiki pages | Existing behavior, but insufficient for company memory | no |
| Freeform markdown files only | Human-readable but weak as a structured system contract | no |

**Selected:** Cumulative wiki pages with structured storage.
**Notes:** Existing daily pages can remain as one view, but cumulative wiki storage should be added or extended.

---

## Graph Shape

| Option | Description | Selected |
|--------|-------------|----------|
| Persist graph nodes and edges | Matches Graphify and makes reports/replay inspectable | yes |
| Compute graph ad hoc from tasks on every request | Existing pattern, but not a durable knowledge layer | no |
| Store inferred edges as facts | Violates RT2 graph provenance rule | no |

**Selected:** Persist graph rows with evidence, confidence, and rationale.
**Notes:** Start with direct `EXTRACTED` edges and preserve `INFERRED`/`AMBIGUOUS` only with explicit confidence and evidence.

---

## Incremental Projection

| Option | Description | Selected |
|--------|-------------|----------|
| Incremental event-scoped updates | Avoids full rebuild on every event and fits CQRS | yes |
| Full rebuild on every change | Simple but does not satisfy Phase 5 success criteria | no |
| Manual-only rebuild | Useful for recovery but not enough for live RT2 flow | no |

**Selected:** Incremental projection with a full rebuild recovery path.
**Notes:** Projector state should record event ids or input hashes for diagnosis and replay.

---

## Product Boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Knowledge materialization only | Keeps Phase 5 focused and sets up Phase 6 | yes |
| Jarvis/search/quality now | Scope creep into Phase 6 | no |
| Economy/marketplace now | Scope creep into Phase 7 | no |

**Selected:** Stop at reliable wiki/graph materialization and inspection APIs.
**Notes:** Jarvis, quality, hybrid search, and economy features consume this layer later.

---

## Deferred Ideas

- Jarvis advice, breakdowns, and insight generation over wiki/graph knowledge — Phase 6.
- Quality evaluation modes and approval boundaries over projected evidence — Phase 6.
- Hybrid lexical/semantic/reranked retrieval — Phase 6.
- Obsidian bidirectional sync — v2 expansion requirement `KNOW-03`.
- Amoeba economy and marketplace projections — Phase 7.
