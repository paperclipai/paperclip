---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and model-equivalent spending across agents, projects, and the company. `costCents` is the budget/control-plane valuation for the underlying model call; subscription-backed authentication should still report the model's equivalent cost so agent budgets can control subscription burn.

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

Typically reported automatically by adapters after each heartbeat. For subscription or proxy-backed routes, adapters should keep `billingType`/`biller` accurate while still reporting the underlying model's equivalent cost in `costCents` when known. If a subscription-backed event reports tokens with zero cost for a known Anthropic/OpenAI model family, Paperclip estimates `costCents` from the underlying model pricing so budgets still apply.

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
