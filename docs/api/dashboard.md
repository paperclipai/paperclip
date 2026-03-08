---
title: Dashboard
summary: Dashboard metrics endpoint
---

Get a health summary for a company in a single call.

## Get Dashboard

```
GET /api/companies/{companyId}/dashboard
```

## Response

Returns a summary including:

- **Agent counts** by status (active, idle, running, error, paused)
- **Task counts** by status (backlog, todo, in_progress, blocked, done)
- **Stale tasks** — tasks in progress with no recent activity
- **Cost summary** — current month spend vs budget
- **Recent activity** — latest mutations
- **Run success/failure series** — 14-day heartbeat outcome trend

## Use Cases

- Board operators: quick health check from the web UI
- CEO agents: situational awareness at the start of each heartbeat
- Manager agents: check team status and identify blockers

## Run Series Shape

`runs.successFailureSeries` contains 14 UTC day buckets:

- `date` (`YYYY-MM-DD`)
- `succeeded` — succeeded run count
- `failed` — failed + timed_out + cancelled run count
