# Phase 86: Work Entity Migration - Context

**Phase:** 86-work-entity-migration
**Status:** Ready for planning
**Mode:** Auto-generated (discuss skipped via workflow)

<domain>
## Phase Boundary

Work entity migration — RT2 event/projector 기반으로 work entity lifecycle을建模하고, 기존 legacy work 패턴을 migration한다.

Requirements: WORK-01 (event/projector based lifecycle + schema), WORK-02 (Task/Deliverable integrated), WORK-03 (migration preserves data + validated script)

</domain>

<decisions>
## Implementation Decisions

### Work Entity Design
- **D-01:** Work entity uses RT2 event sourcing — state changes emit domain events
- **D-02:** Work entity projector maintains read model for query/display
- **D-03:** Work entity ID references RT2 task/deliverable IDs for correlation

### Migration Strategy
- **D-04:** Legacy work records mapped to RT2 work entities via migration script
- **D-05:** No data deletion — migration creates new records, old records archived
- **D-06:** Migration idempotent — re-running produces same result

### State Machine
- **D-07:** Work entity states: `draft` → `active` → `completed` | `cancelled`
- **D-08:** State transitions emit corresponding domain events
- **D-09:** Task/Deliverable entities reference parent Work entity ID

### Agent's Discretion
- Exact migration batch size and timing
- Archive table naming convention
- Projection rebuild strategy

</decisions>

<code_context>
## Existing Code Insights

### Reusable Assets
- RT2 domain events in `packages/shared/src/types/rt2-domain-events.ts`
- Execution attempt schema in `packages/db/src/schema/rt2_v33_execution_attempts.ts`
- Event projector pattern from Phase 84 (RT2 event/projector layer)

### Established Patterns
- Event sourcing: domain events → projector → read model
- Migration script pattern: idempotent, batched, archived
- State machine: RT2 execution states as reference

### Integration Points
- RT2 task engine for work lifecycle
- RT2 execution service for work products
- Knowledge projector for work queries

</code_context>

<specifics>
## Specific Ideas

- Work entity schema: `id`, `companyId`, `taskIssueId`, `deliverableWorkProductId`, `state`, `createdAt`, `updatedAt`
- Migration: legacy `work_products` table → RT2 work entities
- Projector: materialized view for work queries with state filtering

</specifics>

<deferred>
## Deferred Ideas

- GraphQL work entity queries (future phase)
- Cross-company work federation (out of scope for v3.4)

</deferred>

---

*Phase: 86-work-entity-migration*