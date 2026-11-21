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

## Runs Without Final Usage

A run can stop before its provider sends final usage, for example after a restart or a Stop. Until Paperclip records its cost, the run counts against each budget at the larger of its recorded cost and its reservation (the policy's reserve per run). Other agents keep working while that total stays below the limit. The reserve is an owner-chosen amount. It is not a maximum, and the provider can charge more.

Paperclip records the cost by itself when it receives the final usage or can prove that the run stopped. If it cannot, a company owner can settle the run with an estimate 15 minutes after the run stopped. Paperclip refuses while the run may still be working, while its recovery or environment cleanup is still running, and for any run it will record by itself:

```
GET /api/companies/{companyId}/costs/runs/{runId}/settlement
POST /api/companies/{companyId}/costs/runs/{runId}/settlement
{ "idempotencyKey": "...", "expectedRevision": "<revision from GET>", "estimatedCents": "250", "reason": "Provider console", "confirmStopped": true }
```

The owner confirms that the run stopped. The estimate cannot be lower than the recorded cost. Paperclip records one estimated charge, keeps the recorded usage as an audited correction, and releases the reservation. The estimate is not a provider charge. A provider receipt that arrives later is kept for review and is never charged again.
