# Phase 80: Work Lifecycle Integration - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Mode:** auto (--auto --chain)

<domain>
## Phase Boundary

Phase 80 integrates the RT2 execution lifecycle (RT2-02: dispatch/heartbeat/cancel evidence from Phase 79) with the Work/Task/Deliverable lifecycle (RT2-03: RT2-native operation contract, no Paperclip legacy pattern). It also verifies the event stream append-only guarantee (RT2-01) that Phase 79 established, with deeper verification scope as needed. Phase 80 does not introduce new event semantics — it proves RT2-native operation contracts are correctly wired through the event stream.

</domain>

<decisions>
## Implementation Decisions

### Event Stream — Append-Only (RT2-01, Phase 78/79 Carry-Forward)
- **D-01:** `appendAndProject` in `rt2-domain-events.ts` is the single event write path. All RT2 domain events flow through this function — no parallel event writing path exists. Phase 80 verifies this is the only write path.
- **D-02:** `rt2_v33_domain_events` records are never updated or deleted after append. Phase 80 verifies no UPDATE/DELETE paths exist on this table in RT2 service code.
- **D-03:** Idempotency keys prevent duplicate events: `rt2.{event_type}:{attemptId}` pattern for lifecycle events, and `rt2.execution.stale_cleaned:{attemptId}:{timestamp}` for cleanup events. Phase 80 verifies idempotency keys are set on all event emission sites.
- **D-04:** Timeline reads from `rt2_v33_domain_events` + `heartbeat_run_events` return events in correct order (occurredAt/createdAt for domain, seq/createdAt for heartbeat). Phase 80 verifies ordering is deterministic on replay.

### Work/Task/Deliverable Lifecycle — RT2-Native Operations (RT2-03, Phase 79 Carry-Forward)
- **D-05:** `rt2TaskEngineService` is the canonical owner for task/todo creation, participant management, and deliverable creation. All mutations go through `appendAndProject` domain events: `rt2.task.created`, `rt2.todo.created`, `rt2.deliverable.defined`, `rt2.participant.joined`, `rt2.participant.assigned`, `rt2.participant.ended`, `rt2.task.capacity_changed`, `rt2.todo.started`.
- **D-06:** Task creation via `rt2-task-engine.ts` `createTask` creates a single transaction with: issue + task profile + deliverables + `rt2.task.created` domain event. No Paperclip `createIssue` path is used for RT2 tasks — Phase 80 verifies this path is the only task creation path.
- **D-07:** No Paperclip legacy pattern (`WorkQueue`, `AgentTask` legacy naming, `blocked` as runtime queue state) appears in RT2 service names, types, or product-facing surfaces. Phase 80 scans for legacy patterns and confirms zero instances.
- **D-08:** `blocked` is task/dependency policy evidence, not a canonical runtime queue state. Phase 80 confirms no code introduces `blocked` as a runtime transition target.

### Execution Lifecycle — RT2-02 Integration (RT2-02, Phase 78/79 Carry-Forward)
- **D-09:** `dispatch()` in `rt2-task-execution.ts` sets `state: "dispatched"` (not `"claimed"`), plus `executorType`, `executorId`, `executionWorkspaceId`, `runtimeServiceId`, `heartbeatRunId`, `claimedAt` atomically. Phase 80 verifies all required fields are set at dispatch.
- **D-10:** `start()` transitions `dispatched` or `claimed` → `running` (both in `startableStates`). `startableStates = ["dispatched", "claimed"]` preserves backward compatibility. Phase 80 verifies `claimed` attempts can still start.
- **D-11:** `cancel()` emits `rt2.execution.cancelled` with idempotency key `rt2.execution.cancelled:${attemptId}`. Transition path: `["queued", "dispatched", "claimed", "running"]` → `cancelled`. Phase 80 verifies cancel emits the domain event with correct idempotency.
- **D-12:** `cleanupStale()` transitions stale `dispatched`/`claimed`/`running` → `failed` with reason `"stale_runtime_cleanup"` and emits `rt2.execution.stale_cleaned`. Default stale window is 30 minutes. Phase 80 verifies this path works end-to-end.

### RT2-Native Operation Completeness (RT2-03)
- **D-13:** All task/todo/participant/deliverable mutations emit domain events — no silent mutations. Phase 80 verifies every CRUD method in `rt2TaskEngineService` emits the corresponding domain event.
- **D-14:** Deliverable definition (`rt2.deliverable.defined`) is the canonical deliverable creation event. Phase 80 verifies deliverable lifecycle is fully event-sourced through this event.
- **D-15:** Phase 79's D-14 confirmed `blocked` is not a runtime target state. Phase 80 verifies no new code introduces `blocked` as a dispatch/dispatchable runtime target.

### the agent's Discretion
- Exact verification depth for RT2-01 append-only guarantee — the Phase 79 verification path is the baseline; Phase 80 extends to any gaps found during planning.
- Exact stale threshold configuration (default 30 minutes) — provided it's explicit, tested, and recorded in evidence.
- Whether Phase 80 adds new tests or verifies existing tests cover the verified behaviors.
- Exact UI placement for execution timeline in task panel — provided evidence surfaces are visible and Korean-first.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `.planning/PROJECT.md` - v3.3 RT2 Engine Convergence goal, RealTycoon2-first identity, Multica engine boundary.
- `.planning/REQUIREMENTS.md` - `RT2-01`, `RT2-02`, `RT2-03`.
- `.planning/ROADMAP.md` - Phase 80 goal, success criteria, v3.3 dependency chain (Phase 78 → 79 → 80 → 81), and Phase 79/80 boundary.
- `.planning/STATE.md` - Phase 80 current position (planned, not started).
- `.planning/phases/79-rt2-event-projector-alignment/79-CONTEXT.md` - Phase 79 verification decisions confirming RT2-01/02/03.
- `.planning/phases/78-multica-runtime-alignment/78-CONTEXT.md` - Phase 78 verification context confirming MULTICA-01/02/03.

### Prior Phase Context (Phase 67/78/79)
- `.planning/phases/67-multica-runtime-execution-alignment/67-CONTEXT.md` - Phase 67 runtime alignment decisions (queue state machine, runtime-aware dispatch, heartbeat/cancellation/cleanup, progress stream, work card/Jarvis surfaces).
- `.planning/phases/67-multica-runtime-execution-alignment/67-VERIFICATION.md` - Phase 67 verification evidence.
- `.planning/phases/78-multica-runtime-alignment/78-CONTEXT.md` - Phase 78 verification context confirming MULTICA-01/02/03.
- `.planning/phases/79-rt2-event-projector-alignment/79-CONTEXT.md` - Phase 79 decisions for RT2-01 (append-only), RT2-02 (dispatch/heartbeat/cancel), RT2-03 (RT2-native operation contract).
- `.planning/phases/79-rt2-event-projector-alignment/79-01-PLAN.md` - Phase 79 plan with verification paths.

### Existing RT2 Event/Execution Code
- `packages/db/src/schema/rt2_v33_execution_attempts.ts` - Execution attempt table with state CHECK constraint.
- `packages/db/src/schema/rt2_v33_domain_events.ts` - Domain events table with entityType/entityId indexing for timeline reads.
- `packages/db/src/schema/heartbeat_run_events.ts` - Heartbeat event stream for progress/message/tool evidence.
- `packages/shared/src/types/rt2-task.ts` - `Rt2ExecutionState`, `Rt2ExecutionTimelineEvent`, `Rt2ExecutionSummary` types.
- `server/src/services/rt2-domain-events.ts` - `appendAndProject` domain event append path.
- `server/src/services/rt2-task-execution.ts` - Execution lifecycle service with `normalizeExecutionState()` (line 36-38), `buildTimelineEvents()`, `appendExecutionEvent()`, lifecycle methods (enqueue, dispatch, start, complete, fail, cancel, cleanupStale, retry, listTimeline).
- `server/src/services/rt2-task-engine.ts` - Task/todo engine with `normalizeExecutionState()` (line 206-208), `buildExecutionSummary()`, `buildTimelineEvents()`, task/todo/participant/deliverable CRUD with domain events.

</canonical_refs>

<codebase>
## Existing Code Insights

### Reusable Assets
- `rt2DomainEventService().appendAndProject` is the single event append path — all RT2 events flow through it.
- `normalizeExecutionState()` in both `rt2-task-execution.ts` (line 36) and `rt2-task-engine.ts` (line 206) correctly map `claimed` → `dispatched`.
- Domain events use idempotency keys like `rt2.execution.dispatched:${attemptId}` preventing duplicate emission on retry.
- `startableStates = ["dispatched", "claimed"]` preserves backward compatibility for legacy `claimed` attempts.
- `runtimeActiveStates = ["dispatched", "claimed", "running"]` used by `cancel()` for valid transition targets.

### Established Patterns
- RT2 event stream is append-only via `appendAndProject` — events are never deleted or mutated after append.
- Idempotency keys prevent duplicate event emission; replay of `appendAndProject` is safe.
- Timeline merges two sources: `rt2_v33_domain_events` (lifecycle events) + `heartbeat_run_events` (progress/message/tool).
- `normalizeExecutionState()` is applied at every `toExecutionSummary()` call — product surfaces never see `"claimed"`.
- All task/todo/participant/deliverable mutations emit domain events — no silent mutations.
- Task creation is a single transaction with domain event emission.

### Integration Points
- Dispatch flow: enqueue → dispatch (sets runtime/executor fields) → start → complete/fail/cancel/cleanupStale.
- Timeline: domain events + heartbeat run events → normalized `Rt2ExecutionTimelineEvent[]` → API route → UI surface.
- Task engine: `createTask` transaction → issue + profile + deliverables + `rt2.task.created` event in one atomic operation.
- Cancel: emits `rt2.execution.cancelled` with idempotency key `rt2.execution.cancelled:${attemptId}`.
- Stale cleanup: transitions stale attempts to `failed` with reason, emits `rt2.execution.stale_cleaned`.

</codebase>

<specifics>
## Specific Ideas

- Phase 79 already proved RT2-01 (append-only), RT2-02 (dispatch/heartbeat/cancel), RT2-03 (RT2-native contracts). Phase 80 extends the RT2-03 verification to prove the integration end-to-end — work lifecycle events are emitted and consumed through the event stream.
- RT2-01 verification scope: Phase 79 established the baseline. Phase 80 verifies the append-only guarantee with deeper inspection of the write paths (proving no UPDATE/DELETE exists in RT2 service code).
- RT2-02 verification: prove execution lifecycle events are emitted with correct idempotency keys and consumed by `listTimeline`. Phase 80 extends to prove the full lifecycle integration (dispatch → start → complete/fail/cancel) works through the event stream.
- RT2-03 verification: prove Work/Task/Deliverable lifecycle events (`rt2.task.created`, `rt2.todo.created`, `rt2.deliverable.defined`, etc.) are the canonical operation path, and no legacy Paperclip patterns exist in RT2 surfaces. Phase 80 scans service names, type names, and API routes for legacy patterns.
- RT2-03 also covers task creation path verification: `rt2TaskEngineService.createTask` must be the only task creation path, and it must emit `rt2.task.created` domain event.

</specifics>

<deferred>
## Deferred Ideas

- RT2-03 (Paperclip legacy cleanup) is Phase 83 scope — Phase 80 verifies RT2-native contracts are in place, cleanup removes legacy naming.
- WIKI-01/02/03 (wikiLLM/Graphify projection) are Phase 81 scope.
- CLEANUP-01/02/03 (Paperclip residue) is Phase 82 scope.
- Full daemon import or remote worker marketplace remains future scope.

</deferred>

---

*Phase: 80-work-lifecycle-integration*
*Context gathered: 2026-05-04*
*Mode: auto (--auto --chain)*
