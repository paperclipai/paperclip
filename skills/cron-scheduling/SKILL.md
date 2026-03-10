---
name: cron-scheduling
description: >
  Manage recurring cron job schedules for agents. Use when you need to create,
  update, list, or delete scheduled tasks that wake agents on a cron expression.
  Only for manager agents (agents with direct reports) — manage schedules for
  yourself and agents that report to you.
tags: [scheduling, cron, automation, manager]
version: 1.0.0
---

# Cron Job Scheduling

## Who Can Use This

This skill is for **manager agents only** — agents that have other agents reporting to them. You may manage cron jobs for:

- **Yourself** — schedule your own recurring tasks
- **Your direct reports** — agents whose `reportsTo` is your agent ID

Before using these endpoints, verify you are a manager by checking your identity and the agent list:

```
GET /api/agents/me
GET /api/companies/{companyId}/agents
```

Filter the agent list for agents where `reportsTo === yourAgentId`. If no agents report to you, you are not a manager and should not create cron jobs — ask your manager to set them up instead.

## What Cron Jobs Do

A cron job wakes an agent on a schedule with a specific message. Unlike the basic heartbeat timer (single interval, no payload), cron jobs support:

- **Cron expressions** — `0 9 * * 1-5` (9am weekdays), `*/15 * * * *` (every 15 min)
- **Timezones** — run at local business hours, not just UTC
- **Per-job messages** — each job delivers specific instructions to the agent's prompt
- **Multiple schedules per agent** — one agent can have many different scheduled tasks
- **Stagger** — randomized delay to prevent thundering herd

When a cron job fires, the agent wakes up and sees the job's `message` in its prompt. The agent should treat this message as its primary instruction for that heartbeat.

## Cron Expression Syntax

Standard 5-field format: `minute hour day-of-month month day-of-week`

| Expression | Meaning |
|---|---|
| `*/5 * * * *` | Every 5 minutes |
| `0 * * * *` | Every hour on the hour |
| `0 9 * * 1-5` | 9:00 AM, Monday through Friday |
| `0 7-18 * * 1-6` | Every hour from 7am-6pm, Mon-Sat |
| `0 9,17 * * *` | 9:00 AM and 5:00 PM daily |
| `30 2 * * 0` | 2:30 AM every Sunday |
| `0 0 1 * *` | Midnight on the 1st of each month |

## API Endpoints

All endpoints require `Authorization: Bearer $PAPERCLIP_API_KEY`.

### List Cron Jobs

```
GET /api/companies/{companyId}/cron-jobs
GET /api/companies/{companyId}/cron-jobs?agentId={agentId}
GET /api/companies/{companyId}/cron-jobs?enabled=true
```

### Create a Cron Job

```
POST /api/companies/{companyId}/cron-jobs
{
  "agentId": "uuid-of-target-agent",
  "name": "Nightly maintenance",
  "description": "Clean up stale data and run health checks",
  "cronExpr": "0 2 * * *",
  "timezone": "America/New_York",
  "staggerMs": 30000,
  "enabled": true,
  "payload": {
    "message": "Run nightly maintenance: clean up stale data, check system health, and report any issues."
  }
}
```

**Required fields:** `agentId`, `name`, `cronExpr`
**Defaults:** `timezone: "UTC"`, `staggerMs: 0`, `enabled: true`, `payload: {}`

The `payload.message` field is key — this is what the agent sees in its prompt when the job fires.

### Get a Cron Job

```
GET /api/companies/{companyId}/cron-jobs/{id}
```

### Update a Cron Job

```
PATCH /api/companies/{companyId}/cron-jobs/{id}
{
  "cronExpr": "0 9 * * 1-5",
  "enabled": false,
  "payload": { "message": "Updated instructions here" }
}
```

Any subset of fields can be updated. Changing `cronExpr`, `timezone`, or `enabled` automatically recomputes `nextRunAt`.

### Delete a Cron Job

```
DELETE /api/companies/{companyId}/cron-jobs/{id}
```

### Trigger Immediately

```
POST /api/companies/{companyId}/cron-jobs/{id}/run
```

Returns `202 Accepted` with `{ "triggered": true, "runId": "..." }`. Fires the job immediately without affecting the regular schedule.

## Manager Workflow

### Setting Up Schedules for Your Team

1. **Get your identity and team:**
   ```
   GET /api/agents/me
   GET /api/companies/{companyId}/agents
   ```
   Filter for agents where `reportsTo` matches your ID.

2. **Check existing schedules:**
   ```
   GET /api/companies/{companyId}/cron-jobs
   ```

3. **Create jobs for each recurring need.** Write clear, actionable messages:

   Good: `"Check all open issues assigned to you. For any blocked > 24h, escalate to your manager with a status update."`

   Bad: `"Do stuff"`

4. **Monitor job health.** Check `consecutiveErrors` and `lastRunStatus` periodically. If a job is failing repeatedly, investigate and update or disable it.

### Adjusting Schedules

When a report's workload changes, update their cron jobs:

```
PATCH /api/companies/{companyId}/cron-jobs/{id}
{ "cronExpr": "0 9-17 * * 1-5", "payload": { "message": "New instructions" } }
```

To temporarily pause a job without deleting it:

```
PATCH /api/companies/{companyId}/cron-jobs/{id}
{ "enabled": false }
```

## Rules

- **Only manage agents you supervise.** Do not create cron jobs for agents outside your reporting chain.
- **Write specific messages.** The agent receives `payload.message` as its prompt — vague messages produce vague results.
- **Use appropriate intervals.** Don't schedule every minute unless truly needed. Each run costs budget.
- **Set timezone correctly.** Business-hours schedules need the right timezone to work properly.
- **Monitor errors.** If `consecutiveErrors` climbs, the job or the agent has a problem. Investigate before it wastes more budget.
- **Clean up unused jobs.** Delete jobs that are no longer needed rather than leaving them disabled indefinitely.
