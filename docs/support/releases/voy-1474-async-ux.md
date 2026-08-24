---
title: Async UX Release — Background Jobs + Process Visibility (M1+M2)
version: voy-1474
date: 2026-08-20
commits: 7211f8ba87, 01009090bf, daa8360578, f81d572a40, dd2a41f9a0, 10536a49ee, 953249ae19, 9949b6dfcb
status: Released — deployed to production (VPS) 2026-08-20 ~17:20 UTC. All 4 P0/P1 hotfixes applied and verified (VOY-1527 resolved, VOY-1531 follow-up refinements landed)
---

# Async UX Release: Background Jobs + Process Visibility (M1+M2)

**Branches:** `fix/m-series-tech-debt` (pending merge to `fork/master` — blocked on GitHub billing)
**Release status:** Released — deployed to VPS production 2026-08-20 ~17:20 UTC. Server restarted, migration 0144 made idempotent, UI rebuilt with all new components. Verified: 31/31 tests passed, all routes confirmed live. **All 4 P0/P1 VOY-1527 hotfix items applied and verified (VOY-1531).**
**Applies to:** VOY-1474 (M1) + VOY-1493 (M2 post-review fixes) + VOY-1527 (P0/P1 hotfixes) + VOY-1531 (follow-up refinements)

---

## What Changed

This release ships the async job framework and background process visibility improvements. Long-running operations no longer block the UI — they return immediately with a job ID, and the client tracks progress via polling or Server-Sent Events (SSE).

### M1: Async Job Foundation (VOY-1474)

The first milestone established the core background job infrastructure:

- **Background jobs table + data model** — `background_jobs` table with `queued → running → succeeded → failed` status lifecycle, company-scoped with cascade delete, JSONB payload/result columns, progress tracking (0–100 + message), and indexed for query performance.
- **Job creation API** — `POST /api/companies/:companyId/background-jobs` creates a job (board-only). Returns HTTP 201 with the job row.
- **Job list/detail API** — `GET .../background-jobs` (paginated, filterable by status/job type) and `GET .../background-jobs/:id`.
- **SSE event stream** — `GET .../background-jobs/events` streams job status changes in real time. Authenticated users must have `company_scope:read` permission.
- **Activity search → background job** — `POST /api/companies/:companyId/research/activities` now creates a background job instead of running inline. Returns HTTP 202 with a `jobId`.
- **`useJobStatus` React hook** — Polls every 2 seconds with optional SSE subscription for live updates (best-effort, falls back to polling).
- **`StatusCue`** — Compact inline job status indicator (colored dot, label, optional progress bar).
- **`IncompleteDataNotice`** — Banner shown while data is being prepared.
- **`ActivitySearchPanel`** — Search input + scope selector + job status display.

### M2: Process Visibility + Additional Job Types (VOY-1493)

The second milestone added the remaining job types, visual process indicators, and post-review hardening:

| Feature | Description |
|---------|-------------|
| **Auto-assess → background job** | `POST /api/companies/:companyId/research/auto-assess` now returns HTTP 202 with a `jobId` instead of running inline |
| **Keyword-first search + async semantic upgrade** | `POST /api/companies/:companyId/research/search` returns keyword results synchronously and optionally enqueues a semantic re-ranking job. The response includes a `semanticJobId` — clients subscribe to SSE for upgraded results |
| **PDF export** | `POST /api/companies/:companyId/exports/pdf` queues a PDF generation job using pdfkit. Returns HTTP 202. Payloads over 512 KB are rejected with HTTP 413 |
| **iCalendar export** | `POST /api/companies/:companyId/exports/ics` queues an iCalendar v2.0 generation job. Returns HTTP 202. Payloads over 512 KB are rejected with HTTP 413 |
| **BackgroundProcessTray** | Consolidated tray in the sidebar showing all background work for a company. Subscribes to SSE, falls back to 5-second polling. Running jobs sort to the top with progress bars and timing |
| **FreshnessCue / FreshnessDot** | Visual freshness/staleness indicators on research items — green (fresh, ≤7 days), amber (stale, ≤30 days), grey (unknown, >30 days) |
| **Skeleton loading** | `SkeletonBone` / `SkeletonText` components with `FadeIn` wrapper for non-blocking trip-page reveal |

### Post-Review Hardening (f81d572a40, M2 + VOY-1527/VOY-1531 hotfix)

All Staff Engineer findings from the M2 structural audit were addressed, and the 4 P0/P1 items that shipped unfixed now have hotfixes applied:

| Finding | Fix |
|---------|-----|
| **Transaction-atomic claim** | Job claim (`FOR UPDATE SKIP LOCKED` + status update to `running`) wrapped in a single `db.transaction()` — eliminates race where two workers could claim the same job |
| **Processor timeout** | Each processor runs under `Promise.race` with a 5-minute timeout (configurable). Prevents stuck jobs from blocking the queue |
| **Retry with exponential backoff** | Transient processor failures retry up to 2 times with delays of 1s, 2s, and 4s (capped at 30s). After all retries exhausted, job marked `failed` permanently |
| **candidateIds scoping** | `research.semantic_search` processor accepts optional `candidateIds` to scope semantic upgrade to the keyword-first result set the user saw. The route passes these automatically |
| **SSE authz enforcement** | SSE `/events` endpoint now checks `assertCompanyScopeReadAllowed`, matching the list and get-by-id routes |
| **Export payload size cap** | PDF and ICS export payloads over 512 KB are rejected with HTTP 413 at submission time |
| **DB CHECK constraints** | Migration 0144 adds CHECK constraints on `status`, `progress`, and `duration_ms` |
| **Partial queued index** | Partial index on `status = 'queued'` serves the worker's claim query |
| **Graceful shutdown** | Worker supports draining in-flight jobs with a configurable grace period (default 30s) |
| **emitEvent try/catch guard** (VOY-1527 P0) | `emitEvent()` wrapped in try/catch so SSE subscriber disconnect cannot propagate to retry loop. Adds terminal-status WHERE clause to `update()` preventing overwrite of succeeded/failed rows |
| **Stale-job recovery startup sweep** (VOY-1527 P0) | `createBackgroundJobWorker()` runs `requeueStaleJobs()` on startup, requeueing jobs stuck in `running` for longer than `processorTimeoutMs` + 30s grace. Emits live events for reactive UI update |
| **List endpoint slim projection** (VOY-1527 P1) | `toApi()` now supports `slim` parameter; `list()` passes `slim=true`, stripping `result.dataUri` from responses. Full result available via `getById()` |
| **Email digest ordering fix** (VOY-1527 P1) | Digest preference query (`SELECT digestFrequency`) now runs *before* the `initUpdates` block, so `emailDeferredToDigest` is correctly resolved before the init-update decision |

## Job Types

| Job Type | Processor | Result |
|----------|-----------|--------|
| `research.activity_search` | Keyword search over issues, documents, activity | `{ query, results, total }` |
| `research.semantic_search` | Keyword candidates + embedding cosine rerank (falls back to keyword when no embedding provider configured) | `{ query, upgraded, model, results, total }` |
| `research.auto_assess` | Heuristic freshness/completeness/relevance per research item | `{ assessedAt, items[] }` |
| `export.pdf` | pdfkit paginated PDF (title page, item cards, separators) — result carries base64 `dataUri` | `{ kind, title, items, generatedAt, dataUri }` |
| `export.ics` | iCalendar text builder (v2.0, VEVENT entries with sanitized fields) | `{ kind, title, calendarText, eventCount }` |

## Known Limitations

| Issue | Status |
|-------|--------|
| SSE is best-effort — UI falls back to polling on failure | Open |
| No job cancellation endpoint — schema has no `cancelled` status | Open |
| No job history/retention cleanup — terminal rows accumulate indefinitely | Open |
| Research routes use `company_scope:read` (read-level auth) for write operations — any agent or user with scope:read can enqueue jobs | Open (Staff Engineer recommendation C4) |
| No blob storage — export results embed base64 data (PDF) or calendar text (ICS) in the result object | Open |
| Semantic upgrade requires `PAPERCLIP_EMBEDDING_API_KEY` — falls back to keyword ranking without it | Open (infra config) |
| **Background job status can be overwritten by retry after SSE failure** — If an SSE subscriber disconnects during a job's success notification, the `emitEvent` failure propagates to the retry loop, causing the job to be re-executed or incorrectly marked `failed`. See [VOY-1527](https://github.com/voyonder/paperclip/issues/1527). | **RESOLVED** — `emitEvent` try/catch guard + terminal-status WHERE clause |
| **No stale-job recovery after process crash** — If the server process crashes mid-job, the job stays `running` forever and the UI shows an eternal spinner. No automatic recovery path exists. See [VOY-1527](https://github.com/voyonder/paperclip/issues/1527). | **RESOLVED** — startup sweep requeues stale-running jobs automatically |
| **Large export results inflate list responses** — PDF/ICS export results store full base64 data in the `result` column. The list endpoint returns these for every job, causing multi-MB responses on each tray poll. See [VOY-1527](https://github.com/voyonder/paperclip/issues/1527). | **RESOLVED** — list endpoint slim projection strips `result.dataUri` |
| **Email digest-deferred notifications show stale "pending" status** — When a notification type uses email+digest, `emailDeliveryStatus` shows "pending" indefinitely even though the email is correctly deferred to the next digest. See [VOY-1527](https://github.com/voyonder/paperclip/issues/1527). | **RESOLVED** — digest preference query runs before status init |

## Support Impact

### For Support Staff

| Change | What to know |
|--------|-------------|
| **Activity search now async** | Users see a "Search queued — results will appear shortly" message while the job runs. If this persists, verify the worker is running (restart server) |
| **Export generates via background job** | PDF/ICS requests return immediately with a job ID. The download must be constructed client-side from the job result (`result.dataUri` for PDF, `result.calendarText` for ICS) |
| **Export payload limit** | Payloads over 512 KB receive HTTP 413. Advise users to reduce item counts before exporting |
| **Semantic search is optional** | The search endpoint returns keyword results synchronously. Semantic upgrade is an enhancement — if it never arrives, check `PAPERCLIP_EMBEDDING_API_KEY` |
| **BackgroundProcessTray shows live progress** | Running jobs appear with progress bars at the top. The tray only renders when there are jobs |
| **Freshness indicators** | Research items show age via green/amber/grey dots. "Unknown" may indicate a timestamp parse failure |
| **SSE authz enforced** | The SSE `/events` endpoint requires `company_scope:read`. Users without this permission will see 404/forbidden |

### All Production Issues Resolved (VOY-1527 + VOY-1531)

The 4 P0/P1 issues that shipped with the release are now resolved:

1. **Job status corruption on SSE disconnect** — **RESOLVED.** `emitEvent()` is now wrapped in try/catch (logs warning, does not propagate), and `update()` includes a WHERE clause guard (`IN ('queued', 'running')`) preventing overwrite of terminal-status rows. SSE subscriber disconnect can no longer corrupt job status. See the `background-jobs.ts` and `background-job-worker.ts` hotfix for details.

2. **Eternal spinner after server crash** — **RESOLVED.** `createBackgroundJobWorker()` now runs `requeueStaleJobs()` on startup, which detects jobs stuck in `running` for longer than `processorTimeoutMs` + 30s grace and requeues them. The sweep emits live events for reactive UI update. Manual DB intervention is no longer needed.

3. **Slow tray responses due to large results** — **RESOLVED.** `toApi()` now accepts a `slim` parameter; `list()` calls it with `slim=true`, stripping `result.dataUri` from responses. The full result (including `dataUri`) remains available via `getById()`. Tray poll responses are no longer inflated by large export data.

4. **Email notifications show "pending" indefinitely** — **RESOLVED.** The digest preference query (`SELECT digestFrequency`) now runs *before* the `initUpdates` block, so `emailDeferredToDigest` is correctly resolved before the status init decision. Deferred emails no longer show stale "pending" status.

## Related Documentation

- [Async Jobs Internal Reference](/doc/async-jobs.md) — Full internal reference with architecture, API details, troubleshooting guide, and escalation paths
- [Background Jobs API](/api/background-jobs) — API reference for background job endpoints
- [Research API](/api/research) — API reference for research endpoints (activity search, auto-assess, keyword-first search)
- [Exports API](/api/exports) — API reference for PDF/ICS export endpoints

*Last updated: 2026-08-20 ~21:30 UTC — VOY-1527 P0/P1 hotfixes and VOY-1531 follow-up refinements resolved: emitEvent guard, stale-job recovery, list slim projection, email digest ordering. All production issues resolved.*
*Maintained by: Support Engineer (88b72065)*
