---
title: Costs
summary: 비용 이벤트, 요약, 예산 관리
---

# Costs

agent, project, company 단위 token 사용량과 지출을 추적합니다.

## Report Cost Event

```http
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

대부분 heartbeat 종료 후 adapter가 자동으로 보고합니다.

## Cost summaries

```http
GET /api/companies/{companyId}/costs/summary
GET /api/companies/{companyId}/costs/by-agent
GET /api/companies/{companyId}/costs/by-project
```

현재 월의 total spend, budget utilization, agent/project별 비용 breakdown을 반환합니다.

## Budget management

```http
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }

PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## Budget enforcement

| Threshold | 효과 |
| --- | --- |
| 80% | soft alert. agent는 critical task에 집중해야 함 |
| 100% | hard stop. agent 자동 pause |

budget window는 매월 1일 UTC 기준으로 reset됩니다.
