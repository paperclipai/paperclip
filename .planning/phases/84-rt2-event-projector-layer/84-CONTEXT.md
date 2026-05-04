# Phase 84: RT2 Event/Projector Layer - Context

**Gathered:** 2026-05-04
**Status:** Ready for planning

<domain>
## Phase Boundary

RT2 event stream이 append-only projection pattern을 따르고 replay-safe projector state를 유지하며, RT2 execution lifecycle event가 Multica runtime과 integrated되어 dispatch/heartbeat/cancel evidence를 갖는다. Work/Task/Deliverable lifecycle이 RT2-native operation contract를 따르고 Paperclip legacy pattern이 없다.

Requirements: RT2-01 (event stream append-only), RT2-02 (Multica integration), RT2-03 (RT2-native lifecycle)

</domain>

<decisions>
## Implementation Decisions

### Event Stream Architecture
- **D-01:** Event stream uses `rt2_v33_domain_events` table as append-only log with idempotency key constraint on (companyId, idempotencyKey)
- **D-02:** Idempotency enforced at DB level via unique index — duplicate events rejected on insert
- **D-03:** Events emitted synchronously within the same transaction as state changes for consistency
- **D-04:** Projector state tracked in `rt2_v33_projector_state` with status (idle/running/failed) and last processed event ID for replay

### Projector Pattern
- **D-05:** Projectors read from domain event stream and update read models atomically
- **D-06:** Each projector maintains `lastEventId` and `lastProcessedAt` for replay-safe resumability
- **D-07:** Projector failures increment `failureCount` — after threshold, projector marks as failed and requires manual intervention
- **D-08:** Projector event processing tracked in `rt2_v33_projector_events` for audit/debugging

### Execution Lifecycle Integration
- **D-09:** Execution state machine: queued → dispatched → claimed → running → completed/failed/cancelled/blocked
- **D-10:** State transitions emit corresponding `rt2.execution.*` domain events (rt2.execution.enqueued, rt2.execution.dispatched, etc.)
- **D-11:** Executor types: user (human), jarvis (AI assistant), runtime (automated agent)
- **D-12:** Heartbeat service handles runtime dispatch — checks capacity and emits rt2.execution.dispatched on claim
- **D-13:** Cancel/retry handled via heartbeat run watchdog decisions, emitting rt2.execution.cancelled or rt2.execution.retried
- **D-14:** Execution timeline events (lifecycle, progress, message, tool, cleanup) stored with source: "rt2_domain_event" or "heartbeat"

### Work Entity Lifecycle
- **D-15:** Task supports solo/collab modes with participant tracking (joined, assigned, ended)
- **D-16:** Todo has status: todo → in_progress → in_review → done/blocked/cancelled
- **D-17:** Deliverable kinds: document, artifact — states: defined, submitted
- **D-18:** Execution lifecycle is the core operation contract — Task/Todo/Deliverable entities reference executionAttemptId
- **D-19:** No Paperclip legacy issue_work_products pattern in RT2-native operations — uses rt2_v33_execution_attempts instead

### the agent's Discretion
- Exact projector failure threshold and recovery strategy
- Batch size for projector replay processing
- Whether to use change data capture or polling for projector triggering
- Execution attempt metadata schema details

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Event System
- `packages/db/src/schema/rt2_v33_domain_events.ts` — Event store schema with idempotency, indexes
- `packages/shared/src/types/rt2-domain-events.ts` — Domain event types and payloads
- `server/src/services/rt2-domain-events.ts` — Domain event append service and live event publishing

### Execution
- `packages/db/src/schema/rt2_v33_execution_attempts.ts` — Execution attempt state machine
- `packages/shared/src/types/rt2-task.ts` — Execution state types, timeline events
- `server/src/services/heartbeat.ts` — Heartbeat dispatch, runtime management (lines 1-200 for structure)

### Projector
- `packages/db/src/schema/rt2_v33_domain_events.ts` — rt2V33ProjectorState, rt2V33ProjectorEvents tables

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2V33DomainEvents` table: ready-to-use event store with idempotency
- `rt2V33ProjectorState` table: projector tracking with replay-safe cursor
- Domain event types already defined: task.created, execution.enqueued/dispatched/claimed/started/completed/failed/cancelled, etc.
- Live event publishing in `rt2-domain-events.ts` already handles rt2.task.updated, rt2.participant.updated, etc.

### Established Patterns
- Actor types: user, agent, system, runtime
- Entity types: task, todo, participant, deliverable, execution
- Event versioning with eventVersion field (default 1)
- Correlation/causation ID chain for tracing

### Integration Points
- Execution attempts → domain events: execute state transitions emit events
- Heartbeat service → execution state: heartbeat claims execution slot, updates state
- Live events → UI: execution events published as rt2.task.updated for real-time updates

</code_context>

<specifics>
## Specific Ideas

- Multica runtime serves as execution coordinator — heartbeat service dispatches to runtime and tracks heartbeat_run_id in execution_attempts
- Execution timeline supports both rt2_domain_event source and heartbeat source for unified tracing
- No separate Paperclip "issue" concept in RT2-native flow — Task issue IS the task

</specifics>

<deferred>
## Deferred Ideas

- v3.5에서 별도 phase로 분리 가능: Graphify-style corpus graph projector
- Projector clustering/distributed processing — future scale concern
- Event replay optimization (snapshot strategy) — premature for current scale

</deferred>

---

*Phase: 84-rt2-event-projector-layer*
*Context gathered: 2026-05-04*