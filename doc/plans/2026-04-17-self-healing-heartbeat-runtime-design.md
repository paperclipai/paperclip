# Self-Healing Heartbeat Runtime Design

## Goal

Make the Paperclip heartbeat runtime self-healing by default so lost or stalled runs are detected, recovered on the same issue, and surfaced truthfully without operator cleanup.

## Scope

This design hardens the existing in-process heartbeat runtime. It does not introduce an external queue, a separate supervisor service, or successor-issue recovery as the default path.

## Runtime Contract

- `assigneeAgentId` remains ownership truth.
- `executionRunId` remains execution-slot truth.
- Same-issue recovery remains the default.
- Lost or stalled execution is handled before fresh dispatch so dead work does not hold slots indefinitely.

## Recovery Policy

- Balanced recovery target:
  - suspect after roughly 90 seconds without trusted activity
  - lost after roughly 150 seconds without trusted activity
  - same-issue retry inside 5 minutes
- Trusted activity must be stored separately from generic row updates so suspect/lost bookkeeping does not reset the lease clock.
- Default retry policy:
  - retry the same agent on the same issue once for transient runtime loss
  - after that, surface the exhausted state and let COO reconsider ownership
- Default uncertainty policy:
  - use a short grace window before declaring loss
  - prefer duplicate-work avoidance over immediate redispatch

## Failure Containment

- Adapter-level circuit breakers are the first containment boundary.
- Repeated transient failures on one adapter type within one company should block further automatic recovery for a cooldown window.
- An open adapter circuit should also pause fresh dispatch for queued work on that adapter until the cooldown closes.
- Healthy agents and adapters in the same company should continue working.

## Visibility

- Always emit structured run events and activity-log rows for recovery decisions.
- Only leave issue comments when recovery changes status, ownership, or requires operator attention.
- Inbox should hide failed runs that are still actively self-healing and only surface terminal recovery states.

## Implementation Slice

The implementation for this pass focuses on:

1. trustworthy liveness timestamps for active runs
2. suspect/lost detection in orphan recovery
3. automatic retry planning using existing retry metadata
4. adapter-level retry circuit gating using existing circuit storage
5. Inbox filtering for runs that are still auto-recovering

## Non-Goals

- external durable queue infrastructure
- host-level runtime quarantine
- automatic reassignment on first loss
- broad UI redesign
