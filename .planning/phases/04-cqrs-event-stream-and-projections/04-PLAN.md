---
phase: 4
name: CQRS Event Stream and Projections
status: ready
requirements_addressed:
  - LOG-03
  - CQRS-01
  - CQRS-02
  - GOV-01
---

# Phase 4: CQRS Event Stream and Projections - Plan

<objective>
Add the RT2 event-stream and projector backbone, then route existing RT2 task/deliverable/execution mutations through it without breaking current read models or live UI behavior.
</objective>

<wave id="1" name="Event Store Contract">

## Tasks

1. Add DB schema and migration for:
   - `rt2_v33_domain_events`
   - `rt2_v33_projector_state`
   - `rt2_v33_projector_events`
2. Export the schema from `packages/db/src/schema/index.ts`.
3. Add shared event type constants, payload types, append schemas, and projector result schemas.
4. Add focused shared tests for event validation and idempotency-key shape.

## Acceptance

- Domain events are company-scoped and actor-scoped.
- Event append supports command id, correlation id, causation id, idempotency key, payload, metadata, and version.
- Projector state can record checkpoint, last processed event, failures, and timestamps.

</wave>

<wave id="2" name="Server Event Service">

## Tasks

1. Add `server/src/services/rt2-domain-events.ts`.
2. Implement append with idempotency handling.
3. Implement projector processing helpers with processed-event uniqueness.
4. Implement an activity/live bridge projector for RT2 events.
5. Export the service.
6. Add service tests for append, duplicate idempotency, successful projector processing, and failed projector recording.

## Acceptance

- Duplicate idempotency keys return the existing event instead of creating a second event.
- Projectors do not re-run for the same event once processed.
- Projection failure is recorded without deleting the source event.

</wave>

<wave id="3" name="RT2 Mutation Integration">

## Tasks

1. Integrate event append into `rt2TaskEngineService` for task, todo, participant, capacity, and todo-start writes.
2. Integrate event append into `rt2TaskExecutionService` for enqueue, claim, start, complete, fail, and retry.
3. Preserve route-level access checks and current response contracts.
4. Replace or mirror route-level live-event publishing through the event bridge where practical.
5. Update route/service tests for event append behavior and event provenance.

## Acceptance

- Existing RT2 mutation routes still work.
- Each meaningful RT2 mutation appends a durable RT2 event.
- Events include company id, actor id, entity id, event type, and enough payload to replay simple read model updates.
- Company access checks remain in place.

</wave>

<verification>

Run:
- `pnpm exec vitest run packages/shared/src/rt2-domain-events.test.ts server/src/__tests__/rt2-domain-events.test.ts server/src/__tests__/rt2-task-routes.test.ts`
- `pnpm -r typecheck`
- `pnpm test:run` if targeted tests and typecheck pass

</verification>

<threat_model>

## Assets
- Company-scoped RT2 business events
- Activity/audit provenance
- Projector checkpoint state
- Derived read models

## Threats and Mitigations
- Cross-company event leakage: event append requires company id from already-authorized service context; tests assert company scoping.
- Duplicate rewards or approvals on replay: projector processed-event uniqueness prevents duplicate projector side effects.
- Event spoofing by route payload: event types and payloads are server-selected for RT2 mutation services, not blindly accepted from clients.
- Loss of audit traceability: activity bridge records originating event id in details.

</threat_model>
