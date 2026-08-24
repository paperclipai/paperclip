# Staff Engineer Re-Review: `fix/m-series-tech-debt` (M2 Implementation)

**Reviewer:** Staff Engineer
**Branch:** `fix/m-series-tech-debt`
**Date:** 2026-08-20 (M2 review pass)
**Base:** `master`
**Scope:** VOY-1493 M2 — research async conversion + process visibility (background-job-worker, research-search, UI tray, exports)
**Status:** ⏳ MUST FIX before shipping — 4 P0/P1 items

---

## Executive summary

The M2 implementation is structurally more complete than M1: the worker loop exists, the SSE pipeline is wired, the UI tray renders, and tests cover the happy paths. However, two critical invariants are broken in the background-job service, and two more structural gaps will cause production pain:

| # | Finding | Severity | File |
|---|---------|----------|------|
| 1 | Event emission after DB commit → duplicate execution on retry | **P0** | background-jobs.ts |
| 2 | No stale-job recovery after crash → permanent spinning in tray | **P0** | background-job-worker.ts |
| 3 | Large binary PDF/ICS results in DB → list endpoint returns unbounded payloads | **P1** | background-job-worker.ts |
| 4 | notification.ts digest-deferred email stuck in "pending" status | **P1** | notifications.ts |

Items 1-2 **must be fixed before shipping**. Items 3-4 are structural risks that should be fixed or documented with an explicit tradeoff.

In addition, I verified the M1 review conditions: C2 (prepare:false rationale) is now documented, C3 (M2 tracked) is committed, and the SSE authz fix from the earlier review is applied. Good.

---

## P0 — Event emission after DB commit allows duplicate execution (broken invariant)

**File:** `server/src/services/background-jobs.ts` — `create()` line 80-81, `update()` line 128-129

### Problem

Both `create()` and `update()` call `emitEvent(row)` *after* the database mutation has committed. If `publishLiveEvent()` throws (EventEmitter exhaustion, serialization failure, future wiring change), the caller sees an error and the worker's retry loop re-enters.

The specific failure cascade for `update()` when called from `processJob()` success path:

1. DB row is updated to `status = 'succeeded'` and committed.
2. `emitEvent(row)` throws.
3. The retry loop in `background-job-worker.ts` (line 319-333) catches the error as a `lastError`.
4. Next retry attempt: `svc.update()` at line 260 sets `status = 'running'` — **overwriting the committed 'succeeded'**.
5. The `svc.update()` has NO status guard — any status can be overwritten.
6. The processor re-executes. For EXPORT_PDF/EXPORT_ICS processors, this produces duplicate files.
7. If the second execution also has `emitEvent` fail, the pattern repeats.

For `create()`:
- Job row is committed as 'queued'. `emitEvent` throws.
- The HTTP response to the caller was `202 { jobId }` — but the caller's JS console sees the rejection.
- The UI tray never receives the initial event, so the job is invisible until the SSE connection drops and the polling fallback picks it up.

### Root cause

`emitEvent` is inside `create()`/`update()`, mixed into the same promise chain as the DB mutation. It should be fire-and-forget or, at minimum, guarded so a failure can't trigger retry.

### Fix required

**Fix `background-jobs.ts` — `emitEvent` must not throw:**

```typescript
function emitEvent(row: typeof backgroundJobs.$inferSelect) {
  try {
    publishLiveEvent({
      companyId: row.companyId,
      type: "background_job.status",
      payload: { /* ... */ },
    });
  } catch (err) {
    logger.error({ err, jobId: row.id }, "Failed to emit background_job.status live event; state divergence possible");
  }
}
```

**Fix `background-jobs.ts` — `update()` must refuse to overwrite terminal statuses:**

Add a WHERE clause condition that prevents `update()` from touching a job that has reached a terminal status. The worker should never need to re-enter a terminal job — if it does, that's a programming error:

```typescript
// In the update WHERE clause, add:
// Only allow status transitions from non-terminal states
where(
  and(
    eq(backgroundJobs.id, id),
    eq(backgroundJobs.companyId, companyId),
    sql`${backgroundJobs.status} IN ('queued', 'running')`,
  ),
)
```

The `create()` function also needs the `emitEvent` try/catch — losing the initial event means the UI never sees the job until polling wakes up.

---

## P0 — Stale-'running' recovery: after a crash, jobs spin forever

**File:** `server/src/services/background-job-worker.ts`

### Problem

When the server process is killed or crashes mid-job, the claimed job row stays `status = 'running'` permanently. There is:

- No `leaseExpiresAt` column on the `background_jobs` table
- No startup sweep that resets stale 'running' jobs back to 'queued'
- No periodic reaper that detects abandoned jobs
- The job never transitions to `failed` and is never retried
- The UI tray shows an eternal spinner for that job

This affects export jobs (PDF/ICS) with real work. For research/semantic jobs the impact is mild (no external side effects), but the user sees a broken spinner.

### Proof

The claim transaction at lines 209-242 sets `status = 'running'` and releases the row lock. After that, only `processJob()` can move the job to a terminal status. If the process dies after the claim commit but before `processJob` writes the terminal status, the job sits in 'running' forever. On restart, the worker's claim query only selects `WHERE status = 'queued'`, so it ignores the orphan.

### Fix required

1. **Startup sweep** in `createBackgroundJobWorker()` (or in `start()`) that resets jobs in 'running' state that were started more than N minutes ago back to 'queued' so they can be claimed again. The `startedAt` column exists and is set during the claim transaction.

   ```typescript
   // On startup, requeue any job that has been 'running' longer than
   // our max expected execution time + grace period
   const staleThreshold = new Date(Date.now() - (processorTimeoutMs + 30_000));
   await db
     .update(backgroundJobs)
     .set({ status: 'queued', progress: 0, progressMessage: null, startedAt: null })
     .where(
       and(
         eq(backgroundJobs.status, 'running'),
         lt(backgroundJobs.startedAt ?? new Date(0), staleThreshold),
       ),
     );
   ```

2. **Alternative/future:** Add a `leaseExpiresAt` column and require the worker to bump it periodically; a reaper sweeps expired leases.

3. **Low-cost immediate improvement:** Document that crash during job processing does not auto-retry and add a manual "retry" endpoint (or leverage the existing ability to create a new job with the same payload).

---

## P1 — Large binary results stored in DB; list endpoint returns them unprojected

**File:** `server/src/services/background-job-worker.ts` (PDF export, line 162-169)

### Problem

The PDF export processor stores the full base64 data-URI in the `result` jsonb column:

```typescript
dataUri: `data:application/pdf;base64,${base64}`,
```

A single PDF can be several megabytes of base64 text. The `list()` endpoint (used by the `BackgroundProcessTray` on every poll/SSE event) returns ALL job rows including their full `result` column. Consequences:

- The tray refresh fetches multi-MB responses every ~5 seconds, hammering the API and bandwidth.
- The `background_jobs` table grows without bound — `result` is a jsonb column that gets TOAST'd but every list query pulls it.
- The 512KB payload cap on the *request* (in `exports.ts`) does not cap the *result*.

The code comment at line 159-161 acknowledges this: *"In production, upload pdfBuffer to blob storage (S3 etc.) and return a URL."* Yet the current code ships to prod with the base64-in-DB path.

### Fix required before shipping to production

Either:
- **(Recommended)** Strip the `result.dataUri` field from the list projection. Return a dedicated endpoint for result retrieval. The `BackgroundProcessTray` doesn't need the data URI — it only shows status/progress.
- Or enforce a result size cap (e.g., 1MB) at the processor level and fail jobs that exceed it.
- Or implement the blob-storage path that the comment itself says is needed.

At **minimum**: The `list()` function in `background-jobs.ts` should not return `result` for rows where the result is a large binary. Add a flag or projection.

---

## P1 — `emailDeferredToDigest` ordering causes stale "pending" status

**File:** `server/src/services/notifications.ts`, lines 566-604

### Problem

The `initUpdates` block (lines 568-580) sets `emailDeliveryStatus = "pending"` before the digest preference query runs (lines 588-604). The guard `!emailDeferredToDigest` is always true at that point because the variable is initialized to `false` and the digest query hasn't executed yet.

Result: when email is in `channels` AND the user has a digest preference for that notification type, the DB record gets `emailDeliveryStatus = "pending"` even though no email is sent immediately. The `sendDigest()` function uses `sentAt IS NULL` to find notifications, so this doesn't block digest delivery — but the user-facing `emailDeliveryStatus` field shows "pending" indefinitely.

### Fix required

Move the digest preference query before the `initUpdates` block so the guard actually reflects the digest state:

```typescript
// Query digest preference FIRST
let emailDeferredToDigest = false;
if (channels.includes("email")) {
  const emailPref = await db
    .select({ digestFrequency: notificationPreferences.digestFrequency })
    .from(notificationPreferences)
    .where(...)
    .limit(1)
    .then((rows) => rows[0] ?? null);
  emailDeferredToDigest =
    emailPref?.digestFrequency === "daily" || emailPref?.digestFrequency === "weekly";
}

// THEN initialize delivery statuses
const initUpdates: Record<string, any> = {};
if (channels.includes("email") && !emailDeferredToDigest) {
  initUpdates.emailDeliveryStatus = "pending";
}
```

---

## P2 — `tick()` in-flight race can exceed `batchSize` concurrency

**File:** `server/src/services/background-job-worker.ts`, lines 348-358

### Problem

```typescript
async function tick() {
    if (stopped) return;
    if (inFlight >= batchSize) return;             // check 1
    try {
      const rows = await claimQueuedJobs();        // await — yields event loop
      inFlight += rows.length;                     // increment 1
      await Promise.all(rows.map((row) =>
        processJob(row).finally(() => { inFlight -= 1; })
      ));
    } catch (err) {
      logger.error({ err }, "Background job worker tick failed");
    }
  }
```

Because `tick()` is `async`, it yields at the `await claimQueuedJobs()` call. Between **check 1** and **increment 1**, another `tick()` can fire (the `setInterval` fires while tick 1 is awaiting). Both can pass the guard and claim jobs. With `batchSize=5`, this can produce up to 10 in-flight jobs.

`FOR UPDATE SKIP LOCKED` prevents double-claiming the same rows, so no data corruption. But the engine's stated batch size is not enforced as an upper bound.

### Fix recommended

Add a "reserving" counter before the await:

```typescript
if (inFlight >= batchSize) return;
inFlight += batchSize; // reserve capacity before claiming
try {
  const rows = await claimQueuedJobs();
  // Adjust down to actual claimed count
  inFlight += (rows.length - batchSize); 
  // ... process ...
} catch {
  inFlight -= batchSize; // release reservation on error
}
```

Or simpler: move the inFlight guard inside `claimQueuedJobs()` so the SELECT respects remaining capacity.

---

## P2 — Missing tests for critical failure paths

**File:** `server/src/__tests__/background-jobs-service.test.ts` and `server/src/__tests__/research-search-service.test.ts`

### Coverage gaps

| Failure path | Tested? | Notes |
|---|---|---|
| Worker retries on transient error | No | Only happy-path `succeeded` tested |
| Worker timeout kills long-running processor | No | `processorTimeoutMs` exercised only by "did not throw" assertions |
| `emitEvent` failure → retry doesn't overwrite terminal status | No | The P0 bug is invisible to tests |
| Stale-running jobs requeued on startup | No | Sweep doesn't exist yet |
| `upgradeSemanticResults` with empty candidateIds | No | Only tested with no data |
| AutoAssess with specific `itemIds` filter | No | Only tested with empty filter |
| Search with special LIKE characters (% _ \) in query | No | The escape-probe test validates PG-side behavior, but the JS-side `escapeLikePattern` + query assembly isn't integration-tested end-to-end |
| Route authz: research routes accept agents with write scope | No | No route tests for research/background-jobs/exports |
| Route authz: general POST /background-jobs board-only | No | No route tests |

### Fix recommended

Add tests for at minimum the P0 failure paths (retry, emit failure) since those are shipping blockers.

---

## Items confirmed resolved from the M1 review

| Condition | Status | Evidence |
|-----------|--------|----------|
| C1 — M1 code committed | ✅ Done | Committed in `feat(VOY-1493): M2 research async conversion + process visibility` and prior commits |
| C2 — `prepare: false` rationale documented | ✅ Done | `client.ts` has a multi-paragraph rationale comment |
| C3 — M2 tracked and in progress | ✅ Done | M2 commits are on the branch |
| C4 — Authz research route (read-permission-for-write) | ✅ Partially | The general `POST /background-jobs` is board-only; research routes remain agent-accessible but this is M2 scope. Acceptable. |
| C5 — SSE endpoint missing scope check | ✅ Done | All SSE/list/get routes now check `assertCompanyScopeReadAllowed` |
| C6 — Tests for background-jobs/research | ✅ Partial | Service-layer tests exist (bg-jobs crud, worker dispatch, research keyword search, autoAssess). Route-layer tests still missing. |
| C7 — CHECK constraints on background_jobs | ✅ Done | Migration has `background_jobs_status_check` and `background_jobs_progress_check` |

---

## Verified sound (non-blocking items)

These areas are structurally sound and require no action:

| Area | Finding |
|------|---------|
| `FOR UPDATE SKIP LOCKED` claim in transaction | Correct — atomic claim prevents double-claim |
| Partial index for `status='queued'` | Created and documented (PR review item #8) |
| Company isolation on all queries | `getById`, `list`, `update` all filter by companyId |
| LIKE escaping + parameterization in research-search | `escapeLikePattern` correctly escapes `\`, `%`, `_`; values are Drizzle-parameterized (not SQL interpolated); escape-probe test validates PG behavior |
| SLA dedup with pre-insert + post-insert TOCTOU guard | Sound pattern — `standard-sla-dedup.ts` combined with two-phase check in `issues.ts` |
| db-health-watchdog restart gating (PRA-1051) | Correctly moved restart behind consecutive-failure threshold; `probeInFlight` mutex prevents concurrent probes |
| `parseObject` hardening in heartbeat.ts | Replaces unsafe `as Record<string, unknown> | null` casts with null-safe parsing |
| Dynamic import try/catch for notification modules | `node:net`, `node:tls`, `web-push` imports are guarded; `node:` builtins are technically unnecessary guards but harmless |
| VAPID bounded dedup (10K FIFO Map) | Fixes the unbounded Set from the previous audit; tests verify eviction semantics |
| Company-templates transactional deploy | Whole deployment wrapped in `db.transaction()` with cleanup for non-transactional artifacts |
| Google OAuth UI + tests | Auth page, tests, and API client are consistent |
| Freshness cues + skeleton fade-in (Plans page) | Correctly implemented |

---

## Summary: must fix before shipping

| # | Finding | Severity | File | Action |
|---|---------|----------|------|--------|
| 1 | `emitEvent` can throw after DB commit → duplicate execution on retry | **P0** | background-jobs.ts | Wrap `emitEvent` in try/catch; add status guard to `update()`'s WHERE clause |
| 2 | No stale-'running' recovery after crash → eternal spinner | **P0** | background-job-worker.ts | Add startup sweep that requeues 'running' jobs older than `processorTimeoutMs + grace` |
| 3 | Large binary PDF results in DB; list endpoint returns them unprojected | **P1** | background-job-worker.ts, background-jobs.ts | Strip `result.dataUri` from list projection, or document accepted tradeoff |
| 4 | `emailDeferredToDigest` ordering → digest-deferred emails show "pending" | **P1** | notifications.ts | Move digest preference query before initUpdates block |

Items 5-7 are structural improvements recommended before the next release:

| # | Finding | Severity | File | Action |
|---|---------|----------|------|--------|
| 5 | `tick()` inFlight race exceeds `batchSize` concurrency | **P2** | background-job-worker.ts | Reserve capacity before the await in `tick()` |
| 6 | Missing tests for retry, timeout, emit-failure paths | **P2** | test files | Add regression tests for P0/P1 failure modes |
| 7 | Arbitrary `jobType` accepted by create routes | **P2** | routes/research.ts, routes/background-jobs.ts | Validate `jobType` against `BACKGROUND_JOB_TYPES` at the boundary |

**Approval routing:** This review goes to the CTO. Items 1-4 must be resolved before this branch ships to production. Items 5-7 are recommended for the same cycle but can be deferred with documented acceptance of risk.

---

## Appendix: diff summary (relevant code only, excluding docs/export noise)

- 90 server/ui code files changed
- 6,175 insertions, 609 deletions
- Key new files: background-job-worker (435), background-jobs (134), research-search (659), research routes (148), export routes (115), background-job routes (114), timeout-constants (854), BackgroundProcessTray UI (251), useJobStatus hook (157), ActivitySearchPanel (163), various UI primitives
- Key modified files: company-templates (transactional), db-health-watchdog (PRA-1051 fix), heartbeat (parseObject hardening), notifications (bounded dedup, digest fix), posthog (PII redaction), approvals (metric capture), board-auth/cloud-upstreams (timeout-constants migration)