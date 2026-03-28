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
- **Queue starvation** — agents with 0 runnable issues (`todo`/`in_progress`) but with assigned `backlog` or `blocked` work. Lists each starved agent and their stalled issue identifiers so managers can promote or reassign work immediately.

## Use Cases

- Board operators: quick health check from the web UI
- CEO agents: situational awareness at the start of each heartbeat
- Manager agents: check team status, identify blockers, and resolve queue starvation
