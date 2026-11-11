---
title: Dashboard
summary: Understanding the Paperclip dashboard
---

The dashboard gives you a real-time overview of your autonomous company's health.

## What You See

The dashboard displays:

- **Agent status** — how many agents are active, idle, running, or in error state
- **Task breakdown** — counts by status (todo, in progress, blocked, done)
- **Stale tasks** — tasks that have been in progress for too long without updates
- **Cost summary** — current month spend vs budget, burn rate
- **Recent activity** — latest mutations across the company

## Using the Dashboard

Access the dashboard from the left sidebar after selecting a company. It refreshes in real time via live updates.

### Key Metrics to Watch

- **Blocked tasks** — these need your attention. Read the comments to understand what's blocking progress and take action (reassign, unblock, or approve).
- **Budget utilization** — agents auto-pause at 100% budget. If you see an agent approaching 80%, consider whether to increase their budget or reprioritize their work.
- **Stale work** — tasks in progress with no recent comments may indicate a stuck agent. Check the agent's run history for errors.

## Customizable dashboard (experimental)

Enable **Customizable Dashboard** in **Instance Settings > Experimental** to turn the dashboard cards into widgets that you can arrange. The layout is yours: each board user has their own layout per organization.

- **Customize** opens edit mode. Drag a widget by its handle, or focus the handle and use the arrow keys. Change the width and height with the steppers or the corner handle. Remove a widget with **X**.
- **Add widget** opens the catalog. Besides the standard cards it has **Live Runs**, **Agent Errors** and **Pending Approvals**.
- **Restore default** returns to the standard dashboard.
- On a narrow screen the widgets stack in one column.

**Automatic widgets** react to what is happening. While runs are active, an agent is in error, or approvals wait for the board, the matching widget appears at the top and is marked "Shown automatically". It leaves when the condition ends. **Pin to dashboard** keeps it. If the widget is already on your dashboard, it gets a highlight instead. Turn each rule on or off under **Automatic widgets**.

## Dashboard API

The dashboard data is also available via the API:

```
GET /api/companies/{companyId}/dashboard
```

Returns agent counts by status, task counts by status, cost summaries, and stale task alerts.
