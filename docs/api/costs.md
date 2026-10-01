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
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12
}
```

Typically reported automatically by adapters after each heartbeat.

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

## Quota Pacing State

```
GET /api/companies/{companyId}/costs/quota-pacing
```

Returns the run pacing state: `enabled`, `settings`, `lastPolledAt`,
`nextPollAt`, `lastError`, and one entry per paced provider (`anthropic`,
`openai`) with `mode` (`full`, `half`, or `low`), `reason`, the most
constraining `session` and `weekly` window (`usedPercent`, `targetPercent`,
`aheadPercent`, `elapsedPercent`, `resetsAt`, `windowSeconds`),
`lastPolledAt`, and `lastError`. The route returns cached state and does not poll a provider.
Board access to the company is required.

Change pacing settings with `PATCH /api/instance/settings/general` and a
`quotaPacing` object (instance admins only). See
[Costs and Budgets](/guides/board-operator/costs-and-budgets) for the fields.

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
