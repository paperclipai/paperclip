# Phase 5: wikiLLM and Graphify Knowledge Core - Research

**Status:** Complete
**Date:** 2026-04-25

## Findings

- Phase 4 already added `rt2DomainEventService.processEvent(projectorName, eventId, handler)`, which is the correct backbone for replay-safe wiki and graph projectors.
- Existing daily wiki behavior is stored in `rt2_v33_daily_wiki_pages`, but it is derived from `activity_log`, not the RT2 domain event stream.
- Existing graph behavior in `rt2-task-mesh.ts` builds nodes and edges ad hoc from tasks, todos, daily wiki pages, and deliverables. It has useful Graphify concepts but does not persist graph rows from projection.
- Migrations `0059` and `0064` already define graph tables, but the current Drizzle schema directory does not export matching graph table definitions. Phase 5 should add synchronized schema files before server code depends on those tables.
- Shared graph contracts already distinguish `EXTRACTED`, `INFERRED`, and `AMBIGUOUS`, and include evidence/rationale fields. These should be reused and tightened.

## Recommended Implementation

1. Add DB schema for cumulative wiki pages and exported graph projection tables.
2. Add a migration for cumulative wiki pages; reuse existing graph table migrations by adding schema definitions only.
3. Add shared knowledge types and validators for page list/read responses.
4. Add `rt2-knowledge-projector` service:
   - consumes RT2 domain events,
   - upserts `index.md`, `log.md`, and topic pages,
   - upserts graph nodes/edges with evidence,
   - uses `rt2DomainEventService.processEvent`.
5. Wire event append flow so Phase 5 projections run after domain events are appended.
6. Add routes to inspect wiki pages and rebuild/project knowledge from domain events where needed.
7. Add focused tests for wiki page materialization, graph edge provenance, and projector idempotency.

## Validation Architecture

- Shared validator tests for knowledge page query contracts.
- Embedded Postgres service tests for:
  - cumulative `index.md`, `log.md`, and topic page creation,
  - idempotent reprocessing of the same event,
  - graph nodes and `EXTRACTED` edges with evidence.
- Route tests for company-scoped knowledge page read/list and rebuild/project endpoint.

## Risks

- Existing graph migrations without Drizzle schema exports can hide runtime drift. Add schema definitions and typecheck.
- Replaying all historical events in route handlers could be expensive later. Keep this phase's rebuild path explicit and scoped; normal append path should process the current event only.
- Daily report writes still have legacy activity-log behavior. Phase 5 should avoid a large rewrite unless needed for event coverage; Phase 4 task/deliverable/execution events are enough to prove the knowledge core.
