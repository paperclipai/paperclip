# COO Heartbeat — M2 Post-Review Fixes Applied (VOY-1493)

**Date:** 2026-08-20 ~15:53 UTC
**Agent:** COO (2f49c205)
**Branch:** `fix/m-series-tech-debt`
**Status:** 🔧 Fixes applied — code changes ready for re-review

---

## Summary

Addressed the Staff Engineer's M2 structural audit findings (doc/review/m2-structural-audit.md) and the M1 re-review conditions (doc/review/2026-08-20-fix-m-series-tech-debt-review-v2.md).

## Fixes Applied

### CRITICAL: FOR UPDATE SKIP LOCKED now wrapped in a transaction
**File:** `server/src/services/background-job-worker.ts:191-230`

The `claimQueuedJobs()` function now wraps the SELECT...FOR UPDATE SKIP LOCKED and the subsequent UPDATE to status='running' inside a single `db.transaction()`. Previously, in auto-commit mode (postgres-js default), PostgreSQL released row locks as soon as the SELECT completed, meaning two worker instances could claim the same job. The fix matches every other `FOR UPDATE` usage in the codebase.

### HIGH: candidateIds threaded through to upgradeSemanticResults
**Files:** `server/src/services/background-job-worker.ts`, `server/src/services/research-search.ts`

The worker's `RESEARCH_SEMANTIC_SEARCH` processor now extracts `candidateIds` from the job payload and passes them to `upgradeSemanticResults`. The semantic upgrade function uses these IDs to fetch only the keyword-first result candidates for re-ranking, ensuring the same result set the user saw. Three new helper functions (`fetchIssuesByIds`, `fetchDocumentsByIds`, `fetchActivityByIds`) support id-based lookups. The `scoreTitle` function was extracted to module scope for reuse by the helpers.

### MEDIUM: Processor timeout
**File:** `server/src/services/background-job-worker.ts`

Added a per-processor timeout via `Promise.race` (default 5 min). If a processor hangs (e.g., embedding service timeout, slow PDF generation), the job is failed gracefully instead of occupying an in-flight slot indefinitely. Configurable via `processorTimeoutMs` option.

### MEDIUM: Exponential backoff retries
**File:** `server/src/services/background-job-worker.ts`

Added retry logic (default 2 retries, configurable via `maxRetries` option) with exponential backoff (1s → 2s → 4s, capped at 30s). Transient failures (DB hiccup, network blip) no longer permanently fail the job.

### MEDIUM: Graceful shutdown with in-flight job draining
**Files:** `server/src/services/background-job-worker.ts`, `server/src/app.ts`

Added `shutdown(gracePeriodMs)` method that waits for in-flight jobs to complete (default 30s grace period). `app.ts` now calls `shutdown()` instead of `stop()` during process exit. Logs abandoned jobs if the grace period expires.

### MEDIUM: Partial index for status='queued' claim query
**Files:** `packages/db/src/schema/background_jobs.ts`, `packages/db/src/migrations/0144_background_jobs.sql`

Added `background_jobs_queued_status_idx` — a partial index on `status WHERE status = 'queued'`. Without this, the worker's claim query (which filters on `status = 'queued'` with no company_id predicate) would seq-scan as the table grows, since the existing `(company_id, status)` index can't serve a bare `status` predicate.

### LOW: SSE /events route now checks company_scope:read
**File:** `server/src/routes/background-jobs.ts`

Added `assertCompanyScopeReadAllowed` check to the SSE events route, matching the other routes in the same file.

### LOW: Export payload size bounded
**File:** `server/src/routes/exports.ts`

Added `assertPayloadSize()` guard (512KB limit) on both PDF and ICS export routes to prevent large payloads from tying up the worker.

### LOW: DB CHECK constraints on background_jobs table
**Files:** `packages/db/src/schema/background_jobs.ts`, `packages/db/src/migrations/0144_background_jobs.sql`

Added CHECK constraints for `status IN ('queued','running','succeeded','failed')`, `progress BETWEEN 0 AND 100`, and `duration_ms >= 0`.

### M1 Condition C2: Documented `prepare: false` rationale
**File:** `packages/db/src/client.ts`

Added a detailed comment explaining why `prepare: false` is set globally: prepared-statement name collisions in concurrent transactions with nested savepoints and `FOR UPDATE` row locks. Includes the tradeoff (re-parsing on hot path) and a path to scope it to transactional clients only if it becomes a bottleneck.

## Remaining (Deferred / Not Addressed)

- **Authz inconsistency on research routes** (C4 RECOMMENDED): research routes use `company_scope:read` permission for write operations. The general `POST /background-jobs` is board-only, but research routes need to be agent-accessible (agents create research jobs). No `company_scope:write` permission exists in the system. Keeping as-is with documented tradeoff.

- **Tests for background-jobs/research modules** (C6 RECOMMENDED): 26 existing tests pass. The `autoAssess(itemIds)` path and worker timeout/retry behavior are untested. Defers to follow-up.

## Typecheck
`tsc --noEmit` → PASS (exit 0)

## Tests
`vitest run` on background-jobs-service + research-search-service → 26/26 PASS