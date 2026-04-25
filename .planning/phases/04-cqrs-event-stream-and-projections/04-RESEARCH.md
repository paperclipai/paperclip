# Phase 4: CQRS Event Stream and Projections - Research

**Date:** 2026-04-24
**Status:** Complete

## Findings

### Durable event source

The repo already has `activity_log`, `publishLiveEvent`, and `plugin-event-bus`, but these are delivery/audit surfaces rather than replayable RT2 business truth. Phase 4 should add a dedicated RT2 event stream and use existing delivery surfaces as outputs.

Relevant files:
- `server/src/services/activity-log.ts`
- `server/src/services/plugin-event-bus.ts`
- `server/src/services/live-events.ts`
- `packages/db/src/schema/activity_log.ts`

### RT2 write integration

The narrowest safe write surface is service-level integration:
- `server/src/services/rt2-task-engine.ts` owns task, todo, participant, deliverable, and todo start writes.
- `server/src/services/rt2-task-execution.ts` owns execution enqueue/claim/start/complete/fail/retry writes.
- `server/src/routes/rt2-tasks.ts` currently publishes live events directly and should keep route access checks while the event append service takes over durable mutation provenance.

### Projection model

Existing read-model surfaces already exist for daily report cards, daily wiki pages, search, P&L/coin ledger, collaboration, graph-like RT2 constants, and task summaries. Phase 4 should create replay-safe projector infrastructure rather than trying to complete all future read models.

Minimum useful infrastructure:
- `rt2_v33_domain_events`
- `rt2_v33_projector_state`
- `rt2_v33_projector_events`
- event append service with idempotency key support
- projector runner that records processed events and failures
- first projection bridge to activity/live events

### Idempotency and replay

Idempotency should be enforced at two levels:
- command/event append: unique `(company_id, idempotency_key)` where key exists
- projector execution: unique `(projector_name, event_id)`

This lets request retries and projector replays avoid duplicate side effects.

## Planning Guidance

- Add schema and migration first so shared/server contracts have a stable target.
- Add shared constants/validators for event types and append/projector results.
- Add `rt2-domain-events` service for append, list, projector processing, and activity/live bridge.
- Integrate task and execution services in focused places; avoid broad backend rewrites.
- Keep route-level company access and actor checks.
- Add tests around idempotency, append-before-mutation behavior, and execution lifecycle events.

## Validation Architecture

- Schema/type validation: `pnpm -r typecheck`
- Unit/route/service tests:
  - shared event validator tests
  - domain event service tests
  - RT2 task route tests updated for event append behavior
- Full regression if local runtime permits: `pnpm test:run`

