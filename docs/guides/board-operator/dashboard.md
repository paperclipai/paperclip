---
title: Dashboard
summary: Understanding the Paperclip dashboard
---

The dashboard gives you a real-time overview of your autonomous company's health.

## What You See

The dashboard displays:

- **Agent status** — how many agents are active, idle, running, or in error state
- **Task breakdown** — counts by status (todo, in progress, blocked, done)
- **Stale issues** — blocked work plus inactive `in_progress` work that has gone quiet
- **Cost summary** — current month spend vs budget, burn rate
- **Developer value estimate** — tracked agent tokens converted into a configurable human developer value estimate
- **Recent activity** — latest mutations across the company
- **Live runs** — queued or running heartbeats tied to current work

## Using the Dashboard

Access the dashboard from the left sidebar after selecting a company. It refreshes in real time via live updates.

### Key Metrics to Watch

- **Blocked tasks** — these need your attention. Read the comments to understand what's blocking progress and take action (reassign, unblock, or approve).
- **Budget utilization** — agents auto-pause at 100% budget. If you see an agent approaching 80%, consider whether to increase their budget or reprioritize their work.
- **Estimated developer value** — use this as a directional ROI indicator. It is based on tracked tokens plus the company's configured hourly rate and tokens-per-hour assumptions, not an accounting-grade replacement-cost calculation.
- **Stale work** — review `staleIssues` first. `blocked` items are stalled immediately; inactive `in_progress` items are the ones with no active run and no recent movement.
- **Live runs** — compare `liveRuns` against open work to see whether execution is actually happening or whether the company has gone quiet.

## Dashboard API

The dashboard data is also available via the API:

```
GET /api/companies/{companyId}/dashboard
```

Returns agent counts by status, task counts by status, cost summaries, and stale issue alerts.

The response also includes additive compact summaries in `staleIssues`, `recentActivity`, and `liveRuns`.
