# Phase 78: Multica Runtime Alignment - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 78 verifies and hardens the existing Phase 67 Multica runtime alignment decisions. It proves MULTICA-01 (RT2 execution lifecycle with Multica queue/claim/heartbeat/dispatch), MULTICA-02 (runtime capacity, stale cleanup, progress stream on work card/Jarvis), and MULTICA-03 (Multica runtime event/projector integration with event stream). This phase does not introduce new execution semantics — it validates and hardens what Phase 67 designed.

</domain>

<decisions>
## Implementation Decisions

### Queue State Machine (Phase 67 Carry-Forward)
- **D-01:** The canonical RT2 execution queue vocabulary is Multica's `queued -> dispatched -> running -> completed/failed/cancelled` lifecycle. Phase 67 established this; Phase 78 validates it against actual code behavior.
- **D-02:** The current schema (`rt2_v33_execution_attempts.state` CHECK constraint) still includes BOTH `claimed` and `dispatched` states. Phase 67's intent was to treat `claimed` as a compatibility alias for `dispatched` in product-facing surfaces. Phase 78 verifies this alias mapping works correctly end-to-end and that no code path treats `claimed` as a distinct product state.
- **D-03:** The `normalizeExecutionState()` function in `rt2-task-execution.ts` (line 36-38) already maps `claimed` → `dispatched`. This is the correct implementation. Phase 78 verifies this function is called everywhere execution state is read for product surfaces.

### Runtime-Aware Dispatch (Phase 67 Carry-Forward)
- **D-04:** Phase 67 specified runtime-aware dispatch with capacity enforcement and workspace runtime health checks. Phase 78 verifies these checks exist in the dispatch path and are tested.
- **D-05:** The `dispatched` state assignment must set `executorType`, `executorId`, `runtimeServiceId`, optional `heartbeatRunId`, and `executionWorkspaceId`. Phase 78 verifies all required fields are set atomically at dispatch time.

### Heartbeat, Cancellation, And Cleanup (Phase 67 Carry-Forward)
- **D-06:** First-class cancellation writes `cancelledAt`, completion timestamp, reason, actor, and domain event. Phase 78 verifies the cancel path emits `rt2.execution.cancelled` domain event with correct idempotency key.
- **D-07:** Stale dispatched/running attempts whose runtime service is stopped/failed/missing/stale must be cleaned up with stable reason code. Phase 78 verifies cleanup evidence exists.
- **D-08:** Stale queued attempts whose task/todo reached terminal state or lost runtime scope before dispatch must be cleaned up. Phase 78 verifies this cleanup path.

### Progress, Message, And Tool Stream (Phase 67 Carry-Forward)
- **D-09:** `heartbeat_run_events` is the durable low-level stream reused for heartbeat-backed execution. Phase 78 verifies RT2 execution timeline reads from `heartbeat_run_events` and produces a normalized `Rt2ExecutionTimelineEvent[]`.
- **D-10:** API must expose execution timeline evidence by task/attempt. Phase 78 verifies a timeline route exists and returns structured timeline events.

### Work Card And Jarvis Evidence Surfaces (Phase 67 Carry-Forward)
- **D-11:** Work cards show execution state, executor/runtime, heartbeat/run freshness, cancellation/failure reason, latest progress, latest tool/message evidence compactly. Phase 78 verifies these fields are populated.
- **D-12:** `executionState` in Jarvis surfaces maps `claimed` → `dispatched` (line 586 of `rt2-jarvis.ts`). This is correct. Phase 78 verifies this mapping remains consistent.

### the agent's Discretion
- Exact migration implementation for `claimed` to `dispatched` in the CHECK constraint — the alias mapping in `normalizeExecutionState()` is the approved approach; schema CHECK constraint can keep both values for backward compatibility.
- Exact stale thresholds and cleanup timing — provided they are explicit, test-covered, and recorded in evidence.
- Exact UI placement for execution timeline details — provided work card/Jarvis surfaces expose required runtime evidence.
- Whether Phase 78 adds new tests or validates existing tests cover the verified behaviors.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Milestone Truth
- `.planning/PROJECT.md` - v3.3 RT2 Engine Convergence goal, RealTycoon2-first identity, Multica engine boundary.
- `.planning/REQUIREMENTS.md` - `MULTICA-01`, `MULTICA-02`, `MULTICA-03`.
- `.planning/ROADMAP.md` - Phase 78 goal, success criteria, and v3.3 dependency chain.
- `.planning/STATE.md` - Phase 78 current position and next-session instruction.

### Prior Phase Context (Phase 67)
- `.planning/phases/67-multica-runtime-execution-alignment/67-CONTEXT.md` - Phase 67 runtime alignment decisions (queue state machine, runtime-aware dispatch, heartbeat/cancellation/cleanup, progress stream, work card/Jarvis surfaces).
- `.planning/phases/67-multica-runtime-execution-alignment/67-VERIFICATION.md` - Phase 67 verification evidence (if exists).

### Existing RT2 Execution Code
- `packages/db/src/schema/rt2_v33_execution_attempts.ts` - Execution attempt table with state CHECK constraint supporting both `dispatched` and `claimed`.
- `packages/shared/src/types/rt2-task.ts` - `Rt2ExecutionState` type with both `dispatched` and `claimed` values; `Rt2ExecutionTimelineEvent` interface.
- `packages/shared/src/validators/rt2-task.ts` - Execution state validator with both `dispatched` and `claimed`.
- `packages/shared/src/types/rt2-domain-events.ts` - Domain event types including `rt2.execution.dispatched`, `rt2.execution.claimed`.
- `packages/shared/src/validators/rt2-domain-events.ts` - Domain event validators.
- `server/src/services/rt2-task-execution.ts` - Main execution service with `normalizeExecutionState()` (claimed→dispatched alias), lifecycle methods (dispatch, start, complete, fail, cancel, cleanup).
- `server/src/routes/rt2-tasks.ts` - Execution API routes.
- `server/src/services/rt2-jarvis.ts` - Jarvis service with `claimed`→`dispatched` mapping at line 586.
- `ui/src/api/rt2-tasks.ts` - Client API with execution state types.

</canonical_refs>

<codebase>
## Existing Code Insights

### Reusable Assets
- `normalizeExecutionState()` in `rt2-task-execution.ts` already correctly maps `claimed` → `dispatched` for all product-facing surfaces.
- Domain event types already include `rt2.execution.dispatched`, `rt2.execution.claimed`, `rt2.execution.completed`, `rt2.execution.failed`, `rt2.execution.cancelled`.
- `heartbeat_run_events` table already exists as durable event stream for progress/message/tool evidence.
- `rt2-task-execution.ts` already has dispatch, start, complete, fail, cancel, and cleanup methods.

### Established Patterns
- RT2 execution state machine: `queued → dispatched → running → completed/failed/cancelled`
- `claimed` is a legacy compatibility state that maps to `dispatched` in product-facing surfaces.
- Domain events use idempotency keys like `rt2.execution.dispatched:${attemptId}`.
- Timeline events come from two sources: `rt2_domain_event` (domain events) and `heartbeat_run_event`.

### Integration Points
- Dispatch flow: enqueue → dispatch (sets runtimeServiceId, heartbeatRunId, executorType, executorId) → start → complete/fail/cancel.
- Timeline: domain events + heartbeat run events → normalized Rt2ExecutionTimelineEvent[] → API route → UI surface.
- Jarvis mapping: `claimed` → `dispatched` in `rt2-jarvis.ts` line 586.

</codebase>

<specifics>
## Specific Ideas

- Phase 67's D-01 explicitly named `claimed` as a state to be migrated/mapped to `dispatched`. The current implementation does this at read time via `normalizeExecutionState()`, which is the correct approach — no data migration needed.
- The CHECK constraint still lists both `claimed` and `dispatched` — this is fine for backward compatibility. The canonical product state is `dispatched` only.
- MULTICA-01 verification: prove the lifecycle `queued → dispatched → running → completed/failed/cancelled` with transition guards works in code.
- MULTICA-02 verification: prove runtime capacity, stale cleanup, and progress stream are visible on work cards and Jarvis surfaces.
- MULTICA-03 verification: prove event/projector integration — domain events are appended to event stream and timeline reads them back.

</specifics>

<deferred>
## Deferred Ideas

- RT2-01 (event stream append-only) is Phase 80.
- RT2-02/03 (work lifecycle, Paperclip legacy) are Phase 81.
- WIKI-01/02/03 (wikiLLM/Graphify projection) are Phase 82.
- CLEANUP-01/02/03 (Paperclip residue) is Phase 83.
- Full daemon import or remote worker marketplace remains future scope.

</deferred>

---

*Phase: 78-multica-runtime-alignment*
*Context gathered: 2026-05-04*
*Mode: auto (--auto --chain)*
