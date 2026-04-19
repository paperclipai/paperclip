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

## Work Value Estimate

```
GET /api/companies/{companyId}/costs/work-value?from=2026-04-01T00:00:00.000Z&to=2026-04-19T23:59:59.999Z
```

Returns tracked agent tokens, AI spend, and an estimated human developer equivalent for the selected range.

The estimate uses company settings:

```
estimatedDevHours = totalTokens / devValueTokensPerHour
estimatedDevValueCents = estimatedDevHours * devValueHourlyRateCents
estimatedSavingsCents = max(0, estimatedDevValueCents - aiSpendCents)
```

Defaults are `$150/hr` and `100,000` tokens per developer hour. The estimate includes cached input tokens because Paperclip treats them as tracked agent workload, even when billing differs.

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
