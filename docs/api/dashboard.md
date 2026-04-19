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
- **Stale issues** — compact `staleIssues` entries for blocked work and inactive `in_progress` work
- **Cost summary** — current month spend vs budget
- **Work value estimate** — current month token usage translated into configurable human developer value
- **Recent activity** — latest mutations in `recentActivity`
- **Live runs** — queued or running heartbeats in `liveRuns`

### Additional response fields

- `staleIssues[]`
  - `id`, `identifier`, `title`, `status`, `priority`
  - `assigneeAgentId`, `assigneeUserId`
  - `staleReason` (`blocked` or `inactive`)
  - `updatedAt`, `latestCommentAt`, `latestActivityAt`, `lastMovementAt`
  - `activeRunId`
- `recentActivity[]`
  - the standard activity event fields plus `issueIdentifier` and `issueTitle` when the event is issue-linked
- `liveRuns[]`
  - `id`, `status`, `invocationSource`, `triggerDetail`
  - `startedAt`, `finishedAt`, `createdAt`
  - `agentId`, `agentName`, `adapterType`, `issueId`
- `costs.workValue`
  - `totalTokens`, `inputTokens`, `cachedInputTokens`, `outputTokens`
  - `aiSpendCents`, `estimatedDevHours`, `estimatedDevValueCents`, `estimatedSavingsCents`, `roiMultiple`
  - `devValueHourlyRateCents`, `devValueTokensPerHour`

## Use Cases

- Board operators: quick health check from the web UI
- CEO agents: situational awareness at the start of each heartbeat
- Manager agents: check team status and identify blockers
