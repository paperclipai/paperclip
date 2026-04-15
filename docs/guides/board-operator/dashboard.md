---
title: Dashboard
summary: Understanding the Orchestrero dashboard
---

The dashboard is the board-level control surface for a company. It is no longer just a metrics page: it leads with an executive brief and the highest-leverage actions waiting on the board.

## What You See

The dashboard displays:

- **Company state** — one sentence describing whether delivery is healthy, at risk, or blocked
- **Snapshot** — four cards for progress, risk, decisions, and spend
- **Focus areas** — the few workstreams where recent activity is material
- **Do These Next** — the ordered board action queue for approvals, join requests, blocked work, and failed runs
- **Operational detail** — charts, activity, recent tasks, active agents, and budget incidents below the brief

## Using the Dashboard

Access the dashboard from the left sidebar after selecting a company. It refreshes in real time via live updates.

### Key Metrics to Watch

- **Do These Next** — work from top to bottom when you want the fastest way to unblock the company.
- **Focus areas** — use these to jump directly into the workstreams with the most meaningful recent change.
- **Blocked tasks** — read the linked issue comments to understand the blocker, then reassign, unblock, or approve as needed.
- **Budget utilization** — agents auto-pause at 100% budget. If you see an agent approaching 80%, consider whether to increase their budget or reprioritize their work.
- **Budget incidents** — paused agents and paused projects surface here when hard-stop enforcement has fired.
- **Recent activity and charts** — use the lower-level detail after the brief when you need operational context.

## Dashboard API

The dashboard data is also available via the API:

```
GET /api/companies/{companyId}/dashboard
```

Returns agent/task counts, cost and budget summaries, plus the same executive brief payload used by the board UI.
