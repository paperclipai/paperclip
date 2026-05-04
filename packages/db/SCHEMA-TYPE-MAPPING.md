# RT2 Schema-to-Type Mapping

This document maps Drizzle ORM schemas in `packages/db/src/schema/` to TypeScript types in `packages/shared/src/types/`, documenting field-level alignment, type coercion, and intentional deviations.

## Overview

| Schema | Type | Status |
|--------|------|--------|
| `rt2V33DomainEvents` | `Rt2DomainEvent` | ✅ Aligned |
| `rt2V33ProjectorState` | N/A (internal projector state) | ✅ Aligned |
| `rt2V33ProjectorEvents` | N/A (internal projector events) | ✅ Aligned |
| `rt2V33ExecutionAttempts` | `Rt2ExecutionAttempt` (via `Rt2ExecutionSummary`) | ✅ Aligned |
| `rt2V33WorkEntities` | N/A (work entity type TBD) | ✅ Aligned (schema-only) |
| `rt2V33WorkEntitiesArchive` | N/A (migration archive) | ✅ Aligned (migration only) |
| `rt2V33WorkProjectorState` | N/A (internal projector state) | ✅ Aligned |

---

## rt2V33DomainEvents ↔ Rt2DomainEvent

**Schema file:** `packages/db/src/schema/rt2_v33_domain_events.ts`
**Type file:** `packages/shared/src/types/rt2-domain-events.ts`

| Schema Field | Schema Type | Type Field | TypeScript Type | Notes |
|---|---|---|---|---|
| `id` | `uuid` PK | `id` | `string` | UUID serialized as string |
| `companyId` | `uuid` FK→companies | `companyId` | `string` | UUID→string |
| `eventType` | `text` | `eventType` | `Rt2DomainEventType` | Union of event type literals |
| `eventVersion` | `integer` | `eventVersion` | `number` | Default 1 |
| `actorType` | `text` | `actorType` | `Rt2DomainEventActorType` | `"user"\|"agent"\|"system"\|"runtime"` |
| `actorId` | `text` | `actorId` | `string` | Opaque actor identifier |
| `entityType` | `text` | `entityType` | `Rt2DomainEventEntityType` | `"task"\|"todo"\|"participant"\|"deliverable"\|"execution"\|"work"` |
| `entityId` | `text` | `entityId` | `string` | Opaque entity identifier |
| `commandId` | `text` nullable | `commandId` | `string \| null` | Optional command correlation |
| `correlationId` | `text` nullable | `correlationId` | `string \| null` | Optional event correlation |
| `causationId` | `uuid` nullable | `causationId` | `string \| null` | UUID→string |
| `idempotencyKey` | `text` nullable | `idempotencyKey` | `string \| null` | Append-only event deduplication |
| `payload` | `jsonb` | `payload` | `Rt2DomainEventPayload` | `Record<string, unknown>` with known optional fields |
| `metadata` | `jsonb` | `metadata` | `Record<string, unknown>` | Open metadata bag |
| `occurredAt` | `timestamp` | `occurredAt` | `Date` | Event occurred time (UTC) |
| `createdAt` | `timestamp` | `createdAt` | `Date` | Record creation time |

### Constraints

| Constraint | Name | SQL |
|---|---|---|
| Check | `rt2_v33_domain_events_actor_type_check` | `actor_type in ('user', 'agent', 'system', 'runtime')` |
| Unique Index | `rt2_v33_domain_events_company_idempotency_uq` | `(company_id, idempotency_key)` WHERE `idempotency_key IS NOT NULL` |
| Index | `rt2_v33_domain_events_company_occurred_idx` | `(company_id, occurred_at)` |
| Index | `rt2_v33_domain_events_company_type_occurred_idx` | `(company_id, event_type, occurred_at)` |
| Index | `rt2_v33_domain_events_entity_idx` | `(company_id, entity_type, entity_id)` |

### Intentional Deviations

- `payload` is typed as `Rt2DomainEventPayload` with known optional fields but allows `[key: string]: unknown` for forward compatibility with new event types.

---

## rt2V33ProjectorState (internal projector state)

**Schema file:** `packages/db/src/schema/rt2_v33_domain_events.ts`

| Schema Field | Schema Type | Notes |
|---|---|---|
| `projectorName` | `text` PK | Projector identifier |
| `status` | `text` | `"idle"\|"running"\|"failed"` — enforced by check |
| `lastEventId` | `uuid` nullable | Last processed event ID |
| `lastProcessedAt` | `timestamp` nullable | Last processing timestamp |
| `failureCount` | `integer` | Consecutive failure count |
| `lastError` | `text` nullable | Last error message |
| `metadata` | `jsonb` | Projector-specific metadata |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

### Constraints

| Constraint | Name | SQL |
|---|---|---|
| Check | `rt2_v33_projector_state_status_check` | `status in ('idle', 'running', 'failed')` |

---

## rt2V33ProjectorEvents (internal projector event log)

**Schema file:** `packages/db/src/schema/rt2_v33_domain_events.ts`

| Schema Field | Schema Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `projectorName` | `text` | Projector this event was processed by |
| `eventId` | `uuid` FK→rt2V33DomainEvents | The domain event |
| `status` | `text` | `"processed"\|"failed"` — enforced by check |
| `error` | `text` nullable | Error message if failed |
| `processedAt` | `timestamp` | |

### Constraints

| Constraint | Name | SQL |
|---|---|---|
| Check | `rt2_v33_projector_events_status_check` | `status in ('processed', 'failed')` |
| Unique Index | `rt2_v33_projector_events_projector_event_uq` | `(projector_name, event_id)` |
| Index | `rt2_v33_projector_events_event_idx` | `(event_id)` |

---

## rt2V33ExecutionAttempts ↔ Rt2ExecutionSummary / Rt2ExecutionState

**Schema file:** `packages/db/src/schema/rt2_v33_execution_attempts.ts`
**Type file:** `packages/shared/src/types/rt2-task.ts`

| Schema Field | Schema Type | Type Field | TypeScript Type | Notes |
|---|---|---|---|---|
| `id` | `uuid` PK | `id` | `string` | |
| `companyId` | `uuid` FK→companies | (via service layer) | `string` | |
| `taskIssueId` | `uuid` FK→issues | `taskIssueId` | `string` | |
| `todoIssueId` | `uuid` FK→issues nullable | `todoIssueId` | `string \| null` | Optional sub-task |
| `deliverableWorkProductId` | `uuid` FK→issueWorkProducts nullable | `deliverableWorkProductId` | `string \| null` | |
| `resultWorkProductId` | `uuid` FK→issueWorkProducts nullable | `resultWorkProductId` | `string \| null` | |
| `retryOfAttemptId` | `uuid` FK→rt2V33ExecutionAttempts nullable | `retryOfAttemptId` | `string \| null` | |
| `state` | `text` | `state` | `Rt2ExecutionState` | `"queued"\|"dispatched"\|"claimed"\|"running"\|"completed"\|"failed"\|"cancelled"\|"blocked"` |
| `executorType` | `text` nullable | `executorType` | `Rt2ExecutionExecutorType \| null` | `"user"\|"jarvis"\|"runtime"` |
| `executorId` | `text` nullable | `executorId` | `string \| null` | |
| `executionWorkspaceId` | `uuid` FK→executionWorkspaces nullable | `executionWorkspaceId` | `string \| null` | |
| `runtimeServiceId` | `uuid` FK→workspaceRuntimeServices nullable | `runtimeServiceId` | `string \| null` | |
| `heartbeatRunId` | `uuid` FK→heartbeatRuns nullable | `heartbeatRunId` | `string \| null` | |
| `failureReason` | `text` nullable | `failureReason` | `string \| null` | |
| `missingDeliverableReason` | `text` nullable | `missingDeliverableReason` | `string \| null` | |
| `metadata` | `jsonb` nullable | (not in summary) | `Record<string, unknown> \| null` | Extended metadata |
| `queuedByUserId` | `text` | (via service layer) | `string` | Who enqueued |
| `queuedAt` | `timestamp` | `queuedAt` | `Date` | |
| `claimedAt` | `timestamp` nullable | `claimedAt` | `Date \| null` | |
| `startedAt` | `timestamp` nullable | `startedAt` | `Date \| null` | |
| `completedAt` | `timestamp` nullable | `completedAt` | `Date \| null` | |
| `createdAt` | `timestamp` | (internal) | `Date` | |
| `updatedAt` | `timestamp` | `updatedAt` | `Date` | |

### Constraints

| Constraint | Name | SQL |
|---|---|---|
| Check | `rt2_v33_execution_attempts_state_check` | `state in ('queued','dispatched','claimed','running','completed','failed','cancelled','blocked')` |
| Check | `rt2_v33_execution_attempts_executor_type_check` | `executor_type is null or executor_type in ('user', 'jarvis', 'runtime')` |
| Index | `rt2_v33_execution_attempts_task_updated_idx` | `(task_issue_id, updated_at)` |
| Index | `rt2_v33_execution_attempts_todo_updated_idx` | `(todo_issue_id, updated_at)` |
| Index | `rt2_v33_execution_attempts_company_state_idx` | `(company_id, state, updated_at)` |

### Type Coercion Notes

- All `uuid` columns map to TypeScript `string`
- All `timestamp with time zone` columns map to TypeScript `Date`
- `jsonb` maps to `Record<string, unknown>` or more specific types where defined

---

## rt2V33WorkEntities

**Schema file:** `packages/db/src/schema/rt2_v33_work_entities.ts`

Work entity is a new RT2 pattern linking Task + Deliverable as a single work unit.

| Schema Field | Schema Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `companyId` | `uuid` FK→companies | |
| `taskIssueId` | `uuid` FK→issues nullable | Optional link to task |
| `deliverableWorkProductId` | `uuid` FK→issueWorkProducts nullable | Optional link to deliverable |
| `state` | `text` | `"draft"\|"active"\|"completed"\|"cancelled"` — enforced by check |
| `archivedAt` | `timestamp` nullable | Soft-delete/archive timestamp |
| `legacySourceId` | `uuid` nullable | Migration reference to old work_products.id |
| `createdAt` | `timestamp` | |
| `updatedAt` | `timestamp` | |

### Constraints

| Constraint | Name | SQL |
|---|---|---|
| Check | `rt2_v33_work_entities_state_check` | `state in ('draft', 'active', 'completed', 'cancelled')` |
| Unique Index | `rt2_v33_work_entities_company_task_delivery_uq` | `(company_id, task_issue_id, deliverable_work_product_id)` WHERE both NOT NULL |

### Type Notes

No dedicated TypeScript type exists yet for work entities. A `Rt2WorkEntity` type should be added when the work entity service layer is implemented.

---

## rt2V33WorkEntitiesArchive

**Schema file:** `packages/db/src/schema/rt2_v33_work_entities.ts`

Migration archive table — stores pre-migration state of work entities.

| Schema Field | Schema Type | Notes |
|---|---|---|
| `id` | `uuid` PK | Original ID preserved |
| `companyId` | `uuid` | Denormalized for archive |
| `taskIssueId` | `uuid` nullable | |
| `deliverableWorkProductId` | `uuid` nullable | |
| `state` | `text` | Archived state |
| `archivedAt` | `timestamp` nullable | |
| `legacySourceId` | `uuid` nullable | |
| `createdAt` | `timestamp` | Original creation time |
| `updatedAt` | `timestamp` | Original update time |
| `migrationBatchId` | `text` | Migration run identifier |
| `migratedAt` | `timestamp` | When archive was created |

### Type Notes

No TypeScript type — this is a migration artifact only.

---

## rt2V33WorkProjectorState

**Schema file:** `packages/db/src/schema/rt2_v33_work_projector_state.ts`

| Schema Field | Schema Type | Notes |
|---|---|---|
| `projectorName` | `text` PK | `"work_entity_projector"` |
| `status` | `text` | `"idle"\|"running"\|"failed"` — enforced by check |
| `lastEventId` | `uuid` nullable | |
| `lastProcessedAt` | `timestamp` nullable | |
| `failureCount` | `integer` | |
| `lastError` | `text` nullable | |
| `metadata` | `jsonb` | |

### Constraints

| Constraint | Name | SQL |
|---|---|---|
| Check | `rt2_v33_work_projector_state_status_check` | `status in ('idle', 'running', 'failed')` |

### Type Notes

Internal projector state — no TypeScript type exported to packages/shared.

---

## Version History

| Version | Date | Changes |
|---------|------|---------|
| 1.0 | 2026-05-04 | Initial mapping — Phase 87 schema validation |

## Maintenance Policy

When modifying a schema or type:
1. Update this document within the same PR as the schema/type change
2. Run `pnpm typecheck` to catch any drift
3. Add a migration entry if schema changed
4. Update `packages/db/MIGRATION_POLICY.md` if migration structure changed
