# Async jobs — background job system

## Overview

The async job system provides fire-and-forget background execution for
long-running or expensive operations. Jobs are stored in the
`background_jobs` PostgreSQL table and processed by an in-process worker
loop.

### Job lifecycle

```
queued → running → succeeded|failed
```

1. **queued** — A service or route calls `backgroundJobService.create()`.
2. **running** — The worker claims the job inside a `SELECT ... FOR UPDATE
   SKIP LOCKED` transaction and transitions it to `running`.
3. **succeeded** / **failed** — The processor either returns a result or
   throws. After exhausting retries (default: 2) the job is permanently
   marked `failed`.

Progress (0–100) and progress messages are published via the live-events
bus so the UI `BackgroundProcessTray` can reflect them in real time.

### API

| Endpoint | Returns | Notes |
|---|---|---|
| `POST /api/research/search` | `{ job }` | Creates a keyword-first search job; upgrades to semantic via SSE |
| `POST /api/research/autoAssess` | `{ job }` | Fire-and-forget assessment job |
| `POST /api/research/export` | `{ job }` | Creates PDF or ICS export job |
| `GET /api/background-jobs` | `BackgroundJob[]` | List — `dataUri` stripped (see below) |
| `GET /api/background-jobs/:id` | `BackgroundJob` | Full result including `dataUri` |

### Result projection (slim mode)

List responses (`GET /api/background-jobs`) strip the large `dataUri`
field from job results to avoid bandwidth amplification on tray polls and
DB TOAST bloat. The single-job endpoint (`GET /api/background-jobs/:id`)
always returns the full result.

- **Why**: Export jobs (PDF, ICS) store base64-encoded binary data in the
  result. Returning this on every tray poll would transfer multiple
  megabytes per request.
- **Behavior**: `list()` calls `toApi(row, slim=true)`, which sets
  `result.dataUri = undefined`. `getById()` calls `toApi(row)` without
  slim, preserving the full result.
- **Migration**: Clients that read `dataUri` from list responses must
  switch to `getById()` when they need the binary payload. Typically this
  means: display the tray item from the list, then fetch the full job on
  click/download.

### Worker startup sweep (stale-job recovery)

When the worker starts (`createBackgroundJobWorker().start()`), it runs a
one-time sweep that requeues any job stuck in `running` for longer than
`processorTimeoutMs + 30s`.

- **Why this matters**: If the server crashes or is hard-restarted while a
  job is `running`, that job would remain stuck forever, showing an
  eternal spinner in the UI tray.
- **How it works**: The sweep updates `status = 'queued'` for every row
  where `status = 'running' AND startedAt IS NOT NULL AND startedAt <
  cutoff`. The cutoff is `now - (processorTimeoutMs + 30_000)`.
- **Live events**: Each requeued job emits a live event so the UI tray
  immediately reflects the transition.
- **Safety**: The 30s grace period prevents race conditions with
  long-running processors that haven't yet finished. Only jobs that have
  been `running` longer than the processor timeout are considered truly
  stale.

### Guard: emitEvent never throws

The `emitEvent()` function publishes job status changes to WebSocket
subscribers via the live-events bus. It is wrapped in a **triple-guard**
to ensure it can never bring down a DB write:

1. `emitEvent()` itself wraps `publishLiveEvent()` in try/catch.
2. The catch block's `logger.warn()` is itself wrapped in try/catch.
3. Both the `create()` and `update()` call-sites wrap `emitEvent()` in
   an additional try/catch (redundant with #1, kept for defensive depth).

**Why**: A subscriber disconnect or SSE write error must never fail the
DB transaction that already committed. The job state is durable; the UI
tray catches up on next poll.

### Guard: terminal status overwrite prevention

The `update()` function's WHERE clause includes:
```sql
AND status IN ('queued', 'running')
```

Once a job reaches `succeeded` or `failed`, no further update can change
it. This prevents:

- A stale retry loop from flipping a succeeded job to failed.
- A late progress report from resurrecting a finished job.
- Any downstream live-event subscriber from observing a status regression.

If `update()` matches no row (because the status is terminal), it returns
`null`. Callers should handle this gracefully.

## Processors

Five job types are registered:

| `jobType` | Processor | Description |
|---|---|---|
| `research.activity_search` | `researchSearchService.searchKeywordFirst` | Keyword search over issues, documents, activity |
| `research.semantic_search` | `researchSearchService.upgradeSemanticResults` | Semantic ranking upgrade on keyword results |
| `research.auto_assess` | `researchSearchService.autoAssess` | AI assessment of research items |
| `export.pdf` | Inline PDFKit renderer | Generates a PDF, stores result as base64 `dataUri` |
| `export.ics` | Inline iCalendar builder | Generates ICS calendar text |

Unknown job types are immediately failed with "No processor registered".

## Worker configuration

| Option | Env var | Default | Description |
|---|---|---|---|
| `pollIntervalMs` | — | 2000 | How often the worker polls for queued jobs |
| `batchSize` | — | 5 | Max jobs claimed per poll tick |
| `processorTimeoutMs` | — | 300000 (5 min) | Per-processor timeout; timed-out jobs are failed |
| `maxRetries` | — | 2 | Transient failure retries (3 total attempts) |

### Timeout behaviour

Each processor runs inside a `Promise.race` with a timeout signal. If the
processor does not resolve within `processorTimeoutMs`, the job is failed
with `"Processor timed out after Nms"`. The retry loop uses exponential
backoff capped at 30 seconds.

### Shutdown

`worker.shutdown(gracePeriodMs)` stops the poll loop and waits up to
`gracePeriodMs` (default 30s) for in-flight jobs to complete. If any
remain after the deadline they are abandoned with a warning.

## DB schema

Table `background_jobs` (managed by `@paperclipai/db`):

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `company_id` | uuid | FK → companies |
| `job_type` | text | One of the 5 known types |
| `status` | text | `queued` / `running` / `succeeded` / `failed` |
| `payload` | jsonb | Input parameters |
| `result` | jsonb | Processor output (may contain `dataUri`) |
| `error` | text | Failure message |
| `progress` | integer | 0–100 |
| `progress_message` | text | Human-readable progress |
| `duration_ms` | integer | Elapsed wall-clock time |
| `created_by_actor_id` | uuid | FK → actors |
| `created_at` | timestamptz | |
| `started_at` | timestamptz | Set when claimed by worker |
| `finished_at` | timestamptz | Set on terminal status |
| `updated_at` | timestamptz | |

## Concurrency

The worker is company-agnostic — it processes all companies' jobs in a
single loop. Company-level isolation is enforced at the API layer (routes
filter by authenticated company). Multiple worker instances are safe:
each claim uses `FOR UPDATE SKIP LOCKED` inside a transaction, so two
workers never process the same job.

## Known issues

| # | Issue | Status | Workaround |
|---|---|---|---|
| 1 | PDF export stores base64 in result column (not blob storage) | Current behaviour | `dataUri` stripped from list responses; use `getById` for download |
| 2 | No worker health endpoint | Current design | Monitor via `background_jobs` table or tray UI |
| 3 | Processor timeout does not cancel underlying work | Current design | The timeout fails the job but the processor continues running until completion or next await |
| 4 | Stale-job sweep only runs at worker start | Current design | Restart the worker if stale jobs accumulate (e.g. after a crash) |

## Version history

| Date | Version | Changes |
|---|---|---|
| 2026-08-20 | v6 | Document emitEvent guard (triple-wrap), stale-job startup sweep, result projection (slim mode), terminal status guard |
