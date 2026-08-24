# Staff Engineer: M2 Post-Ship Structural Audit

**Reviewer:** Staff Engineer  
**Branch:** `fix/m-series-tech-debt`  
**Scope:** VOY-1493 M2 — research async conversion + process visibility  
**Date:** 2026-08-20  
**Status:** ⚠️ SHIPPED WITH UNFIXED P0/P1 ITEMS  

---

## Executive summary

The M2 implementation was reviewed in two passes. The first audit (`m2-structural-audit.md`) identified 1 CRITICAL + 1 HIGH + 4 MEDIUM + 4 LOW findings. These were addressed in commit `f81d572a40`:
- ✅ `FOR UPDATE SKIP LOCKED` wrapped in `db.transaction()`
- ✅ `candidateIds` threaded through worker to `upgradeSemanticResults`
- ✅ Per-processor timeout via `Promise.race`
- ✅ Partial index on `status = 'queued'`
- ✅ Graceful shutdown with in-flight draining
- ✅ Exponential backoff retries
- ✅ SSE `/events` route now checks `assertCompanyScopeReadAllowed`
- ✅ Export payload size capped at 512KB
- ✅ CHECK constraints on status, progress, duration_ms
- ✅ `prepare:false` rationale documented in `client.ts`
- ✅ Escape-probe test now contains real assertions

The second audit (`2026-08-20-fix-m-series-tech-debt-m2-review.md`) identified **4 new P0/P1 findings** — these were **NOT addressed** before the branch shipped to production.

---

## UNFIXED: P0 — `emitEvent` failure after DB commit causes retry to overwrite terminal status

### Location
`server/src/services/background-jobs.ts:46-64` — `emitEvent()` function

### Root cause
`emitEvent()` calls `publishLiveEvent()` directly without a try/catch. When an SSE subscriber throws (common on client disconnect — `res.write()` on a closed stream), `emitter.emit()` propagates the exception synchronously back through `publishLiveEvent()` → `emitEvent()` → `svc.update()` → `processJob()` retry loop.

### Concrete failure cascade
1. Processor succeeds → `svc.update({ status: "succeeded", result })` commits to DB.
2. `emitEvent(row)` calls `publishLiveEvent()` → `emitter.emit()` → SSE listener calls `res.write()` → **client disconnected → stream write throws**.
3. Exception propagates out of `svc.update()` → caught by retry loop as `lastError`.
4. Retry re-executes the processor.
5. On success, `svc.update({ status: "succeeded", result })` again — idempotent for PDF/ICS if produce same output, waste of compute.
6. **Worst case**: If `publishLiveEvent()` consistently throws (buggy subscriber), the retry loop exhausts (3 attempts) and marks the job **`failed`** — silently overwriting actual success.

### Fix required
```typescript
function emitEvent(row: typeof backgroundJobs.$inferSelect) {
  try {
    publishLiveEvent({ ... });
  } catch (err) {
    logger.error({ err, jobId: row.id }, "Failed to emit live event");
  }
}
```

Additionally, `svc.update()` should add a status guard to its WHERE clause to prevent overwriting terminal statuses:
```typescript
.where(and(
  eq(backgroundJobs.id, id),
  eq(backgroundJobs.companyId, companyId),
  sql`${backgroundJobs.status} IN ('queued', 'running')`,
))
```

### Risk in production
- Any background job whose SSE subscriber disconnects during the success write is at risk of being re-executed or incorrectly marked failed.
- Export PDF jobs are the most expensive (pdfkit rendering) and the most likely to have a client close the SSE connection mid-stream.

---

## UNFIXED: P0 — No stale-running recovery after crash → eternal spinner

### Location
`server/src/services/background-job-worker.ts`

### Root cause
When the server process crashes or is killed mid-job, the claimed job row stays `status = 'running'` permanently. The worker's claim query (`WHERE status = 'queued'`) ignores these orphans. There is:
- No `leaseExpiresAt` column on the `background_jobs` table
- No startup sweep that resets stale 'running' jobs back to 'queued'
- No periodic reaper that detects abandoned jobs

### Proof
The claim transaction sets `status = 'running'` inside a transaction. After commit, only `processJob()` can move the job to a terminal status. If the process dies after the claim commit but before `processJob` writes the terminal status, the job sits in 'running' forever. On restart, the worker never sees it.

### Fix required
Add a startup sweep in `createBackgroundJobWorker()` (inside `start()`) that requeues jobs that have been 'running' longer than the max expected execution time:

```typescript
const staleThreshold = new Date(Date.now() - (processorTimeoutMs + 30_000));
await db
  .update(backgroundJobs)
  .set({ status: 'queued', progress: 0, progressMessage: null, startedAt: null })
  .where(
    and(
      eq(backgroundJobs.status, 'running'),
      lt(backgroundJobs.startedAt, staleThreshold),
    ),
  );
```

### Risk in production
- A server crash during export PDF processing leaves the job spinning in the tray forever.
- User-visible: "running" spinner that never resolves.
- No automatic recovery path; manual intervention required to reset the status.

---

## UNFIXED: P1 — Large binary PDF results stored in DB; list endpoint returns full blobs

### Location
`server/src/services/background-job-worker.ts:157-172` (PDF processor stores base64 data-URI)  
`server/src/services/background-jobs.ts:84-99` (list endpoint returns full row including `result`)

### Problem
The PDF export processor stores the full base64-encoded PDF (potentially multiple MB) in the `result` jsonb column. The `list()` endpoint returns `result` for every row. Consequences:
- Each tray poll/SSE refresh fetches multi-MB responses.
- `background_jobs` table grows without bound (TOAST'd but still pulled on every list query).
- 512KB payload cap on the *request* does **not** cap the *result* — a small input can produce a large PDF.

The code comment acknowledges this: *"In production, upload pdfBuffer to blob storage (S3 etc.) and return a URL."*

### Fix options (in priority order)
1. **Strip `result.dataUri` from the list projection** — the tray only needs status/progress.
2. Add a dedicated `/background-jobs/:id/result` endpoint for retrieving large results.
3. Enforce a result size cap (~1MB) at the processor level.

### Risk in production
- Bandwidth amplification: tray polls every 5s × N jobs × multi-MB responses.
- Can be mitigated by keeping export PDFs small (few items, short text), but not enforceable.

---

## UNFIXED: P1 — `emailDeferredToDigest` ordering causes stale "pending" status

### Location
`server/src/services/notifications.ts:566-604`

### Problem
Lines 566-580 set `emailDeliveryStatus = "pending"` **before** the digest preference query (lines 588-604) determines whether the notification is deferred to digest. The guard `!emailDeferredToDigest` at line 569 always passes because `emailDeferredToDigest` is initialized to `false` and hasn't been set by the query yet.

Result: when a notification type uses email+digest, the DB record gets `emailDeliveryStatus = "pending"` and never transitions. The digest delivery itself is unaffected (`sentAt IS NULL` check), but the user-visible status field shows "pending" indefinitely.

### Fix
Move the digest preference query before the `initUpdates` block.

### Risk
- Cosmetic for most users, but the status field is confusing.
- Could trigger false-positive monitoring for "email stuck pending."

---

## P2 items (shipped, no immediate production impact)

### `tick()` in-flight race
`server/src/services/background-job-worker.ts:348-358` — The `await claimQueuedJobs()` yields the event loop between the inFlight guard check and the increment. Two overlapping ticks can each claim `batchSize` jobs, producing up to `2 × batchSize` concurrent jobs. `FOR UPDATE SKIP LOCKED` prevents double-claiming the same rows, but the concurrency ceiling is not strictly enforced.

### Arbitrary jobType accepted by generic create route
`server/src/routes/background-jobs.ts:96-112` — `POST /background-jobs` accepts any `jobType: z.string().min(1)`. Board users can enqueue export jobs with unbounded payloads, bypassing the `assertPayloadSize()` check that protects the export-specific routes. The worker fails unknown types with "No processor registered."

### Missing test coverage for failure paths
- Worker retry on transient error: not tested
- Processor timeout kills long-running job: not tested
- `emitEvent` failure → no retry cascade: not tested
- Stale-running requeue on startup: not implemented, let alone tested
- `upgradeSemanticResults` with empty candidateIds: not tested
- AutoAssess with specific `itemIds`: not tested
- LIKE escaping with special characters end-to-end: escape-probe tests PG behavior only

---

## Summary

| # | Finding | Severity | Status | File |
|---|---------|----------|--------|------|
| 1 | `emitEvent` not wrapped → retry can overwrite terminal status | **P0** | ⚠️ SHIPPED UNFIXED | background-jobs.ts |
| 2 | No stale-running recovery after crash | **P0** | ⚠️ SHIPPED UNFIXED | background-job-worker.ts |
| 3 | Large binary PDF stored in DB; list returns full result | **P1** | ⚠️ SHIPPED UNFIXED | background-job-worker.ts, background-jobs.ts |
| 4 | `emailDeferredToDigest` ordering → stale "pending" status | **P1** | ⚠️ SHIPPED UNFIXED | notifications.ts |
| 5 | `tick()` in-flight race exceeds batchSize ceiling | **P2** | Known, no fix | background-job-worker.ts |
| 6 | Arbitrary `jobType` accepted by generic create route | **P2** | Known, no fix | background-jobs route |
| 7 | Missing test coverage for failure paths | **P2** | Known, no fix | test files |

**Recommendation:**
- **Immediate hotfix** for items 1-4. Items 1 and 2 are 10-15 line changes each; item 3 is a projection change; item 4 is a reorder.
- **Track** items 5-7 for the next cycle.

**Routing:** This audit goes to the **CTO** for disposition and follow-up issue creation.