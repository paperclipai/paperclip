# Staff Engineer — Final Structural Verification: M2 Async Conversion (VOY-1493)

**Date:** 2026-08-21 ~01:50 UTC
**Branch:** `fix/m-series-tech-debt` (shipped via `9949b6dfcb`)
**Scope:** Independent code-level verification that all findings from two prior reviews are closed in the shipped code on `master`.

## Background

Two prior reviews identified structural issues:

1. **`doc/review/2026-08-20-fix-m-series-tech-debt-review.md`** — 2 BLOCKERs, 2 HIGH, 2 MEDIUM, 1 LOW
2. **`doc/review/m2-structural-audit.md`** — 1 CRITICAL, 1 HIGH, 4 MEDIUM, 4 LOW

A subsequent hotfix (`9949b6dfcb` + P0/P1 fixes) addressed the post-ship findings. This document confirms all items at the code level against `master` (commit `20def84d98`).

## Verification matrix

### Review 1 findings (2026-08-20-fix-m-series-tech-debt-review.md)

| # | Finding | Severity | Status | Code evidence |
|---|---------|----------|--------|---------------|
| 1 | No worker → jobs never progress | BLOCKER | **CLOSED** | `server/src/services/background-job-worker.ts` exists with processors for all 5 job types; wired in `app.ts:475-476` — `createBackgroundJobWorker(db).start()` |
| 2 | SSE `/events` route shadowed by `/:id` | BLOCKER | **CLOSED** | `/events` registered at `background-jobs.ts:46` before `/:id` at `:77`; comment at `:44` explains ordering requirement |
| 3 | `prepare: false` without justification | HIGH | **CLOSED** | `packages/db/src/client.ts:51-67` — detailed comment documents prepared-statement name collision class with savepoints and row locks |
| 4 | Company templates all-or-nothing | HIGH | **DOCUMENTED ACCEPTANCE** | `company-templates.ts:8-12` — intentional M-1 behavioral change, atomic transaction with rollback cleanup; catalog skill flakiness risk accepted per VOY-1403 requirement |
| 5 | `sanitizeErrorForTelemetry` mutates in place | MEDIUM | **CLOSED** | Commit `3ca5a7ef44` — clones error for telemetry; original untouched |
| 6 | No tests for background-jobs/research | MEDIUM | **CLOSED** | `background-jobs-service.test.ts` (467 lines, 15 tests), `research-search-service.test.ts` (261 lines, 9 tests) |
| 7 | Notifications TDZ crash | OK | **CLOSED** | Declaration order fixed in original implementation |
| 8 | Missing DB constraints | LOW | **CLOSED** | Migration `0144_background_jobs.sql` + schema: `statusCheck` (line 71), `progressCheck` (line 72), `durationCheck` (line 73) |

### Review 2 findings (m2-structural-audit.md)

| # | Finding | Severity | Status | Code evidence |
|---|---------|----------|--------|---------------|
| 1 | `FOR UPDATE SKIP LOCKED` not in transaction | **CRITICAL** | **CLOSED** | `worker.ts:210-243` — claim + status update wrapped in `db.transaction()`; comment at `:202-209` explains the criticality |
| 2 | `candidateIds` never reaches `upgradeSemanticResults` | **HIGH** | **CLOSED** | `worker.ts:76-81` — extracts and passes `candidateIds`; `research-search.ts:359-368` — uses them to scope candidate pool via `fetchXxxByIds` |
| 3 | No processor timeout | MEDIUM | **CLOSED** | `worker.ts:275-298` — `Promise.race` with `processorTimeoutMs` (default 5 min) |
| 4 | No index for `status='queued'` | MEDIUM | **CLOSED** | `background_jobs.ts:70` — partial index `queuedStatusIdx`; migration `0144` line 24 |
| 5 | Abandoned in-flight jobs on shutdown | MEDIUM | **CLOSED** | `worker.ts:439-459` — `shutdown(gracePeriodMs)` awaits in-flight; `app.ts:590` — calls `shutdown(30_000)` |
| 6 | No retry for transient failures | MEDIUM | **CLOSED** | `worker.ts:300-335` — retry loop (max 2) with exponential backoff (1s, 2s, max 30s) |
| 7 | SSE `/events` skips `assertCompanyScopeReadAllowed` | LOW | **CLOSED** | `background-jobs.ts:50` — scope check added |
| 8 | Export payload size not bounded | LOW | **CLOSED** | `exports.ts:38` — `assertPayloadSize(512KB)`; schema maxes: `.max(500)` on arrays, `.max(200)` on strings |
| 9 | `autoAssess(itemIds)` path untested | LOW | **P2 BACKLOG** | Test covers default/freshness/empty paths; `itemIds` branch untested. Accepted as P2. |
| 10 | `escape-probe.test.ts` is a no-op | LOW | **CLOSED** | Now has 4 real assertions: `standard_conforming_strings=on`, LIKE ESCAPE literal underscore, escapeLikePattern simulation, rejection of non-matching |

## Post-ship additions (beyond original reviews)

| Feature | File | Purpose |
|---------|------|---------|
| Stale-job recovery startup sweep | `worker.ts:349-400` | Requeues jobs stuck in `running` > processorTimeoutMs + 30s — covers worker crash orphaned claims |
| Status guard in `update()` | `background-jobs.ts:148-152` | WHERE clause restricts mutations to `queued`/`running` — terminal statuses are immutable; closes the duplicate-execution cascade |
| `result.dataUri` stripping | `background-jobs.ts:27-32` | `toApi(row, slim)` strips base64 from list responses; full result available via `getById` |
| Graceful `shutdown()` | `worker.ts:439-459` | Awaits in-flight with timeout; logged if abandoned |
| DB health watchdog | `db-health-watchdog.ts` | Periodic health check with recovery |
| Timeout centralization | `timeout.ts` | Shared timeout middleware |
| PG client hardening | `client.ts` | `prepare: false` with documented rationale |

## Remaining P2 backlog (documented acceptance)

1. `tick()` in-flight race can exceed `batchSize` — pre-reserve capacity before claim
2. Missing test coverage for retry/timeout/emit-failure failure paths
3. Arbitrary `jobType` accepted by create routes — validate against `BACKGROUND_JOB_TYPES`
4. Result blob storage (S3) to replace base64-in-DB for large exports

## Working-tree notes (not part of branch)

The following working-tree changes exist but are NOT part of the M-series branch:

- `server/src/app.ts` — modified with `+knowledgeStarterPackRoutes` (uncommitted, separate workstream)
- `server/src/__tests__/company-templates-e2e.ts` — untracked scratch verification script
- `server/src/__tests__/company-templates-verify.ts` — untracked scratch verification script
- `server/src/__tests__/test-tx-basic.ts` — untracked scratch debug file
- `server/src/__tests__/test-tx-minimal.ts` — untracked scratch debug file

These should be committed or cleaned up by the owner before they cause confusion.

## Disposition

**All structural findings from both review rounds are CLOSED in the shipped code.** The M-series async conversion (VOY-1493) passes structural audit. The board is clear — no open review items assigned to Staff Engineer.

**Verdict: APPROVED.** No further review action required. Standing by for next branch submission or CTO routing.