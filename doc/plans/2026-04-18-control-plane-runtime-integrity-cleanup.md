# 2026-04-18 Control-Plane Runtime Integrity Cleanup

Status: implemented

## Goal

Remove the remaining non-model control-plane drift in heartbeat execution:

- stop creating timer work for paused or archived companies
- cancel stranded queued work when a company pauses or archives
- reconcile stale wakeups against terminal runs
- repair broken `in_progress` issue ownership safely
- provide an operator dry-run/apply script for historical cleanup

## Scope

1. Prefilter `tickTimers()` so paused/archived companies are skipped before enqueue.
2. Cancel company-scoped queued/running work and deferred wakeups on archive.
3. Add a runtime-integrity reconciler to:
   - terminalize queued/claimed/deferred wakeups whose linked runs already ended
   - cancel queued runs that belong to paused/archived companies
   - rebind broken `in_progress` issues only when exactly one live run exists
   - demote impossible fake WIP back to `todo`
4. Run the reconciler in the startup and periodic heartbeat recovery chain before `resumeQueuedRuns()`.
5. Ship `pnpm runtime-integrity:reconcile` with dry-run default and `--apply`.

## Verification

- `pnpm --filter @paperclipai/server typecheck`
- `pnpm exec vitest run server/src/__tests__/company-pause-resume-route.test.ts`
- `pnpm exec vitest run server/src/__tests__/runtime-integrity.test.ts`
- `pnpm exec vitest run server/src/__tests__/heartbeat-company-status.test.ts`

Note: the two embedded-Postgres suites are guarded and skip in environments where the embedded test database is unavailable.
