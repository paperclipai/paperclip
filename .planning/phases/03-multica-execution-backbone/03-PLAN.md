---
phase: 3
phase_name: Multica Execution Backbone
status: ready
requirements_addressed:
  - FOUND-01
  - FOUND-02
wave: 1
---

# Phase 3 Plan - Multica Execution Backbone

## Objective

Add the first RealTycoon2 execution lifecycle backbone by linking RT2 tasks and to-dos to company-scoped execution attempts with Multica-style states and visible runtime context.

## Scope

This plan implements one focused slice:

- DB schema for RT2 execution attempts
- shared lifecycle contracts and validators
- server service and API routes for enqueue, claim, start, complete, fail, and retry
- RT2 task detail/list execution summaries
- UI visibility in task list and task panel
- focused tests and typecheck

## Tasks

### T-03-01: Add Execution Attempt Persistence

Files:

- `packages/db/src/schema/rt2_v33_execution_attempts.ts`
- `packages/db/src/schema/index.ts`
- `packages/db/src/migrations/0068_rt2_v33_execution_attempts.sql`
- `packages/db/src/migrations/meta/_journal.json`

Acceptance:

- `rt2_v33_execution_attempts` stores company, task issue, optional todo issue, lifecycle state, executor, runtime links, timestamps, retry link, and metadata.
- Table has indexes for company/task/todo/state/latest access.

### T-03-02: Add Shared RT2 Execution Contracts

Files:

- `packages/shared/src/types/rt2-task.ts`
- `packages/shared/src/validators/rt2-task.ts`
- `packages/shared/src/rt2-task.test.ts`

Acceptance:

- Shared types expose `Rt2ExecutionState`, `Rt2ExecutionSummary`, and transition payloads.
- Validators reject invalid lifecycle transition payloads.

### T-03-03: Add Server Execution Service And Routes

Files:

- `server/src/services/rt2-task-execution.ts`
- `server/src/services/rt2-task-engine.ts`
- `server/src/services/index.ts`
- `server/src/routes/rt2-tasks.ts`
- `server/src/__tests__/rt2-task-routes.test.ts`

Acceptance:

- API supports enqueue, claim, start, complete, fail, and retry.
- Claiming an already claimed/running attempt returns conflict.
- Completion records whether a deliverable/work product was produced or explicitly missing.
- Task and to-do detail summaries include latest execution attempt.

### T-03-04: Show Execution State In RT2 UI

Files:

- `ui/src/api/rt2-tasks.ts`
- `ui/src/components/Rt2TaskPanel.tsx`
- `ui/src/components/Rt2TaskList.tsx`
- `ui/src/components/Rt2TaskPanel.test.tsx`

Acceptance:

- Task cards show latest execution lifecycle state.
- Task detail panel shows latest task execution and to-do execution states.
- UI copy uses RT2-facing execution language, not raw runtime internals.

### T-03-05: Verify

Commands:

```sh
pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2TaskPanel.test.tsx
pnpm -r typecheck
```

Run `pnpm test:run` only if targeted gates are green and time allows in the same chain.

## Threat Model

| ID | Threat | Surface | Mitigation |
|----|--------|---------|------------|
| T-03-01 | Duplicate execution | claim endpoint | Atomic state transition from `queued` only |
| T-03-02 | Cross-company mutation | execution routes | Load task meta and assert company access before mutation |
| T-03-03 | False completion | complete endpoint | Require work product link or explicit missing-deliverable flag |
| T-03-04 | Lost failure history | retry endpoint | Retry creates a new attempt linked to the failed attempt |

## Verification Gate

Phase 3 is complete when:

- lifecycle service tests pass through route coverage
- shared contract tests pass
- UI execution visibility test passes
- `pnpm -r typecheck` passes

