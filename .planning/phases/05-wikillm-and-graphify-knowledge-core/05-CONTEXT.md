# Phase 5: wikiLLM and Graphify Knowledge Core - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

Materialize the RT2 cumulative knowledge layer from the Phase 4 domain event stream. This phase turns company-scoped RT2 events into durable wiki pages and provenance-aware graph rows. It covers cumulative `index.md`, `log.md`, topic pages, graph nodes, graph edges, graph reports, incremental projection, and replay-safe projector integration.

This phase does not implement Jarvis answer generation, quality evaluation automation, semantic/reranked hybrid search, Obsidian sync, or amoeba economy policy. Those remain Phase 6, v2 expansion, or Phase 7 work.

</domain>

<decisions>
## Implementation Decisions

### Knowledge source of truth
- **D-01:** RT2 domain events are the input source for knowledge materialization. Existing daily wiki pages, graph services, live events, and activity logs are reusable projection targets or compatibility data, not the canonical write path.
- **D-02:** Phase 5 should use the Phase 4 projector contract and processed-event tracking instead of adding an unrelated scheduler or route-only materialization path.
- **D-03:** Projectors should be replay-safe by event id and deterministic for the same event history.

### Wiki shape
- **D-04:** Build cumulative wiki pages, not only isolated daily fragments. The first required pages are `index.md`, `log.md`, and topic pages.
- **D-05:** `log.md` is append-oriented chronological memory. It should preserve event order, actor, task, todo, deliverable, project, and evidence references.
- **D-06:** `index.md` is curated navigation over the generated knowledge set, grouped by project, task, deliverable, people, and current high-signal topics.
- **D-07:** Topic pages should be stable by key and regenerated incrementally from events. Useful first topic keys are project, task, deliverable, actor, and daily report anchors.
- **D-08:** Existing `rt2_v33_daily_wiki_pages` can remain as a daily view, but Phase 5 should introduce or extend a cumulative wiki storage model rather than forcing cumulative knowledge into daily-page rows.

### Graph shape
- **D-09:** Graph rows must persist, not only be computed ad hoc in `rt2-task-mesh.ts`.
- **D-10:** The first graph pass should store clearly extracted nodes and edges from existing RT2 records and domain events: project-task, task-todo, task-deliverable, daily-report-task, actor-task, and event-entity links.
- **D-11:** `EXTRACTED` edges require direct source evidence. `INFERRED` and `AMBIGUOUS` edges require confidence, rationale, and evidence metadata; they must not be presented as facts.
- **D-12:** Existing Graphify-style report ideas such as central nodes, communities, and surprising connections are useful read models, but they must be based on persisted graph data.
- **D-13:** If the existing graph migration tables are not represented in Drizzle schema exports, Phase 5 should add synchronized schema definitions before relying on them from server code.

### Incremental projection
- **D-14:** The projector should update only affected wiki and graph scopes where practical: company index, company log, project/topic pages, and related graph nodes/edges for the event's entity.
- **D-15:** Full rebuild should exist as a recovery/admin path, but normal updates should not rebuild all company knowledge on every event.
- **D-16:** Projection state should record input event ids or input hashes so stale derived rows can be diagnosed and replayed.

### Product boundary
- **D-17:** Jarvis can consume this knowledge later, but Phase 5 should stop at reliable materialized knowledge APIs and data. Natural-language assistant behavior belongs to Phase 6.
- **D-18:** Hybrid retrieval can read wiki/graph output later, but semantic ranking and search UX are Phase 6. Phase 5 may expose basic company/project-scoped list/read APIs needed to inspect projected knowledge.
- **D-19:** Obsidian-compatible file sync is not in this milestone scope. Internal markdown storage should still use names and structure that would make future sync straightforward.

### the agent's Discretion
- Exact cumulative wiki table names and whether markdown pages are stored in one table or separate page/log tables, as long as they are company-scoped and replayable.
- Exact first list of topic page generators, provided project/task/deliverable/actor coverage exists.
- Whether the first projector runs synchronously after append or through an in-process replay function, provided it uses the Phase 4 projector contract.
- Exact graph community algorithm for the first pass, provided edge confidence and evidence semantics are preserved.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone source of truth
- `.planning/PROJECT.md` — RT2 refoundation goal and wikiLLM+Graphify role in the triple foundation.
- `.planning/REQUIREMENTS.md` — Phase 5 requirements `FOUND-03`, `KNOW-01`, and `KNOW-02`.
- `.planning/ROADMAP.md` — Phase 5 goal and success criteria.
- `.planning/STATE.md` — Current state after Phase 4 completion.
- `AGENTS.md` — RT2-first identity, cumulative wiki policy, graph provenance rules, CQRS/event-first direction, and company-scope requirements.

### Prior phase decisions
- `.planning/phases/04-cqrs-event-stream-and-projections/04-CONTEXT.md` — Domain event stream and projector decisions that Phase 5 must build on.
- `.planning/phases/04-cqrs-event-stream-and-projections/04-SUMMARY.md` — Implemented event/projector service and verification status.
- `.planning/phases/03-multica-execution-backbone/03-CONTEXT.md` — Execution lifecycle entities that should become knowledge sources.
- `.planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md` — One-Liner and deliverable capture data that should feed wiki and graph.

### Existing event and projector code
- `server/src/services/rt2-domain-events.ts` — Append, idempotency, projector processed-event tracking, and activity/live bridge.
- `packages/shared/src/types/rt2-domain-events.ts` — Current event type and payload contract.
- `packages/shared/src/validators/rt2-domain-events.ts` — Validation contract for domain event append.
- `packages/db/src/schema/rt2_v33_domain_events.ts` — Domain event and projector tables from Phase 4.

### Existing wiki and graph code
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — Existing daily wiki projection storage.
- `server/src/services/rt2-daily-report.ts` — Current daily wiki materialization from activity log.
- `server/src/routes/rt2-daily-report.ts` — Current daily wiki routes and live-event behavior.
- `server/src/services/rt2-task-mesh.ts` — Current graph construction, report generation, central node, and surprising connection logic.
- `server/src/routes/rt2-task-mesh.ts` — Existing graph and graph-report endpoints.
- `packages/shared/src/types/rt2-graph.ts` — Current graph node, edge, confidence, evidence, and report contracts.
- `packages/shared/src/validators/rt2-graph.ts` — Graph API validation.
- `ui/src/components/Rt2GraphPanel.tsx` — Current graph inspection UI expectations.
- `ui/src/api/rt2-graph.ts` — Current graph API client contract.

### Existing graph migrations
- `packages/db/src/migrations/0059_rt2_v33_project_graph_projection.sql` — Existing persisted graph node, edge, cache, community, and report tables.
- `packages/db/src/migrations/0064_rt2_v33_knowledge_upgrade.sql` — Existing centrality, god node, report, and surprising connection additions.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2DomainEventService.processEvent`: Already provides projector idempotency by `(projectorName, eventId)` and should wrap wiki/graph projection handlers.
- `rt2_v33_daily_wiki_pages`: Existing daily wiki storage can be kept as one read model while cumulative wiki storage is added.
- `rt2TaskMeshService`: Provides useful graph node/edge construction and report concepts, but currently computes graph output ad hoc instead of relying on persisted graph rows.
- `Rt2GraphConfidence`: Already has `EXTRACTED`, `INFERRED`, and `AMBIGUOUS`, matching RT2 graph provenance rules.

### Established Patterns
- Company access is enforced at routes; Phase 5 APIs must keep company/project scoping.
- Existing RT2 graph contracts expose evidence and rationale, so Phase 5 should preserve and strengthen those fields rather than replacing them with opaque links.
- Existing daily wiki materialization reads `activity_log`; Phase 5 should migrate source-of-truth semantics to domain events while preserving useful summaries.

### Integration Points
- Add or complete DB schema for cumulative wiki pages and exported graph projection tables.
- Add shared wiki/graph projector types and validators where new APIs are needed.
- Add a server knowledge projector service that consumes RT2 domain events.
- Wire Phase 4 append paths to run the Phase 5 knowledge projector where local synchronous projection is acceptable.
- Update graph service/routes to read persisted graph rows or expose a clear rebuild path.
- Add tests for cumulative page creation, append-only log behavior, topic page updates, graph edge provenance, projector idempotency, and incremental replay.

</code_context>

<specifics>
## Specific Ideas

- Treat `index.md` as navigation, `log.md` as chronological memory, and topic pages as reusable knowledge artifacts.
- Make generated markdown useful for humans, but keep structured rows as the real system contract.
- Store evidence references using stable event, task, todo, deliverable, project, actor, and page keys.
- Keep Phase 5 inspectable without waiting for Phase 6 Jarvis: users and tests should be able to fetch projected pages and graph reports directly.

</specifics>

<deferred>
## Deferred Ideas

- Jarvis advice, breakdowns, and insight generation over wiki/graph knowledge — Phase 6.
- Quality evaluation modes and approval boundaries over projected evidence — Phase 6.
- Hybrid lexical/semantic/reranked retrieval over wiki, graph, tasks, and deliverables — Phase 6.
- Obsidian bidirectional sync — v2 expansion requirement `KNOW-03`.
- Amoeba P&L, marketplace, collaboration rewards, and economic policy projection — Phase 7.

</deferred>

---

*Phase: 05-wikillm-and-graphify-knowledge-core*
*Context gathered: 2026-04-25*
