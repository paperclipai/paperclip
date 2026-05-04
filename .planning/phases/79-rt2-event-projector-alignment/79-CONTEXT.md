# Phase 79: RT2 Event/Projector Alignment - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Mode:** auto (--auto --chain)

<domain>
## Phase Boundary

Phase 79 verifies RT2 event/projector alignment for MULTICA-03. It proves RT2-01 (append-only event stream, replay-safe projector state), RT2-02 (RT2 execution lifecycle integrated with Multica runtime with dispatch/heartbeat/cancel evidence), and RT2-03 (Work/Task/Deliverable lifecycle follows RT2-native operation contract, no Paperclip legacy pattern). This phase validates what Phase 67 designed and Phase 78 hardened — it does not introduce new semantics.

</domain>

<decisions>
## Implementation Decisions

### Event Stream — Append-Only (RT2-01, Phase 67/78 Carry-Forward)
- **D-01:** `appendAndProject` in `rt2-domain-events.ts` is the canonical append path. Events append to `rt2_v33_domain_events` table and trigger projector updates in a transaction. This is the single write path for RT2 domain events — no parallel event writing exists.
- **D-02:** `listTimeline` in `rt2-task-execution.ts` reads back from `rt2_v33_domain_events` (domain lifecycle events) and `heartbeat_run_events` (progress/message/tool events from runtime heartbeat). The merged result is sorted by `createdAt` then `seq` for ordering.
- **D-03:** `buildTimelineEvents` sorts domain rows by `occurredAt` then `createdAt`; heartbeat rows by `seq` then `createdAt`. The merged output is sorted by `createdAt` then `seq`. This produces a monotonically ordered `Rt2ExecutionTimelineEvent[]` for each attempt.
- **D-04:** `toDomainTimelineEvent` maps `eventType` → `kind`: `stale_cleaned` → `cleanup`, all others → `lifecycle`. This classification is used by UI surfaces to render timeline icons.

### Runtime Integration — Dispatch/Heartbeat/Cancel (RT2-02, Phase 67/78 Carry-Forward)
- **D-05:** `dispatch()` in `rt2-task-execution.ts` calls `assertRuntimeCanAccept` before transitioning state. `assertRuntimeCanAccept` checks: runtime exists, `status === "running"`, `healthStatus !== "unhealthy"`, `lastUsedAt` freshness (if `runtimeFreshnessSeconds` provided), and active attempt count vs capacity.
- **D-06:** `dispatch()` sets `state: "dispatched"` (not `"claimed"`), `executorType`, `executorId`, `executionWorkspaceId`, `runtimeServiceId`, `heartbeatRunId`, and `claimedAt` timestamp atomically in the database update. This is the canonical dispatch assignment — no separate claim step.
- **D-07:** `start()` transitions `dispatched` or `claimed` → `running` (both in `startableStates`). This allows legacy `claimed` attempts to still start. `startableStates = ["dispatched", "claimed"]` preserves backward compatibility.
- **D-08:** `cancel()` transitions `["queued", ...runtimeActiveStates]` → `cancelled`. `runtimeActiveStates = ["dispatched", "claimed", "running"]` includes `claimed` for backward compat. Cancel emits `rt2.execution.cancelled` domain event with idempotency key `rt2.execution.cancelled:${attemptId}`.
- **D-09:** `cleanupStale()` transitions stale `dispatched`/`claimed`/`running` attempts to `failed` with reason `"stale_runtime_cleanup"`. Emits `rt2.execution.stale_cleaned` domain event. Default stale window is 30 minutes.

### Idempotency Keys — Event Uniqueness (RT2-01, RT2-02)
- **D-10:** Every domain event uses idempotency keys: `rt2.execution.enqueued:${attempt.id}`, `rt2.execution.dispatched:${attemptId}`, `rt2.execution.started:${attemptId}`, `rt2.execution.completed:${attemptId}`, `rt2.execution.failed:${attemptId}`, `rt2.execution.cancelled:${attemptId}`, `rt2.execution.stale_cleaned:${candidate.id}:${staleBefore.toISOString()}`. The idempotency key includes attemptId and (for stale cleanup) timestamp, preventing duplicate event emission on retry.
- **D-11:** `appendAndProject` is called within a database transaction. If the event already exists (idempotency), the write is skipped or the existing record is used — this is the replay-safe guarantee.

### RT2-Native Lifecycle — Work/Task/Deliverable (RT2-03)
- **D-12:** `rt2TaskEngineService` owns task/todo creation, participant management, and deliverable creation. All mutations go through `appendAndProject` domain events: `rt2.task.created`, `rt2.todo.created`, `rt2.deliverable.defined`, `rt2.participant.joined`, `rt2.participant.assigned`, `rt2.participant.ended`, `rt2.task.capacity_changed`, `rt2.todo.started`. These are the RT2-native operation contracts.
- **D-13:** `rt2_task_execution_service` owns execution lifecycle (enqueue, dispatch, start, complete, fail, cancel, cleanup, retry, listTimeline). No Paperclip legacy pattern (e.g., no `WorkQueue`, no `AgentTask` legacy naming) appears in these service names or types — both services are `rt2-*` namespaced.
- **D-14:** Phase 67 explicitly marked `blocked` as task/dependency policy evidence, not a canonical runtime queue state. Phase 78 confirmed `blocked` may be read for compat but is not part of the Multica-style terminal set. Phase 79 verifies no new code introduces `blocked` as a runtime target state.
- **D-15:** Task creation (`rt2-task-engine.ts` `createTask`) creates a transaction with: issue, task profile, deliverables, and `rt2.task.created` domain event. This is the RT2-native task creation path — no Paperclip `createIssue` path is used for RT2 tasks.

### the agent's Discretion
- Exact stale threshold configuration (default 30 minutes) — provided it's explicit, tested, and recorded in evidence.
- Exact timeline event sorting tiebreaker when `createdAt` is equal but `seq` differs — the current rule (`seq` ascending) is correct and consistent.
- Whether Phase 79 adds specific tests for idempotency key deduplication on replay, or verifies existing tests cover this behavior.
- Exact UI placement for execution timeline in task panel — provided evidence surfaces are visible and Korean-first.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `.planning/PROJECT.md` - v3.3 RT2 Engine Convergence goal, RealTycoon2-first identity, Multica engine boundary.
- `.planning/REQUIREMENTS.md` - `RT2-01`, `RT2-02`, `RT2-03`, `MULTICA-03`.
- `.planning/ROADMAP.md` - Phase 79 goal, success criteria, v3.3 dependency chain, Phase 78/80 boundary.
- `.planning/STATE.md` - Phase 79 current position (planned, not started).
- `.planning/phases/78-multica-runtime-alignment/78-CONTEXT.md` - Phase 78 verification decisions confirming Phase 67 implementation.

### Prior Phase Context (Phase 67/78)
- `.planning/phases/67-multica-runtime-execution-alignment/67-CONTEXT.md` - Phase 67 runtime alignment decisions (queue state machine, runtime-aware dispatch, heartbeat/cancellation/cleanup, progress stream, work card/Jarvis surfaces).
- `.planning/phases/67-multica-runtime-execution-alignment/67-VERIFICATION.md` - Phase 67 verification evidence.
- `.planning/phases/78-multica-runtime-alignment/78-CONTEXT.md` - Phase 78 verification context confirming MULTICA-01/02/03.

### Existing RT2 Event/Execution Code
- `packages/db/src/schema/rt2_v33_execution_attempts.ts` - Execution attempt table with state CHECK constraint (dispatched, claimed, running, completed, failed, cancelled, blocked).
- `packages/db/src/schema/rt2_v33_domain_events.ts` - Domain events table with entityType/entityId indexing for timeline reads.
- `packages/db/src/schema/heartbeat_run_events.ts` - Heartbeat event stream for progress/message/tool evidence.
- `packages/shared/src/types/rt2-task.ts` - `Rt2ExecutionState` (queued/dispatched/claimed/running/completed/failed/cancelled/blocked), `Rt2ExecutionTimelineEvent` interface, `Rt2ExecutionSummary`.
- `server/src/services/rt2-domain-events.ts` - `appendAndProject` domain event append path.
- `server/src/services/rt2-task-execution.ts` - Execution lifecycle service with `normalizeExecutionState()` at line 36-38 (claimed→dispatched), `buildTimelineEvents()`, `appendExecutionEvent()`, lifecycle methods (enqueue, dispatch, start, complete, fail, cancel, cleanupStale, retry, listTimeline).
- `server/src/services/rt2-task-engine.ts` - Task/todo engine with `normalizeExecutionState()` at line 206-208, `buildExecutionSummary()`, `buildTimelineEvents()`, task/todo/participant/deliverable CRUD with domain events.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2DomainEventService().appendAndProject` is the single event append path — all RT2 events flow through it.
- `normalizeExecutionState()` in both `rt2-task-execution.ts` (line 36) and `rt2-task-engine.ts` (line 206) correctly map `claimed` → `dispatched`.
- `rt2TaskExecutionService.listTimeline` builds `Rt2ExecutionTimelineEvent[]` from domain events + heartbeat events with deterministic ordering.
- Domain events use idempotency keys like `rt2.execution.dispatched:${attemptId}` preventing duplicate emission on retry.
- `startableStates = ["dispatched", "claimed"]` preserves backward compatibility for legacy `claimed` attempts.

### Established Patterns
- RT2 event stream is append-only via `appendAndProject` — events are never deleted or mutated after append.
- Idempotency keys prevent duplicate event emission; replay of `appendAndProject` is safe.
- Timeline merges two sources: `rt2_v33_domain_events` (lifecycle events) + `heartbeat_run_events` (progress/message/tool).
- `normalizeExecutionState()` is applied at every `toExecutionSummary()` call — product surfaces never see `"claimed"`.
- Stale cleanup runs on a configurable 30-minute window, transitions stale attempts to `failed` with reason, emits `rt2.execution.stale_cleaned`.
- `dispatch()` is atomic: state change + runtime service update + domain event emission in sequence.
- All task/todo/participant/deliverable mutations emit domain events — no silent mutations.

### Integration Points
- `dispatch()` → `assertRuntimeCanAccept` checks runtime health/capacity before dispatch → `appendExecutionEvent` emits `rt2.execution.dispatched`.
- `start()` transitions `dispatched`/`claimed` → `running` → `appendExecutionEvent` emits `rt2.execution.started`.
- `complete/fail/cancel/cleanupStale` each emit their respective domain events with proper idempotency keys.
- `listTimeline(attemptId)` → `buildTimelineEvents` reads from both domain event table and heartbeat event table, merges with time/seq ordering.
- Task creation creates issue + task profile + deliverables + `rt2.task.created` event in a single transaction.

</code_context>

<specifics>
## Specific Ideas

- Phase 67 D-04 explicitly requires domain events for every lifecycle edge. The current implementation delivers this for: enqueued, dispatched, started, completed, failed, cancelled, stale_cleaned, retried.
- Phase 78's plan (78-01-PLAN.md) already identified the verification paths for MULTICA-01/02/03. Phase 79 extends to RT2-01/02/03 which focuses on the event stream and projector behavior, not just the runtime lifecycle.
- RT2-01 verification: prove `rt2_v33_domain_events` records are append-only (no UPDATE/DELETE), idempotency keys prevent duplicate events, and timeline reads return events in correct order.
- RT2-02 verification: prove execution lifecycle events (`rt2.execution.dispatched`, `started`, `completed`, `failed`, `cancelled`) are emitted with correct idempotency keys and consumed by `listTimeline`.
- RT2-03 verification: prove Work/Task/Deliverable lifecycle events (`rt2.task.created`, `rt2.todo.created`, `rt2.deliverable.defined`, etc.) are the canonical operation path, no legacy Paperclip patterns in RT2 surfaces.
- MULTICA-03 (Phase 67) requires Multica runtime event/projector integration. Phase 79 proves the integration works — events are appended and timeline reads them back correctly, meeting the Phase 67 intent.

</specifics>

<deferred>
## Deferred Ideas

- RT2-01 (event stream append-only) is part of Phase 80's deeper verification scope if needed.
- RT2-03 (Paperclip legacy cleanup) is Phase 83 scope — Phase 79 verifies RT2-native contracts are in place, cleanup removes legacy naming.
- WIKI-01/02/03 (wikiLLM/Graphify projection) are Phase 81 scope.
- CLEANUP-01/02/03 (Paperclip residue) is Phase 82 scope.
- Full daemon import or remote worker marketplace remains future scope.

</deferred>

---

*Phase: 79-rt2-event-projector-alignment*
*Context gathered: 2026-05-04*
*Mode: auto (--auto --chain)*