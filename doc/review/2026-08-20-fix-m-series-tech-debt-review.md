# Staff Engineer Review: `fix/m-series-tech-debt`

**Reviewer:** Staff Engineer
**Branch:** `fix/m-series-tech-debt`
**Date:** 2026-08-20
**Base:** `master`
**Status:** ❌ NOT APPROVED — structural issues found

---

## Scope

1167 files changed, ~34K insertions, ~649 deletions. Excluding doc/heartbeat noise
and exported-site static builds, the substantive changes are concentrated in
~30 files across packages and server.

Changes address M-series tech-debt items: background jobs framework, DB health
watchdog hardening, notifications fixes, PostHog PII redaction, company
template atomicity, error-handler response stability, timeout centralization,
and PG client hardening.

---

## BLOCKER 1: Background Jobs — No Worker (Dead-End Pipeline)

**Severity:** BLOCKER
**Files:** `server/src/routes/research.ts`, `server/src/services/background-jobs.ts`,
`server/src/routes/background-jobs.ts`, `ui/src/**`

The entire background jobs infrastructure is built (table, service, routes, UI hook,
SSE endpoint, ActivitySearchPanel) but there is **no worker, scheduler, or executor
anywhere in the codebase** that calls `svc.update()` to transition jobs out of the
`queued` state. The `backgroundJobService.update()` method exists but has zero
callers outside its own definition — confirmed by searching every import site.

**What happens:**
1. `POST /api/companies/:companyId/research/activities` creates a job with
   `jobType: "research.activity_search"`, status `"queued"` → returns 202
2. The UI (`ActivitySearchPanel`) calls `useJobStatus` which polls
   `GET /background-jobs/:id` every 2 seconds
3. The job status stays `"queued"` forever → the UI spins indefinitely
4. The user sees a perpetually-spinning "Searching..." loader

This is a half-built feature: the enqueue + status pipeline exists but the
processing half is missing. Either a worker must be added, or the feature
must be removed until the worker is ready.

**Fix:** Add a job processing loop (setInterval-based worker, or queue consumer)
that reads `background_jobs` rows with status = `"queued"`, calls `svc.update()`
to transition through `"running"` → `"succeeded"/"failed"`, and performs the
actual work (activity search, etc.) between the transitions.

---

## BLOCKER 2: SSE Events Route Shadowed by `:id` Route

**Severity:** BLOCKER
**File:** `server/src/routes/background-jobs.ts` (lines 60, 101)

The `GET /companies/:companyId/background-jobs` routes are registered in this order:

```
Line 45  GET /companies/:companyId/background-jobs          (list)
Line 60  GET /companies/:companyId/background-jobs/:id      (get-by-id)
Line 79  POST /companies/:companyId/background-jobs        (create)
Line 101 GET /companies/:companyId/background-jobs/events   (SSE)
```

Express matches `GET /companies/:companyId/background-jobs/events` against the
`:id` route first — `:id` = `"events"`. The handler calls `svc.getById("events",
companyId)` → returns null → **404**. The SSE endpoint is unreachable.

The UI's `EventSource(backgroundJobsApi.eventsUrl(companyId))` silently gets a 404
and falls back to polling (which also never completes due to Blocker 1).

**Fix:** Register the `/events` route **before** the `/:id` route. Express matches
in registration order, so the fixed-length path `/events` must be registered first.

```ts
// Route order: fixed paths before parameterized paths
router.get("/companies/:companyId/background-jobs/events", ...);  // first
router.get("/companies/:companyId/background-jobs/:id", ...);     // second
```

---

## HIGH: `prepare: false` — Global postgres.js Change Without Justification

**Severity:** HIGH
**File:** `packages/db/src/client.ts` line 51

```diff
- const sql = postgres(url);
+ const sql = postgres(url, { prepare: false });
```

This disables **all prepared statements** for the main database pool. Every SQL
query is re-parsed by PostgreSQL — no query plan caching. This is a significant
performance regression for the hot path.

The commit provides no comment explaining **why** this change was needed. Possible
candidates: (a) `db.transaction` with nested savepoints hitting prepared-statement
name collisions, (b) a postgres.js version incompatibility, (c) the new
`companyTemplateService` transaction needing non-prepared connections.

**Fix:** Add a comment explaining the rationale. If this is only needed for
transactional clients, isolate the option to the transaction path instead of
making it global. If the global setting is genuinely required (e.g., prepared
statements cause errors in production), document the observed failure mode and
tradeoffs.

**Risk:** Each query now incurs server-side parse + plan overhead. On a busy
server with hundreds of queries/second this compounds quickly.

---

## HIGH: Company Templates — Soft-Fail to All-Or-Nothing Behavior Change

**Severity:** HIGH
**File:** `server/src/services/company-templates.ts`

Previously, failures in:
- Skill installation from catalog (`installFromCatalog`)
- Knowledge starter pack install
- Goal / project / issue creation

were **soft-failures**: the error was logged, appended to `warnings[]`,
and deployment continued with partial state.

Now, **any failure in these steps propagates** and the entire `db.transaction()`
rolls back — the company is not created at all. This is documented in the
commit (VOY-1403, M-1 behavioral change).

**Concerns:**
1. Catalog skills can be flaky (community skills, network issues, dependency
   conflicts). A single transient failure aborts the whole deployment now.
2. Callers in the UI/integrations expect 201 on success with partial warnings.
   Now they get a 500 rollback instead. Any client that reads `warnings`
   and continues will suddenly experience hard failures.
3. The previous soft-fail behavior existed for a reason — catalog skills are
   best-effort; the core agent+company structure was the important part.

**Mitigation suggestion:** Distinguish between fatal steps (company creation,
membership, budget policy) and non-fatal steps (skills, starter packs, optional
goals). Keep non-fatal steps outside the transaction with individual
try-catch-warning recovery, or use savepoints with rollback-to-savepoint
recovery per-non-fatal-step.

---

## MEDIUM: `sanitizeErrorForTelemetry` Mutates Caller's Error Object In Place

**Severity:** MEDIUM
**File:** `server/src/services/posthog.ts` (`sanitizeErrorForTelemetry`, line ~95)

```ts
function sanitizeErrorForTelemetry(error: unknown): Error | unknown {
  if (!(error instanceof Error)) return error;
  error.message = redactSensitiveText(error.message);   // MUTATION
  if (typeof error.stack === "string") {
    error.stack = redactSensitiveText(error.stack);     // MUTATION
  }
  if (error.cause instanceof Error) {
    sanitizeErrorForTelemetry(error.cause);             // recursive mutation
  }
  return error;
}
```

This mutates the **caller's error object** in place. The error-handler correctly
snapshots `responseMessage` before calling `captureErrorEvent`, so client-facing
responses are safe. However, any other caller of `captureErrorEvent` that reads
`err.message` after the call will see the redacted version.

Since `captureErrorEvent` is currently only called from the error-handler
(`middleware/error-handler.ts`), this is not an active problem today. But
the pattern is a landmine for future developers — the mutation side effect
on a shared mutable object is surprising and fragile.

**Fix:** Clone the error for telemetry instead of mutating in place:

```ts
function sanitizeErrorForTelemetry(error: Error): Error {
  const copy = new Error(redactSensitiveText(error.message));
  copy.name = error.name;
  copy.stack = error.stack ? redactSensitiveText(error.stack) : undefined;
  // etc.
  return copy;
}
```

---

## MEDIUM: No Test Coverage for Background Jobs / Research Routes

**Severity:** MEDIUM
**Files:** `server/src/routes/background-jobs.ts`, `server/src/routes/research.ts`,
`server/src/services/background-jobs.ts`

The three new modules have **zero test coverage**. No service tests, no route
integration tests. The SSE shadowing bug (Blocker 2) would have been caught by
a basic route test. The missing worker (Blocker 1) would have been caught by
a service-level test verifying that a created job eventually reaches a terminal
status (the test would time out or fail on assertion).

---

## MEDIUM: Notifications TDZ Bug Fix (Good — Verified)

**Severity:** Fixed (was a production crash latent)
**File:** `server/src/services/notifications.ts`

The `emailDeferredToDigest` variable was declared with `let` AFTER its first
usage in a conditional. When `channels.includes("email")` was true, this threw
a TDZ `ReferenceError` at runtime, crashing `notify()` for email-channel
notifications. The fix correctly moves the declaration before the first use.
Tests pass. Good catch.

---

## LOW: `background_jobs` Table Missing Constraints

- `status` column has no `CHECK (status IN (...))` constraint — relies on
  application-layer validation via the constant array and zod schema
- `progress` has no `CHECK (progress >= 0 AND progress <= 100)` — relies on
  application-layer enforcement
- `duration_ms` has no `CHECK (duration_ms >= 0)` — some confused code might
  write negative values

Minor — the app layer validates all of these. A CHECK constraint would add a
belt-and-suspenders guard.

---

## Summary

| # | Finding | Severity | Action |
|---|---------|----------|--------|
| 1 | Background jobs have no worker → jobs never progress | BLOCKER | Add job processing worker or remove the feature |
| 2 | SSE `/events` route shadowed by `/:id` route → 404 | BLOCKER | Reorder routes: fixed paths before parameterized |
| 3 | `prepare: false` without justification | HIGH | Document rationale or scope to transactions only |
| 4 | Company templates soft-fail → all-or-nothing | HIGH | Review callers; consider savepoint-based per-step resilience |
| 5 | `sanitizeErrorForTelemetry` mutates caller's object in place | MEDIUM | Clone for telemetry instead of mutating |
| 6 | No tests for background-jobs / research modules | MEDIUM | Add service + route tests before shipping |
| 7 | Notifications TDZ crash (fixed) | OK | Good fix, no further action |
| 8 | Missing DB constraints on background_jobs | LOW | Consider adding CHECK constraints |

**Verdict: NOT APPROVED.** Blockers 1 and 2 must be resolved before shipping.
Items 3 and 4 should be addressed or explicitly accepted with documented
tradeoffs before this lands on master.

Recommend sending back to implementation with the two blockers fixed + tests
for the new modules, then re-review.