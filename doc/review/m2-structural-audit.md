## Staff Engineer Review: M2 Research Async Conversion (VOY-1493)

Reviewing commit `21e006a3d6` on branch `fix/m-series-tech-debt`. 40 files changed, +3750 lines. 12 backend/core files reviewed in depth (+1517 lines), plus UI components and tests.

---

### CRITICAL: Missing transaction — FOR UPDATE SKIP LOCKED is a no-op

**File:** `server/src/services/background-job-worker.ts:191-205`

The worker claims queued jobs with `FOR UPDATE SKIP LOCKED` but does **not** wrap this in a `db.transaction()`. In auto-commit mode (default for postgres-js), PostgreSQL releases the row locks as soon as the SELECT statement completes — before the subsequent UPDATE to `status = running`.

This means **two worker instances can claim and process the same job**. The comment on lines 18-21 explicitly claims this is safe, but it isn't.

Every other `FOR UPDATE` usage in the codebase (issues.ts, documents.ts, heartbeat.ts, board-auth.ts) wraps the select inside `db.transaction()`. The background-job-worker is the sole exception.

**Fix:** Wrap the claim + status update in a transaction. Then `processJob()` no longer needs its own status→running update.

---

### HIGH: `candidateIds` never reaches `upgradeSemanticResults`

**Files:** `server/src/routes/research.ts:123-127` → `server/src/services/background-job-worker.ts:63-71` → `server/src/services/research-search.ts:337-398`

The route creates the semantic search job with `candidateIds` in the payload (research.ts:127). The worker processor (worker.ts:71) does **not** extract or pass `candidateIds` to `upgradeSemanticResults`. And even if it did, `upgradeSemanticResults` (research-search.ts:350-355) ignores the field and re-runs `keywordSearch` from scratch.

The `candidateIds` property on `SemanticSearchPayload` is dead code end-to-end. The semantic upgrade may return a different result set than what the user saw in the synchronous keyword response, which undermines the UX contract.

**Fix:** Either (a) thread `candidateIds` through the worker to `upgradeSemanticResults` and use them to scope the candidate pool, or (b) remove the field from the route payload and type definition. Option (a) is the intended design.

---

### MEDIUM: No processor timeout — stuck jobs block the worker permanently

**File:** `server/src/services/background-job-worker.ts:207-260`

If a processor hangs (e.g., embedding service timeout, slow PDF generation), the job occupies an `inFlight` slot indefinitely. After one such hang, the worker stops accepting new work entirely (line 264: `if (inFlight >= batchSize) return`). No timeout mechanism exists.

**Fix:** Add a per-processor timeout (e.g., `Promise.race` with a 5-minute timeout) that fails the job gracefully.

---

### MEDIUM: No index for `status = 'queued'` query

**File:** `packages/db/src/schema/background_jobs.ts:56-64`

The worker's `claimQueuedJobs()` filters on `status = 'queued'` with no company_id filter. The only index that includes status is `(company_id, status)` — a leftmost-prefix B-tree index. PostgreSQL cannot use it for a bare `status` predicate; it requires `company_id` equality first. As the table grows, the claim query will seq-scan.

**Fix:** Add a partial index: `CREATE INDEX "background_jobs_status_idx" ON "background_jobs" ("status") WHERE status = 'queued';`

---

### MEDIUM: Abandoned in-flight jobs on shutdown

**File:** `server/src/app.ts:585-594`

`shutdownAppServices()` calls `backgroundJobWorker.stop()` which merely sets `stopped = true` and clears the interval. It does **not** await in-flight processors. On `process.once("exit")`, no async work completes.

**Fix:** Add a grace period that awaits in-flight jobs (with a timeout), then logs abandoned ones for a startup reaper.

---

### MEDIUM: No retry for transient failures

**File:** `server/src/services/background-job-worker.ts:249-259`

Any processor exception permanently fails the job — including transient errors (DB connection hiccup, embedding timeout, PDF disk-full). The job stays `"failed"` and requires manual intervention.

**Fix:** Consider exponential backoff retries (up to 3 attempts) or delegating retry to a higher-level scheduler.

---

### LOW: SSE /events route skips `assertCompanyScopeReadAllowed`

**File:** `server/src/routes/background-jobs.ts:46-70`

The SSE route calls `assertAuthenticated(req)` and `assertCompanyAccess(req, companyId)` but **not** `assertCompanyScopeReadAllowed`. Every other route in the same file calls it.

---

### LOW: Export payload size not bounded

**File:** `server/src/routes/exports.ts:10-28`

- `exportPdfSchema`: each item is `z.record(z.unknown())` — no size validation on individual items.
- `exportIcsSchema`: `description` capped at 2000 chars, but no total payload size check.

A large payload ties up the PDF worker (renders synchronously in-process) — exacerbating the missing-timeout issue.

---

### LOW: `autoAssess` `itemIds` code path is untested

**File:** `server/src/__tests__/research-search-service.test.ts:179-261`

The `autoAssess` tests cover default, freshness, and empty-company scenarios but never call `autoAssess` with `itemIds`. The `inArray` branch at research-search.ts:432 is exercised only by untested production code.

---

### LOW: `escape-probe.test.ts` is not a real test

**File:** `server/src/__tests__/escape-probe.test.ts`

This test prints values to console and asserts only that `standard_conforming_strings` is defined. It does not assert any LIKE ESCAPE pattern produces correct results. It passes trivially and provides no regression guard.

---

### Summary

| # | Severity | Area | Issue |
|---|----------|------|-------|
| 1 | **CRITICAL** | Worker concurrency | `FOR UPDATE SKIP LOCKED` not in a transaction → no-op for multi-instance safety |
| 2 | **HIGH** | Semantic search | `candidateIds` dead code end-to-end; upgrade may return different results |
| 3 | MEDIUM | Worker resilience | No processor timeout → stuck jobs block the worker permanently |
| 4 | MEDIUM | Performance | Missing `status` index → seq-scan on every claim tick |
| 5 | MEDIUM | Shutdown | In-flight jobs abandoned on `process.once("exit")` |
| 6 | MEDIUM | Reliability | No retry for transient processor failures |
| 7 | LOW | Authz consistency | SSE /events skips `assertCompanyScopeReadAllowed` |
| 8 | LOW | DOS surface | Export payload size not bounded |
| 9 | LOW | Test coverage | `autoAssess(itemIds)` path untested |
| 10 | LOW | Test quality | `escape-probe.test.ts` is a no-op |

**Verdict: Structural issues found (1 critical, 1 high). Ship blocked until item #1 is fixed. Items #2–#6 should be addressed before shipping but could be deferred to a follow-up if the CTO signs off.**

Routing to **CTO** for disposition on the critical and high items.
