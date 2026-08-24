# Async Jobs (Background Jobs) — Internal Reference

**Last updated:** 2026-08-20 (v6)
**Applies to:** Commit `f81d572a40` (deployed to VPS production 2026-08-20), VOY-1493 (M2 post-review fixes), VOY-1527 (P0/P1 hotfixes), VOY-1531 (follow-up refinements)
**Status:** Released to production (VPS). All M2 post-review fixes and P0/P1 hotfixes live: transaction-wrapped claim, candidateIds, processor timeout, retry, graceful shutdown, queued partial index, SSE authz, export payload cap, DB CHECK constraints, emitEvent try/catch guard, terminal-status WHERE guard, stale-job recovery startup sweep, list endpoint slim projection (strips dataUri), email digest ordering fix. Staff Engineer review (VOY-1494) complete — APPROVED. 31/31 tests passed, all routes verified post-deploy.

## Overview

The background jobs system allows the application to execute work outside the
request-response cycle. Clients submit a job and receive a `jobId` immediately
(HTTP 202). The client then polls (or subscribes via SSE) for status updates
while the job is processed asynchronously.

This eliminates UI blocking on long-running operations such as activity search,
export generation, or data aggregation.

## Architecture

```
Client                          Server                          DB
  │                               │                               │
  │  POST /research/activities     │                               │
  │  ─────────────────────────►   │                               │
  │  ◄─── 202 { jobId: "…" }     │                               │
  │                               │  INSERT background_jobs       │
  │                               │  ─────────────────────────►  │
  │                               │  ◄─── row (status: queued)    │
  │                               │                               │
  │  GET /background-jobs/:id     │                               │
  │  ─────────────────────────►   │                               │
  │  ◄─── { status: "running" }  │                               │
  │                               │                               │
  │  ─── OR ───                  │                               │
  │                               │                               │
  │  EventSource(/events)         │                               │
  │  ─────────────────────────►   │  SSE stream: background_job   │
  │  ◄─── status updates         │                               │
```

### Data Model

- **Table:** `background_jobs` (company-scoped, cascade deletes)
- **Statuses:** `queued` → `running` → `succeeded` / `failed`
- **Key columns:** `job_type` (discriminator), `payload` (JSONB input),
  `result` (JSONB output), `progress` (0–100), `progress_message`
- **Indexes:** company+status, company+createdAt, jobType,
  partial index on `status = 'queued'` (serves the worker's claim query)
- **DB CHECK constraints** (migration 0144, post-review):
  - `status` ∈ ('queued', 'running', 'succeeded', 'failed')
  - `progress` between 0 and 100
  - `duration_ms` IS NULL or ≥ 0

### API Endpoints

| Method | Path | Auth | Description |
|------|------|------|-------------|
| `GET` | `/api/companies/:companyId/background-jobs` | Board/Agent (scope read) | List jobs (paginated, filterable by status/jobType) |
| `GET` | `/api/companies/:companyId/background-jobs/:id` | Board/Agent (scope read) | Get single job by ID |
| `GET` | `/api/companies/:companyId/background-jobs/events` | Board/Agent (scope read) | SSE stream of job status changes (post-review: now checks `assertCompanyScopeReadAllowed`) |
| `POST` | `/api/companies/:companyId/background-jobs` | Board only | Create a background job |
| `POST` | `/api/companies/:companyId/research/activities` | Board/Agent (scope read) | Submit an activity search (creates a background job) |
| `POST` | `/api/companies/:companyId/research/auto-assess` | Board/Agent (scope read) | Submit an auto-assessment job (M2) |
| `POST` | `/api/companies/:companyId/research/search` | Board/Agent (scope read) | Keyword-first search (sync) with optional async semantic upgrade via `semanticJobId` → SSE (M2) |
| `POST` | `/api/companies/:companyId/exports/pdf` | Board/Agent (scope read) | Queue a PDF export job (M2) |
| `POST` | `/api/companies/:companyId/exports/ics` | Board/Agent (scope read) | Queue an iCalendar (.ics) export job (M2) |

### SSE Event Format

```
data: {
  "type": "background_job.status",
  "companyId": "…",
  "payload": {
    "jobId": "…",
    "status": "running",
    "progress": 42,
    "progressMessage": "Processing…",
    "result": null,
    "error": null,
    "durationMs": null,
    "startedAt": null,
    "finishedAt": null,
    "updatedAt": "…"
  }
}
```

### UI Components

- **`useJobStatus(companyId, jobId, options?)`** — React hook that polls
  `GET /background-jobs/:id` every 2 seconds, with optional SSE
  subscription for live updates (best-effort, falls back to polling).
- **`StatusCue`** — Compact inline status indicator: colored dot, label,
  optional progress bar + percentage + message + error text.
- **`IncompleteDataNotice`** — Banner shown while data is being prepared
  (e.g. search queued/running, results pending).
- **`ActivitySearchPanel`** — Search input + scope selector + job status
  display. Submits `POST /research/activities`, tracks via `useJobStatus`.
- **`BackgroundProcessTray`** (M2) — Consolidated tray of all background
  work for a company. Subscribes to SSE `/events`, falls back to 5s
  polling; running jobs sort to the top with progress bars and timing.
- **`FreshnessCue` / `FreshnessDot`** (M2) — Visual freshness/staleness
  indicator for research items (green fresh / amber stale / grey unknown).
- **`SkeletonBone` / `SkeletonText` / `FadeIn`** (M2) — Skeleton loading
  placeholders + fade-in wrapper for non-blocking trip-page data.

### Job Types (M2)

| Job type | Processor | Result |
|---|---|---|
| `research.activity_search` | Keyword search over issues, documents, activity | `{ query, results, total }` |
| `research.semantic_search` | Keyword candidates + embedding cosine rerank (falls back to keyword when no embedding provider configured) | `{ query, upgraded, model, results, total }` |
| `research.auto_assess` | Heuristic freshness/completeness/relevance per research item | `{ assessedAt, items[] }` |
| `export.pdf` | pdfkit paginated PDF (title page, item cards, separators) — result carries base64 `dataUri` | `{ kind, title, items, generatedAt, dataUri }` |
| `export.ics` | iCalendar text builder | `{ kind, title, calendarText, eventCount }` |

## Known Issues (as of 2026-08-20 — M1+M2 shipped to production, all P0/P1 hotfixes resolved)

1. **[RESOLVED in M2] No job worker / executor.** The worker
   (`server/src/services/background-job-worker.ts`) now polls for queued
   jobs every 2 seconds and dispatches to per-type processors. The
   `update()` service has active callers. The async pipeline is live.

2. **[RESOLVED in M2] Activity search job type has no concrete processor.**
   `research.activity_search` now does real keyword search across issues,
   documents, and activity log. All five job types (`research.activity_search`,
   `research.semantic_search`, `research.auto_assess`, `export.pdf`,
   `export.ics`) have working processors.

3. **[RESOLVED] Route order fix applied.** The SSE `/events` route is
   registered before the `/:id` wildcard so Express matches it correctly.

4. **SSE is best-effort only.** The UI (`BackgroundProcessTray`,
   `useJobStatus`) falls back to polling if SSE fails. The
   `BackgroundProcessTray` uses 5s polling when SSE is down.
   Individual `useJobStatus` hooks use 2s polling. Poll intervals
   are hardcoded — configurable in a future version.

5. **No job cancellation.** There is no endpoint to cancel a running
   or queued job. The schema has no `cancelled` status. This is a
   future feature.

6. **[RESOLVED in M2 post-review fixes] No retry mechanism.** The worker
   now retries transient processor failures with exponential backoff:
   up to 2 retries (3 total attempts), delays of 1s, 2s, and 4s capped
   at 30s. After all retries are exhausted, the job is marked `failed`
   permanently.

7. **No job history / retention cleanup.** Rows accumulate in the
   `background_jobs` table indefinitely. A future version should
   clean up old terminal jobs.

8. **Export processors use real renderers.** `export.pdf` uses pdfkit
   to produce a paginated PDF with title page, item cards, and
   separators — result includes a base64 `dataUri` for direct client
   download. `export.ics` produces valid iCalendar v2.0 text with
   VEVENT entries (sanitized SUMMARY, DTSTART, DTEND, LOCATION,
   DESCRIPTION). ICS includes a 300ms simulated delay before building
   calendar text. Both run inside the worker's 2s tick loop and
   briefly block the event loop during rendering. No blob storage
   integration yet — PDF content is embedded in the result object.

9. **Semantic upgrade requires an embedding provider.** Without
   `PAPERCLIP_EMBEDDING_API_KEY`, `research.semantic_search` falls back
   to keyword ranking automatically, so the job still completes
   successfully.

10. **[RESOLVED in M2] Research activity search processor.** The
    `research.activity_search` processor now executes real keyword
    search (issues, documents, activity log) instead of being a
    no-op placeholder.

11. **[RESOLVED in M2 post-review fixes] SSE `/events` endpoint missing `company_scope:read` check.** The
    SSE route now calls `assertCompanyScopeReadAllowed`. This aligns
    SSE authz with the list and get-by-id routes. Authenticated users
    without scope:read permission are denied SSE access.

12. **Research routes use read-level auth for write operations.** The
    `POST /research/activities`, `POST /research/auto-assess`, and
    `POST /research/search` all gate on `assertCompanyScopeReadAllowed`
    — a permission intended for read operations. By contrast, the
    general `POST /background-jobs` endpoint is board-only. This means
    any agent or user with company_scope:read can enqueue background
    jobs. The Staff Engineer review flagged this as MEDIUM-severity
    (recommended fix: require board-level auth or create a dedicated
    `background_job:create` permission).

13. **Export payload size limited to 512 KB.** The `POST /exports/pdf`
    and `POST /exports/ics` routes now reject payloads whose serialized
    JSON size exceeds 512 KB with HTTP 413. This prevents large payloads
    from tying up the worker (exacerbating the per-processor timeout)
    and caps the base64 data-URI stored on the job result row.

14. **candidateIds scope semantic upgrade to keyword-first results, but
    only when provided.** The `research.semantic_search` processor
    accepts optional `payload.candidateIds`. If present, the processor
    fetches only those specific items for re-ranking, ensuring the
    semantic upgrade operates on the same result set the user saw.
    If absent, the processor re-runs the keyword search to build the
    candidate pool (previous behavior). The route passes `candidateIds`
    from the keyword-first response, so the behavior change is
    transparent to API callers.

15. **Processor timeout prevents stuck jobs.** Each processor runs under
    a `Promise.race` with a 5-minute timeout (configurable via
    `processorTimeoutMs` option on `createBackgroundJobWorker`). If a
    processor exceeds the timeout, the job is marked `failed` with
    `"Processor timed out after 300000ms"`. The worker can then claim
    the next queued job.

16. **Claim is now transaction-atomic.** The worker's claim logic wraps
    `FOR UPDATE SKIP LOCKED` + status update to `'running'` inside a
    single `db.transaction()`. In auto-commit mode (postgres-js default),
    `FOR UPDATE SKIP LOCKED` releases row locks as soon as the SELECT
    completes — before the subsequent UPDATE to `status='running'`.
    Wrapping both in a single transaction ensures atomic claim ownership
    and eliminates the race where two workers could claim the same job.

17. **[RESOLVED in VOY-1531] `emitEvent` failure after DB commit can overwrite terminal status.** The `emitEvent()` function in `background-jobs.ts` calls `publishLiveEvent()` without a try/catch. When an SSE subscriber disconnects during a job's success notification, the exception propagates back through the retry loop. This can cause the job to be re-executed (waste of compute for idempotent jobs) or, in the worst case, marked `failed` after all retries exhaust — silently overwriting a successful result. **Fix applied:** `emitEvent` wrapped in try/catch (logs warning, does not propagate), and `update()` WHERE clause now includes `IN ('queued', 'running')` guard preventing writes to terminal-status rows.

18. **[RESOLVED in VOY-1531] No stale-running recovery after process crash.** When the server process crashes or is killed mid-job, the claimed job row stays `status = 'running'` permanently. The worker's claim query (`WHERE status = 'queued'`) ignores these orphans. There is no startup sweep or periodic reaper. The UI shows an eternal "running" spinner. **Fix applied:** `createBackgroundJobWorker()` now runs `requeueStaleJobs()` on startup, which requeues jobs that have been `running` longer than max expected execution time (`processorTimeoutMs` + 30s grace). The sweep also emits live events for each requeued job so the UI tray reactively updates.

19. **[RESOLVED in VOY-1531] Large export results stored in DB; list endpoint returns full blobs.** The PDF/ICS export processors store full base64 data in the `result` jsonb column (potentially several MB). The `list()` endpoint returns `result` for every row, causing multi-MB responses on each tray poll. The `background_jobs` table grows without bound. The 512KB payload cap on the *request* does not cap the *result* — a small input can produce a large PDF. **Fix applied:** `toApi()` now accepts a `slim` parameter; `list()` calls it with `slim=true`, stripping `result.dataUri` from list responses. The full result (including `dataUri`) remains available via `getById()`. Future work: a dedicated result download endpoint, or blob storage integration.

20. **[RESOLVED in VOY-1531] Email digest-deferred notifications show stale "pending" status.** In `notifications.ts`, the `initUpdates` block sets `emailDeliveryStatus = "pending"` *before* the digest preference query determines whether the notification is deferred to digest. The guard `!emailDeferredToDigest` always passes because the variable is initialized to `false` and hasn't been set yet. Result: when a notification uses email+digest, the DB record gets `emailDeliveryStatus = "pending"` indefinitely. The digest delivery itself is unaffected, but the user-visible status field is misleading. **Fix applied:** the digest preference query (`SELECT digestFrequency FROM notificationPreferences`) now runs *before* the `initUpdates` block, so `emailDeferredToDigest` is correctly resolved before the init-update decision.

## Troubleshooting Guide

### Job stays in "queued" forever
- **Root cause:** The worker is not running (server not started, or the
  worker loop crashed).
- **Workaround:** Restart the server; verify the startup log shows
  "Background job worker started".
- **Expected fix:** The worker claims queued jobs every 2 seconds
  (`server/src/services/background-job-worker.ts`). Claims are
  transaction-atomic (`FOR UPDATE SKIP LOCKED` + status update to
  `running` inside one transaction, post-review fix). If jobs remain
  queued, check the server logs for worker tick errors.

### Job fails repeatedly with "Processor timed out"
- **Root cause:** The processor exceeded the 5-minute timeout
  (`processorTimeoutMs`, default 300000 ms). The worker uses
  `Promise.race` to prevent one stuck job from blocking the queue.
- **Workaround:** Check whether the job's data volume is unusually
  large (e.g. a research query spanning many items, or an export with
  a large item list). Reduce scope where possible.
- **Note:** Transient failures are retried automatically (up to 2
  retries with exponential backoff, capped at 30s) before a job is
  marked `failed`.

### SSE connection returns 404
- **Check:** Ensure the `/events` route is registered before the `/:id`
  route in `server/src/routes/background-jobs.ts`.
- **Fallback:** `BackgroundProcessTray` and `useJobStatus` fall back to
  polling automatically. Verify polling works by calling
  `GET /api/companies/:companyId/background-jobs/:id` directly.

### Activity search returns no results
- **Check:** The `research.activity_search` processor runs keyword
  search over issues, documents, and activity log. Verify the query
  contains terms present in company data.
- **Fallback:** Broad queries ("all") may return more results.

### Semantic search upgrade never arrives
- **Check:** The `/research/search` endpoint returns keyword-first
  results immediately with a `semanticJobId`. The client subscribes to
  SSE and waits for the job to complete.
- **Root cause:** No `PAPERCLIP_EMBEDDING_API_KEY` configured — the job
  finishes immediately with `upgraded: false`. The result is identical to
  keyword search.
- **Workaround:** The keyword results are available synchronously. The
  semantic upgrade is an enhancement, not a dependency.

### Auto-assessment stays "queued" or fails
- **Check:** `research.auto_assess` assesses the company's most recent
  issues (default) or a specific set of itemIds. Verify the company has
  non-hidden issues.
- **Root cause:** If `itemIds` are provided but none match visible issues,
  the result is an empty `items` array.
- **Fallback:** Call without `itemIds` to get the default assessment of
  recent issues.

### Export job completes with no downloadable file
- **Root cause:** Export processors (`export.pdf`, `export.ics`) render
  content into the job result object, but there is no blob storage or
  served file URL yet. The result carries a base64 `dataUri` (PDF, via
  pdfkit) or `calendarText` (ICS, valid iCalendar v2.0) — the client
  must construct the download from the result object.
- **Expected:** A follow-up will wire blob storage and serve the
  generated files for direct download.
- **Workaround:** Client-side download buttons can construct a blob
  from `result.dataUri` (PDF) or `result.calendarText` (ICS).
- **Note:** Payloads larger than 512 KB are rejected with HTTP 413 at
  submission time (see known issue #13).
- **Note (known issue #19 — RESOLVED):** Large export results no longer inflate list endpoint responses — the `list()` endpoint now strips `result.dataUri` from the slim projection. Full results including `dataUri` are available via `getById()`.

### UI shows "Search queued — results will appear shortly" indefinitely
- **Root cause:** The job never transitions out of `queued` (worker not
  running — see first troubleshooting item).
- **Workaround:** Restart the server to restart the worker.
- **Escalation:** Report to engineering with the job ID (visible in
  network tab / browser console).

### BackgroundProcessTray not appearing
- **Check:** The tray only renders when there are jobs — if the company
  has no background jobs, the component returns null.
- **Check:** The tray subscribes to SSE for live updates. If SSE is
  unreachable, it falls back to 5s polling. Verify the companyId is
  correct.

### FreshnessCue shows "Unknown" for recently updated items
- **Check:** The cue computes age from the `updatedAt` timestamp. If
  the timestamp is in the future or parse failure, it returns "unknown".
- **Thresholds:** "fresh" = ≤7 days, "stale" = ≤30 days, "unknown" = >30
  days. These are defaults; `FreshnessCue` accepts custom thresholds as
  props.

### SSE events visible without proper permissions
- **Status:** RESOLVED in M2 post-review fixes. The SSE `/events`
  endpoint now requires `company_scope:read`, matching the list and
  get-by-id routes.
- **Former impact:** Before the fix, any authenticated user with company
  access could subscribe — but only saw status events, not job payload
  or sensitive result data.

### Agent/users can enqueue research jobs without board authorization
- **Check:** The research routes (`/research/activities`,
  `/research/auto-assess`, `/research/search`) use
  `assertCompanyScopeReadAllowed` — a read-level permission — to gate
  write operations (creating background jobs). Any agent or user with
  company_scope:read can submit jobs.
- **Contrast:** The general `POST /background-jobs` endpoint requires
  board-level auth.
- **Workaround:** If an agent is enqueueing excessive research jobs,
  revoke the agent's `company_scope:read` permission or remove the
  agent from the company.
- **Expected fix:** Add board-level auth or a dedicated
  `background_job:create` permission (tracked as Staff Engineer
  recommendation C4 in VOY-1494).

### Completed job shows as "running" or "failed" after refresh (known issue #17 — RESOLVED)
- **Root cause:** If an SSE subscriber disconnects while a job's success
  notification is being published, the `emitEvent` failure propagated to
  the retry loop, causing the job to be re-executed or marked `failed`.
- **Fix applied:** `emitEvent` is now wrapped in try/catch (logs warning, does
  not throw), and `update()` refuses to overwrite terminal-status rows via a
  WHERE clause guard (`IN ('queued', 'running')`).
- **Current state:** This is no longer possible in the hotfixed codebase.
  Notifications are best-effort; DB writes are always safe.

### Job shows permanent "running" spinner after server restart (known issue #18 — RESOLVED)
- **Root cause:** The server process crashed mid-job; the job was left
  in `status = 'running'` with no recovery mechanism. The worker ignores
  non-queued jobs on restart.
- **Fix applied:** `createBackgroundJobWorker()` now runs
  `requeueStaleJobs()` on startup, which requeues jobs stuck in `running`
  for longer than `processorTimeoutMs` + 30s grace. The sweep emits live
  events so the UI tray reactively updates.
- **Current state:** Orphaned jobs are automatically recovered on next
  worker start.

### Email notification shows "pending" status for digest-deferred emails (known issue #20 — RESOLVED)
- **Root cause:** The `emailDeferredToDigest` check ran after
  `emailDeliveryStatus` was set to "pending", so deferred emails
  incorrectly showed "pending" instead of the actual digest status.
- **Fix applied:** The digest preference query now runs *before* the
  `initUpdates` block, so `emailDeferredToDigest` is correctly resolved
  before the init-update decision.
- **Current state:** Deferred emails no longer show stale "pending"
  status. The status field correctly reflects the delivery state.

## Support Escalation Path

| Issue | Action | Escalate to |
|---|---|---|
| Job stuck in queued | Verify worker is deployed, restart server | Engineering (Founding Engineer / CTO) |
| Job fails repeatedly / times out | Check for oversized payloads, verify 5-min timeout budget is realistic for the workload; retries (max 2) are automatic | Engineering |
| SSE not working | Check route ordering, verify polling fallback works | Engineering |
| Activity search returns no data | Verify query terms exist in company data | Engineering |
| Semantic upgrade missing | Check `PAPERCLIP_EMBEDDING_API_KEY` is set; keyword results still returned | Engineering (config) |
| Export job result contains dataUri (PDF) or calendarText (ICS) | PDF is a real pdfkit-rendered document (base64 dataUri). ICS is valid v2.0 calendar text. No blob storage yet — client downloads from the result object. Payloads over 512 KB rejected with 413. | Engineering (blob storage follow-up) |
| Export returns HTTP 413 | Request payload exceeded the 512 KB cap — trim item lists before export | Support Engineer |
| UI display issues (StatusCue blank, tray missing, etc.) | Check browser console for errors, refresh | Support Engineer + Engineering |
| Research jobs submitted without board auth | Revoke agent's company_scope:read if abusive | Support Engineer + Engineering (authz fix) |
| **Completed job shows wrong status after SSE disconnect** (known issue #17 — RESOLVED) | Fixed — `emitEvent` try/catch guard + terminal-status WHERE clause prevents overwrite | Engineering |\n| **Permanent "running" spinner after crash** (known issue #18 — RESOLVED) | Fixed — startup sweep requeues stale-running jobs automatically | Engineering |\n| **Slow tray responses** (known issue #19 — RESOLVED) | Fixed — list endpoint slim projection strips `result.dataUri`. Full result via `getById()`. | Engineering |\n| **Email shows "pending" for digest-deferred notifications** (known issue #20 — RESOLVED) | Fixed — digest preference query now runs before status init | Support Engineer |

## Version History

| Version | Date | Author | Changes |
|---|---|---|---|
| 1 | 2026-08-20 | Support Engineer | Initial support case assessment for VOY-1474/VOY-1492 (M1) |
| 2 | 2026-08-20 | Support Engineer | M2 update: worker + 5 processors live, export routes, BackgroundProcessTray, FreshnessCue, skeleton loading, keyword-first semantic search (VOY-1493) |
| 3 | 2026-08-20 | Support Engineer | Corrected export processor accuracy (pdfkit real renderer, ICS v2.0 text), added SSE authz gap (#11) and research route authz inconsistency (#12), added troubleshooting for both authz items, updated escalation table (VOY-1493 post-commit audit) |
| 4 | 2026-08-20 | Support Engineer | M2 post-review fixes (commit f81d572a40): resolved #6 (retries with exponential backoff) and #11 (SSE scope:read check now enforced); added #13 (512 KB export payload cap), #14 (candidateIds scoping), #15 (processor timeout), #16 (transaction-atomic claim); documented queued partial index + DB CHECK constraints; fixed stale "scaffolds" wording in export troubleshooting; added timeout/413 troubleshooting + escalation rows |
| 5 | 2026-08-20 | Support Engineer | Added known issues #17-20 (P0/P1 items shipped unfixed, tracked under VOY-1527 hotfix): emitEvent failure, stale-job recovery, large export results in list endpoint, email digest ordering; added troubleshooting entries and escalation rows for each; updated header to reflect "in production, hotfix in progress" status |
| 6 | 2026-08-20 | Support Engineer | VOY-1527 P0/P1 hotfixes resolved (commits dd2a41f9a0, 10536a49ee, 953249ae19): items #17-#20 marked RESOLVED; emitEvent try/catch guard + terminal-status WHERE clause (#17), stale-job recovery startup sweep (#18), list endpoint slim projection stripping dataUri (#19), email digest ordering fix (#20); updated header and status to reflect all fixes live |