---
title: Dashboard
summary: Dashboard executive brief and board action queue endpoint
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
- **Cost summary** — current month spend vs budget
- **Budget incidents** — active incidents plus paused agent/project counts
- **Executive brief** — the board-level summary used by the dashboard UI:
  - `brief.health` — overall tone (`healthy`, `watch`, `at_risk`, `blocked`)
  - `brief.snapshot` — four summary cards for progress, risk, decisions, and spend
  - `brief.focusAreas` — the few workstreams where recent change is material
  - `brief.needsAttention` — ordered board action items such as blocked issues, failed runs, approvals, and join requests

## Use Cases

- Board operators: executive readout plus the next board actions to take
- CEO agents: situational awareness at the start of each heartbeat
- Manager agents: check team status and identify blockers
