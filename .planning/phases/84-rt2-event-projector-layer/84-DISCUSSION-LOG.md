# Phase 84: RT2 Event/Projector Layer - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions captured in CONTEXT.md — this log preserves the analysis.

**Date:** 2026-05-04
**Phase:** 84-rt2-event-projector-layer
**Mode:** discuss (auto --chain)
**Areas analyzed:** Event Stream Architecture, Projector Pattern, Execution Lifecycle Integration, Work Entity Lifecycle

## Areas Discussed

### Event Stream Architecture
- Confirmed: `rt2_v33_domain_events` table serves as append-only event store
- Idempotency via unique index on (companyId, idempotencyKey) where idempotencyKey is not null
- Events emitted synchronously within same transaction as state changes
- Projector state tracked in `rt2_v33_projector_state` with idle/running/failed status

### Projector Pattern
- Projectors read events and update read models atomically
- Replay-safe via `lastEventId` and `lastProcessedAt` tracking
- Failure count incremented on errors — threshold TBD as agent discretion

### Execution Lifecycle Integration
- State machine confirmed: queued → dispatched → claimed → running → completed/failed/cancelled/blocked
- Executor types: user, jarvis, runtime
- Heartbeat service handles dispatch and emits rt2.execution.dispatched
- rt2.execution.cancelled and rt2.execution.retried for cancel/retry flows

### Work Entity Lifecycle
- Task: solo/collab modes with participants
- Todo: todo → in_progress → in_review → done/blocked/cancelled
- Deliverable: defined/submitted states
- rt2_v33_execution_attempts as primary execution tracking (not issue_work_products)

## Auto-Selected (--auto flag)

All gray areas auto-selected via --auto mode. Decisions captured based on codebase analysis.

## Decisions Captured

- D-01 through D-19 as documented in 84-CONTEXT.md

## Canonical Refs Accumulated

- `packages/db/src/schema/rt2_v33_domain_events.ts`
- `packages/shared/src/types/rt2-domain-events.ts`
- `server/src/services/rt2-domain-events.ts`
- `packages/db/src/schema/rt2_v33_execution_attempts.ts`
- `packages/shared/src/types/rt2-task.ts`
- `server/src/services/heartbeat.ts`

---

*Phase: 84-rt2-event-projector-layer*
*Discussion Log: 2026-05-04*