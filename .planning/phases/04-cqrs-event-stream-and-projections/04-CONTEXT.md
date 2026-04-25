# Phase 4: CQRS Event Stream and Projections - Context

**Gathered:** 2026-04-24
**Status:** Ready for planning

<domain>
## Phase Boundary

Move RT2 writes onto an append-only, company-scoped event path and add resilient projector contracts for core read models. This phase covers the event stream, event append service, idempotent projector checkpointing, and first projector-backed read model updates for One-Liner, task, deliverable, daily report, wiki, graph, search, P&L, and audit/activity linkage. It does not complete the full Phase 5 wikiLLM/Graphify knowledge system, Phase 6 Jarvis intelligence, or Phase 7 amoeba economy expansion.

</domain>

<decisions>
## Implementation Decisions

### Event stream ownership
- **D-01:** Create a dedicated RT2 domain event stream instead of treating the existing live-event publisher, plugin event bus, or activity log as the source of truth.
- **D-02:** RT2 mutation services should append a company-scoped event before mutating read models in the same transaction where practical.
- **D-03:** Live events and plugin events remain delivery/notification mechanisms fed by domain events, not durable business truth.
- **D-04:** Activity/audit records should carry the originating event id or command id so governance can trace mutation intent.

### Event contract
- **D-05:** Each event records stable identifiers for company, actor, entity type/id, event type, event version, command id, correlation id, causation id, idempotency key, payload, and metadata.
- **D-06:** Event types should use RT2 product language such as `rt2.task.created`, `rt2.todo.created`, `rt2.deliverable.defined`, `rt2.execution.completed`, and `rt2.daily_report.updated`.
- **D-07:** Event payloads are versioned and validated in `packages/shared` so DB schema, server services, API contracts, and future projectors stay synchronized.
- **D-08:** Command/idempotency keys should prevent duplicate business effects when a user retries a request or a projector replays events.

### Projector model
- **D-09:** Add explicit projector checkpoint state so projectors can resume and replay without duplicating rewards, approvals, activity records, or derived rows.
- **D-10:** Projectors must be idempotent by `(projectorName, eventId)` or an equivalent processed-event record, not by timing assumptions.
- **D-11:** The first implementation can run projectors synchronously or in-process after append for local reliability, but the contract must support asynchronous workers later.
- **D-12:** Projection failures should be inspectable and retryable without deleting or rewriting the source event.

### Read model scope
- **D-13:** Phase 4 should wire concrete projectors for the read models already present in the repo where the scope is narrow: RT2 task/todo/deliverable summaries, daily report cards/wiki pages, graph/search markers, personal P&L/coin ledger hooks, and activity/audit linkage.
- **D-14:** Full cumulative wikiLLM page writing and Graphify relationship inference stay deferred to Phase 5. Phase 4 only provides replay-safe projection surfaces and simple extracted relationships where already obvious.
- **D-15:** P&L/reward projection in Phase 4 should avoid final economic policy decisions. It should prove idempotent ledger-safe hooks, not complete amoeba accounting.

### Mutation integration
- **D-16:** `rt2TaskEngineService` and `rt2TaskExecutionService` are primary integration points because Phase 2 and Phase 3 writes already flow through them.
- **D-17:** Existing route-level `publishLiveEvent` calls in `rt2-tasks.ts` should be moved behind or mirrored from the event append/projector path so route handlers do not become the business event source.
- **D-18:** Company access and board actor checks remain route/service gates for all RT2 mutations. Phase 4 must not relax the Phase 3 governance boundary.
- **D-19:** The append service should be reusable by later Jarvis, quality, marketplace, and P&L phases without embedding those later policies now.

### the agent's Discretion
- Exact table names, as long as they are RT2-specific, descriptive, and company-scoped.
- Whether the first projector runner is synchronous, queued in-process, or manually invokable, provided replay/checkpoint contracts exist.
- Exact payload fields for each first-slice event, as long as shared validators and tests lock the contract.
- Whether activity records are written directly by the append service or by a projector, as long as they carry event provenance.

</decisions>

<specifics>
## Specific Ideas

- Treat this phase as the cut line that makes RT2 writes replayable instead of just visible.
- Existing `activity_log`, `publishLiveEvent`, and `plugin-event-bus` are useful outputs and compatibility channels, but they are not enough for CQRS.
- Event-first does not mean rewriting the whole backend. Start by wrapping the RT2 write paths from Phases 2 and 3.
- The implementation should support later wiki/graph/search/economy projection without forcing those future systems to parse ad hoc route logs.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Milestone source of truth
- `.planning/PROJECT.md` — RT2 refoundation goal and mandatory CQRS decision.
- `.planning/REQUIREMENTS.md` — Phase 4 requirements `LOG-03`, `CQRS-01`, `CQRS-02`, and `GOV-01`.
- `.planning/ROADMAP.md` — Phase 4 goal, success criteria, and cut-line position.
- `.planning/STATE.md` — Current state after Phase 3 completion.
- `AGENTS.md` — Event-first direction, company scope, audit, approval, and synchronized contract rules.

### Prior phase decisions
- `.planning/phases/01-rt2-shell-and-product-truth/01-CONTEXT.md` — RT2-first shell and Paperclip boundary.
- `.planning/phases/02-one-liner-and-deliverable-capture/02-CONTEXT.md` — One-Liner draft contract that must evolve into command/event writes.
- `.planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md` — Verified One-Liner/deliverable contract.
- `.planning/phases/03-multica-execution-backbone/03-CONTEXT.md` — Execution lifecycle decisions and Phase 4 deferral.
- `.planning/phases/03-multica-execution-backbone/03-VERIFICATION.md` — Verified execution lifecycle surfaces.

### Existing event, audit, and RT2 write code
- `server/src/services/activity-log.ts` — Current activity/audit-ish append plus live/plugin event fanout.
- `server/src/services/plugin-event-bus.ts` — In-process plugin event delivery, not durable RT2 source of truth.
- `server/src/services/live-events.ts` — Real-time notification channel that should remain a projection/output.
- `server/src/routes/activity.ts` — Current activity API and company access behavior.
- `server/src/routes/rt2-tasks.ts` — Route-level RT2 mutation and live-event publishing that Phase 4 should consolidate.
- `server/src/services/rt2-task-engine.ts` — Task, todo, participant, and deliverable write service.
- `server/src/services/rt2-task-execution.ts` — Execution lifecycle write service from Phase 3.
- `packages/shared/src/constants.ts` — Existing live/plugin event constants and RT2 graph/search constants.

### Existing read model surfaces
- `packages/db/src/schema/activity_log.ts` — Current activity persistence.
- `packages/db/src/schema/rt2_v33_task_profiles.ts` — RT2 task read model.
- `packages/db/src/schema/rt2_v33_task_participants.ts` — RT2 participant read model.
- `packages/db/src/schema/rt2_v33_execution_attempts.ts` — RT2 execution lifecycle read model.
- `packages/db/src/schema/rt2_v33_daily_report_cards.ts` — Daily report card surface.
- `packages/db/src/schema/rt2_v33_daily_wiki_pages.ts` — Daily wiki page surface.
- `packages/db/src/schema/rt2_search.ts` — RT2 search index surface.
- `packages/db/src/schema/rt2_personal_pnl.ts` — P&L and coin ledger surfaces.
- `packages/db/src/schema/rt2_collaboration_rewards.ts` — Collaboration event/reward surfaces.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `activity-log.ts`: Already sanitizes/redacts details, writes durable rows, publishes live events, and fans out plugin events. Reuse its redaction/fanout behavior as a projection/output pattern.
- `plugin-event-bus.ts`: Provides filtered event delivery semantics that later projectors or plugins can consume after durable append.
- `rt2TaskEngineService`: Central service for task, todo, participant, and deliverable writes; best first target for event append integration.
- `rt2TaskExecutionService`: Central service for execution lifecycle writes; best second target for event append integration.
- Existing RT2 schema families for daily wiki, graph, search, P&L, rewards, and execution attempts are projection targets.

### Established Patterns
- Company-scoped route access is enforced before RT2 mutations.
- RT2 task identity is layered on Paperclip issue ids, so event payloads must preserve both RT2 and underlying issue references where relevant.
- Shared validators/types are used for RT2 API contracts and should also guard event payload contracts.
- Live UI updates are currently route-published; Phase 4 should keep the UI behavior while moving source-of-truth semantics into the domain event layer.

### Integration Points
- Add DB schema and migration for RT2 domain events, projector state, and processed-event tracking.
- Add shared event constants, payload types, and validators.
- Add server-side event append/projector service boundaries.
- Wrap `createTask`, `createTodo`, participant/capacity changes, todo start, and execution lifecycle mutations with event append.
- Update or bridge route live-event publishing so it uses event/projector output instead of duplicated route logic.
- Add tests for append-before-read-model mutation, idempotency, replay, projector checkpointing, company access, and activity/audit provenance.

</code_context>

<deferred>
## Deferred Ideas

- Full wikiLLM cumulative page generation and topic synthesis — Phase 5.
- Full Graphify relationship inference with confidence/evidence review — Phase 5.
- Jarvis advice, quality automation, and hybrid retrieval over projected knowledge — Phase 6.
- Complete amoeba accounting, marketplace pricing, and reward policy finalization — Phase 7.
- External queue/worker deployment for projectors — later hardening unless needed for local correctness.

</deferred>

---

*Phase: 04-cqrs-event-stream-and-projections*
*Context gathered: 2026-04-24*
