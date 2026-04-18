# Control Plane Runtime Integrity Cleanup Implementation Plan

Status: implemented

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop the control plane from creating or preserving stale runtime state so queue views, company pause/archive behavior, and issue execution ownership all reflect live reality.

**Architecture:** Prevent new drift at the source inside the existing heartbeat control loop and company lifecycle routes, then add a small cross-table runtime-integrity service that reconciles wakeups, runs, and issue ownership from authoritative run state. Use that service both automatically at startup and manually through a one-off cleanup script so historical bad rows are repaired without hand-editing the database.

**Tech Stack:** TypeScript, Express services, Drizzle ORM, embedded Postgres tests, Vitest

---

## Scope Check

Do not include adapter/model tuning, recovery-ranking changes, or UI redesign in this slice. This plan is only for control-plane correctness:

- timer scheduling should not generate avoidable skip-noise
- company archive/pause transitions should drain runnable work consistently
- `agent_wakeup_requests` should not remain non-terminal after their linked `heartbeat_runs` are terminal
- `issues.status = in_progress` should not survive with broken execution ownership

## Working Rules

- Use `@test-driven-development` on every task.
- Use `@verification-before-completion` before claiming the slice is done.
- No DB migration is needed.
- Prefer a focused helper service over growing `server/src/services/heartbeat.ts` further.
- Treat the historical April 10 drift as data to reconcile through code, not as a one-off SQL-only exception.
- Keep rollout safe: prevent new drift first, add reconciliation second, run cleanup third.

## File Structure

### Runtime Control Loop

- Modify `server/src/services/heartbeat.ts`
  - prefilter timer candidates before enqueueing wakeups for archived or paused companies
  - expose a `reconcileRuntimeIntegrity()` method that delegates to the helper service
  - keep `resumeQueuedRuns()` focused on live queue recovery after reconciliation is done
- Modify `server/src/routes/companies.ts`
  - make archive reuse the same scope-cancellation flow that pause already uses
- Modify `server/src/index.ts`
  - run runtime reconciliation before `resumeQueuedRuns()` during startup

### New Integrity Service

- Create `server/src/services/runtime-integrity.ts`
  - reconcile terminal `heartbeat_runs` to `agent_wakeup_requests`
  - cancel stranded queued runs that now belong to paused or archived company scope
  - repair broken `issues.status = in_progress` ownership rows
  - return a summary object for logs, tests, and script output

### Cleanup Tooling

- Create `scripts/reconcile-heartbeat-runtime-state.ts`
  - dry-run by default
  - `--apply` to persist fixes
  - optional `--company <name-or-id>` to scope local cleanup during debugging
- Modify `package.json`
  - add a named script entry for the cleanup tool

### Tests

- Modify `server/src/__tests__/heartbeat-company-status.test.ts`
- Modify `server/src/__tests__/company-pause-resume-route.test.ts`
- Create `server/src/__tests__/runtime-integrity.test.ts`

### Docs

- Modify `doc/SPEC-implementation.md`
- Modify `docs/agents-runtime.md`
- Modify `doc/DEVELOPING.md`

## Normalization Policy

### Wakeup Status

When a wakeup request has a linked run, the run owns terminal truth:

- run `succeeded` -> wakeup `completed`
- run `failed` or `timed_out` -> wakeup `failed`
- run `cancelled` -> wakeup `cancelled`

This reconciliation only applies when the wakeup is still non-terminal (`queued`, `claimed`, or `deferred_issue_execution`) and the linked run is already terminal.

### Broken `in_progress` Issues

For issues marked `in_progress`:

1. if both ownership fields point to a live queued/running run, keep the issue as-is
2. if exactly one live run can be unambiguously rebound to the issue, repair the ownership fields
3. otherwise normalize the issue to `todo` and clear assignee / checkout / execution ownership fields

Do not guess `in_review`, `blocked`, or `done` during reconciliation. This slice is only about removing impossible `in_progress` state.

## Rollout Order

1. Prevent new scheduler and archive drift.
2. Add automatic reconciliation on startup.
3. Run one-off dry-run cleanup and inspect counts.
4. Apply cleanup.
5. Re-run verification queries and normal test suite.

---

### Task 1: Prevent New Scheduler And Archive Drift

**Files:**
- Modify: `server/src/__tests__/heartbeat-company-status.test.ts`
- Modify: `server/src/__tests__/company-pause-resume-route.test.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/routes/companies.ts`

- [ ] Add a failing heartbeat-company-status test proving `tickTimers()` does not create an `agent_wakeup_requests` skip row for an archived company.
- [ ] Add a failing heartbeat-company-status test proving `tickTimers()` does not create an `agent_wakeup_requests` skip row for a paused company.
- [ ] Add a failing company-routes test proving `POST /api/companies/:companyId/archive` calls `heartbeat.cancelExecutionScopeWork(...)` and logs the returned cancellation counts.
- [ ] Implement a batched company-status prefilter inside `tickTimers()` so archived and paused companies are skipped before `enqueueWakeup()` is called.
- [ ] Reuse the existing scope-cancellation flow on archive so queued and running work is drained immediately, matching pause semantics.

### Task 2: Add Runtime Reconciliation For Wakeups, Runs, And Broken Issue Ownership

**Files:**
- Create: `server/src/services/runtime-integrity.ts`
- Create: `server/src/__tests__/runtime-integrity.test.ts`
- Modify: `server/src/services/heartbeat.ts`
- Modify: `server/src/index.ts`

- [ ] Add a failing runtime-integrity test for a wakeup still marked `queued` after its linked run is `cancelled`.
- [ ] Add a failing runtime-integrity test for a wakeup still marked `queued` after its linked run is `succeeded`.
- [ ] Add a failing runtime-integrity test for a queued run that belongs to a paused or archived company and should be cancelled during reconciliation.
- [ ] Add a failing runtime-integrity test for an `in_progress` issue with null `checkout_run_id` / `execution_run_id` being normalized out of impossible state.
- [ ] Add a failing runtime-integrity test for an `in_progress` issue whose referenced run is missing or terminal.
- [ ] Implement `runtimeIntegrityService(db)` with focused helpers:
  - `reconcileWakeupStatuses()`
  - `cancelNonInvokableQueuedRuns()`
  - `repairBrokenInProgressIssues()`
  - `reconcileAll()` returning summary counts
- [ ] Expose `heartbeat.reconcileRuntimeIntegrity()` as a thin wrapper so startup and scripts can call the same code path.
- [ ] Call reconciliation in `server/src/index.ts` before `resumeQueuedRuns()` so startup heals historical drift before resuming live queue entries.

### Task 3: Build A Safe One-Off Cleanup Tool

**Files:**
- Create: `scripts/reconcile-heartbeat-runtime-state.ts`
- Modify: `package.json`
- Modify: `doc/DEVELOPING.md`

- [ ] Create a dry-run cleanup script that prints:
  - stale wakeup rows that would be terminalized
  - queued runs that would be cancelled because the company is paused or archived
  - broken `in_progress` issues that would be normalized
- [ ] Add `--apply` to persist those fixes.
- [ ] Add `--company` filtering for local debugging and incremental rollout.
- [ ] Add a package script entry such as `runtime:reconcile-heartbeat-state`.
- [ ] Document the backup-first workflow in `doc/DEVELOPING.md`, including `pnpm db:backup` before `--apply`.

### Task 4: Document The Runtime Contract

**Files:**
- Modify: `doc/SPEC-implementation.md`
- Modify: `docs/agents-runtime.md`

- [ ] Document that timer scheduling must short-circuit archived and paused company scope before enqueue.
- [ ] Document that pause and archive transitions drain queued/running scope work rather than leaving stranded runs behind.
- [ ] Document that wakeup rows are derived from linked run terminal state when reconciliation finds drift.
- [ ] Document that impossible `in_progress` issue ownership is normalized automatically rather than remaining silently broken.

### Task 5: Verify And Roll Out

**Files:**
- None

- [ ] Run targeted tests:

```bash
pnpm test:run -- \
  server/src/__tests__/heartbeat-company-status.test.ts \
  server/src/__tests__/company-pause-resume-route.test.ts \
  server/src/__tests__/runtime-integrity.test.ts
```

- [ ] Run compile checks:

```bash
pnpm --filter @paperclipai/server typecheck
pnpm build
```

- [ ] Run cleanup in dry-run mode first:

```bash
pnpm db:backup
pnpm runtime:reconcile-heartbeat-state -- --dry-run
```

- [ ] Apply cleanup only after the dry-run summary matches expectation:

```bash
pnpm runtime:reconcile-heartbeat-state -- --apply
```

- [ ] Confirm the key invariants with explicit queries:

```sql
select count(*) as stale_queued_wakeups
from agent_wakeup_requests awr
join heartbeat_runs hr on hr.id = awr.run_id
where awr.status = 'queued'
  and hr.status in ('cancelled', 'failed', 'succeeded', 'timed_out');
```

Expected: `0`

```sql
select c.name as company_name, count(*) as queued_runs
from heartbeat_runs hr
join companies c on c.id = hr.company_id
where hr.status = 'queued'
  and c.status in ('paused', 'archived')
group by 1;
```

Expected: no rows

```sql
select i.identifier, c.name as company_name
from issues i
join companies c on c.id = i.company_id
where i.status = 'in_progress'
  and (i.checkout_run_id is null or i.execution_run_id is null);
```

Expected: no rows

## Explicit Non-Goals

- Do not change adapter retry policy in this slice.
- Do not rebalance specialist concurrency in this slice.
- Do not redesign blocked-issue presentation in this slice unless a post-cleanup audit shows a still-live product bug.

## Implementation Summary

- `tickTimers()` now skips paused and archived companies before enqueue and keeps at most one outstanding timer wake per agent.
- Company archive now reuses scope cancellation so queued/running runs and deferred wakeups are drained consistently.
- Startup and periodic heartbeat recovery now run `reconcileRuntimeIntegrity()` before `resumeQueuedRuns()`.
- `runtimeIntegrityService` reconciles stale wakeups, queued runs blocked by company status, and broken `in_progress` issue ownership.
- `pnpm runtime-integrity:reconcile` provides dry-run/apply access to the same repair logic from `server/scripts/reconcile-heartbeat-runtime-state.ts`.

## Verification Snapshot

- `pnpm --filter @paperclipai/server typecheck`
- `pnpm exec vitest run server/src/__tests__/company-pause-resume-route.test.ts`
- `pnpm exec vitest run server/src/__tests__/runtime-integrity.test.ts`
- `pnpm exec vitest run server/src/__tests__/heartbeat-company-status.test.ts`

Note: embedded-Postgres-backed suites skip automatically on hosts where the embedded test database cannot initialize.
