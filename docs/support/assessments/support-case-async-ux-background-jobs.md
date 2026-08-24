---
title: Support Case Assessment — Async UX / Background Jobs (M1+M2)
version: voy-1474, voy-1493, voy-1527
date: 2026-08-21
status: Live — see known issues below
applies_to: All deployments after 2026-08-20
---

# Support Case Assessment: Async UX / Background Jobs System

## Feature Overview

The async UX release converted long-running operations from synchronous blocking calls to fire-and-forget background jobs. Five job types are registered:

| Job Type | What it does | Trigger |
|----------|-------------|---------|
| `research.activity_search` | Keyword search over issues, documents, and activity | `POST /api/research/search` |
| `research.semantic_search` | Semantic re-ranking of keyword results (embedding-based) | Automatic after keyword search, via SSE |
| `research.auto_assess` | AI assessment of research items (freshness, completeness, relevance) | `POST /api/research/autoAssess` |
| `export.pdf` | PDF generation via PDFKit — base64 dataUri result | `POST /api/exports/pdf` |
| `export.ics` | iCalendar v2.0 generation — calendar text result | `POST /api/exports/ics` |

Jobs follow a lifecycle: `queued → running → succeeded | failed`

## User-Facing Behaviour

- **Activity search** — User sees "Search queued — results will appear shortly" while the job runs.
- **Exports** — PDF/ICS requests return immediately with a job ID. The download must be constructed client-side from the job result.
- **Research auto-assessment** — Fire-and-forget; results appear asynchronously with freshness/staleness indicators (green ≤7 days, amber ≤30 days, grey >30 days).
- **BackgroundProcessTray** — Consolidated sidebar tray shows all jobs for the company. Running jobs sort to top with progress bars. Tray only renders when jobs exist.
- **SSE (Server-Sent Events)** — The tray and search panel subscribe to a live event stream for real-time updates. Falls back to 5-second polling if SSE fails.

## Known Issues

| # | Issue | Status | Workaround |
|---|-------|--------|------------|
| 1 | SSE is best-effort — UI falls back to polling on failure | Open (by design) | None needed; fallback is automatic |
| 2 | No job cancellation endpoint — schema has no `cancelled` status | Open | Users must wait for completion or server restart (startup sweep requeues running jobs) |
| 3 | No job history/retention cleanup — terminal rows accumulate | Open | Scheduled DB cleanup may be needed for long-running deployments |
| 4 | Research routes use `company_scope:read` for write ops — any scope:read user can enqueue jobs | Open (Staff Engineer C4) | Monitor for unexpected job creation |
| 5 | No blob storage — export results embed base64 data (PDF) or calendar text (ICS) in the result object | Open | Large exports increase result size; consider external storage for production |
| 6 | Semantic upgrade requires `PAPERCLIP_EMBEDDING_API_KEY` — falls back to keyword ranking without it | Open (infra config) | Check env var if semantic results never arrive |

## Troubleshooting

### Symptom: Export returns HTTP 413

**Cause**: Payload exceeds 512 KB limit.

**Fix**: Reduce item count before exporting. The limit applies to the request body (research items, dates, configuration).

**User guidance**: "Your export request is too large. Try selecting fewer items or a shorter date range."

---

### Symptom: Background job stays "running" forever (eternal spinner)

**Cause**: The server process may have crashed mid-job before the VOY-1527 hotfix was applied (pre-hotfix deployments only).

**Fix**: Restart the server. The startup sweep (`requeueStaleJobs()`) detects jobs stuck in `running` for longer than `processorTimeoutMs + 30s` and requeues them automatically.

**If restart doesn't help**: Verify the worker loop is active (check server logs for "Job claimed" / "Job completed" messages). If the worker is not running, check for unhandled exceptions in the processor.

---

### Symptom: Search returns keyword results but semantic upgrade never arrives

**Cause**: `PAPERCLIP_EMBEDDING_API_KEY` is not set, or the embedding provider is unreachable.

**Fix**: Set the environment variable and restart the server. Without it, the semantic search falls back to keyword ranking — results are still functional, just not upgraded.

---

### Symptom: Tray response is very large / slow

**Cause**: Pre-hotfix deployments return full `dataUri` payloads in list responses (VOY-1527 P1 fix).

**Fix**: Apply the hotfix (commit `dd2a41f9a0`+). The list endpoint strips `result.dataUri` from responses; only the single-job endpoint returns the full result.

---

### Symptom: A completed job re-appears as failed

**Cause**: Pre-hotfix deployments allow retry loops to overwrite terminal statuses when `emitEvent()` throws (VOY-1527 P0 issue).

**Fix**: Apply the hotfix. The `update()` WHERE clause now includes `AND status IN ('queued', 'running')`, preventing overwrite of `succeeded` / `failed` rows.

---

### Symptom: Email notifications show "pending" indefinitely for digest users

**Cause**: Pre-hotfix deployments initialise `emailDeliveryStatus = 'pending'` before checking whether the notification is deferred to a digest (VOY-1527 P1 ordering bug).

**Fix**: Apply the hotfix. The digest preference query now runs before the status init block.

---

### Symptom: "No processor registered" error

**Cause**: An unknown `jobType` was submitted. Only the 5 registered types are valid.

**Fix**: Check the request payload for typos in the job type field. Any unknown type is immediately failed.

---

## Escalation Path

| Issue | Escalate To | Contact |
|-------|-------------|---------|
| Worker not processing jobs | Founding Engineer / CTO | Via GitHub issue |
| Embedding provider not configured | Infrastructure / DevOps | Check `PAPERCLIP_EMBEDDING_API_KEY` env var |
| Export payload limit too restrictive | CTO / Product | Currently 512 KB — adjustable in code |
| Persistent SSE disconnections | CTO / Staff Engineer | May require backend infrastructure review |
| Data integrity (job status corruption) | CTO (P0) | Fixed in hotfix — escalate if seen on patched deployments |
| UI tray not reflecting job status | Frontend team | Check SSE subscription and polling fallback |

## Related Documentation

- [Async UX Release Notes](../releases/voy-1474-async-ux.md) — Full release notes with all changes
- [Async Jobs Internal Reference](/doc/async-jobs.md) — Architecture, API, DB schema, worker configuration
- [Research API Reference](/api/research) — API docs for search, auto-assess
- [Exports API Reference](/api/exports) — API docs for PDF/ICS export

*Last updated: 2026-08-21*
*Maintained by: Support Engineer (88b72065)*