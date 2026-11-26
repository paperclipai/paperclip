---
title: Costs
summary: Cost events, summaries, and budget management
---

Track token usage and spending across agents, projects, and the company.

For how budgets behave, see [Costs and Budgets](/guides/board-operator/costs-and-budgets).

## Report Cost Event

```
POST /api/companies/{companyId}/cost-events
{
  "agentId": "{agentId}",
  "provider": "anthropic",
  "model": "claude-sonnet-4-20250514",
  "inputTokens": 15000,
  "outputTokens": 3000,
  "costCents": 12,
  "billingType": "metered_api",
  "occurredAt": "2026-11-24T10:00:00Z"
}
```

`occurredAt` is required. `billingType` is optional and defaults to `unknown`. Its values are `metered_api`, `subscription_included`, `subscription_overage`, `credits`, `fixed`, and `unknown`.

An agent can report only its own costs.

Typically reported automatically by adapters after each heartbeat. Adapters record usage that is included in a subscription with the billing type `subscription_included` and a cost of 0 cents.

## Company Cost Summary

```
GET /api/companies/{companyId}/costs/summary
```

Returns total spend, the monthly company budget, and utilization.

## Costs by Agent

```
GET /api/companies/{companyId}/costs/by-agent
```

Returns per-agent cost breakdown.

## Costs by Project

```
GET /api/companies/{companyId}/costs/by-project
```

Returns per-project cost breakdown.

## Report Period

The cost reports above use the current UTC calendar month by default. To change the period, add query parameters:

- `from` and `to` — an ISO date or an ISO date-time with an offset
- `period=all` — all recorded costs. Do not combine it with `from` or `to`

## Subscriptions and Provider Quota

```
GET /api/companies/{companyId}/costs/subscriptions
GET /api/companies/{companyId}/costs/quota-windows
```

`costs/subscriptions` returns the subscription accounts that the caller can see, with their monthly fees. `costs/quota-windows` returns the quota windows that each connected subscription provider reports, with the percent used and the reset time.

Both are board-only. Both are separate from budgets.

## Budget Management

A budget is a budget policy on one scope: `company`, `agent`, or `project`. Only board users can change budgets.

Budgets count billed cost in cents (`billed_cents`). Usage with the billing type `subscription_included` has a cost of 0 cents, so it never moves a budget toward its limit. A hard stop and `reservationCents` still apply to runs on a subscription.

### Budget Overview

```
GET /api/companies/{companyId}/budgets/overview
```

Returns every budget policy with its observed spend, status (`ok`, `warning`, or `hard_stop`), and window. Also returns the open budget incidents and the number of paused agents and projects.

### Set Company Budget

```
PATCH /api/companies/{companyId}/budgets
{ "budgetMonthlyCents": 100000 }
```

### Set Agent Budget

```
PATCH /api/agents/{agentId}/budgets
{ "budgetMonthlyCents": 5000 }
```

Both calls set a budget for the UTC calendar month. A value of `0` turns the budget off.

`PATCH /api/companies/{companyId}` and `PATCH /api/agents/{agentId}` still accept `budgetMonthlyCents` and set the same budget.

### Set Any Budget Policy

```
POST /api/companies/{companyId}/budgets/policies
{
  "scopeType": "project",
  "scopeId": "{projectId}",
  "windowKind": "lifetime",
  "amount": 20000
}
```

| Field | Default | Meaning |
|-------|---------|---------|
| `scopeType` | — | `company`, `agent`, or `project`. Required |
| `scopeId` | — | The ID of the company, agent, or project. Required |
| `windowKind` | `calendar_month_utc` | `calendar_month_utc` or `lifetime` |
| `amount` | — | The limit in cents. Required for a new policy. `0` turns the budget off |
| `warnPercent` | `80` | The percent of the limit at which the warning opens. From 1 to 99 |
| `notifyEnabled` | `true` | Whether the warning opens |
| `hardStopEnabled` | `true` | Whether work stops when spend reaches the limit |
| `reservationCents` | `0` | An estimate held against the budget before each run starts |
| `unpricedUsagePolicy` | `block` | `block` or `allow`. What to do when a complete usage receipt has no reliable price |
| `isActive` | `true` | Set `false` to turn the policy off and keep its amount |

A scope has one policy for each window kind. A second call with the same scope and window updates the policy. Fields you leave out keep their value.

The project page in the UI sets project budgets with the `lifetime` window. If you leave `windowKind` out of this call, the policy uses `calendar_month_utc`.

### Resolve a Budget Incident

```
POST /api/companies/{companyId}/budget-incidents/{incidentId}/resolve
{ "action": "raise_budget_and_resume", "amount": 150000 }
```

| Action | Effect |
|--------|--------|
| `raise_budget_and_resume` | Sets the limit to `amount`, removes the budget pause, and continues the runs that the hard stop cancelled. `amount` is required and must be more than the observed spend |
| `keep_paused` | Dismisses the incident. The scope stays paused |

## Budget Enforcement

| Threshold | Effect |
|-----------|--------|
| `warnPercent` of the limit (default 80%) | A warning incident opens. Work continues |
| 100% of the limit, when `hardStopEnabled` is on (default) | A hard-stop incident opens. The scope is paused with the pause reason `budget`. New runs are refused and running work is told to stop |

Monthly windows reset on the first of each month (UTC). At the reset, Paperclip closes the open incident of a monthly budget and removes its budget pause. A `lifetime` budget does not reset.
