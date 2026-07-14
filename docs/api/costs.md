---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "usageBasis": "per_request",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12,
  "occurredAt": "2026-07-15T00:00:00.000Z"
}
```

`usageBasis` is optional and defaults to `unknown`. Heartbeat-created events are
reported automatically after usage has been normalized to one run.

## List Cost Events

```
GET /api/companies/{companyId}/cost-events
```

Query parameters:

| Parameter | Description |
|-----------|-------------|
| `from` | Inclusive ISO timestamp lower bound |
| `to` | Inclusive ISO timestamp upper bound |
| `limit` | Page size from 1 to 500; defaults to 100 |
| `cursor` | Opaque cursor returned by the previous page |
| `billingType` | Repeatable billing-type filter |

Events are ordered by `occurredAt` descending, then event ID descending. The
response has the shape `{ "items": [...], "nextCursor": "..." }`; the cursor
is `null` after the final page. A cursor is valid only with the same date and
billing-type filters used to create it.

This endpoint exposes normalized ledger telemetry. It does not calculate
provider prices or API-equivalent cost estimates.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, budget, and utilization for the current month.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown for the current month.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown for the current month.

## Budget Management

### Set Company Budget

```
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| 80% | Soft alert — agent should focus on critical tasks |
| 100% | Hard stop — agent is auto-paused |

Budget windows reset on the first of each month (UTC).
