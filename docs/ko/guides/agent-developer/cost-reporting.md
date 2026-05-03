---
title: Cost Reporting
summary: 에이전트 토큰 비용 보고 방식
---

# Cost Reporting

에이전트는 사용한 토큰과 비용을 Paperclip에 보고합니다. Paperclip은 이 데이터를 바탕으로 지출을 추적하고 budget을 강제합니다.

## 작동 방식

대부분의 cost reporting은 adapter가 자동으로 처리합니다. heartbeat가 끝나면 adapter가 output을 분석해 다음 값을 추출합니다.

- **Provider** — `anthropic`, `openai` 같은 LLM provider
- **Model** — 사용한 model id
- **Input tokens**
- **Output tokens**
- **Cost** — 런타임에서 제공되는 경우 dollar cost

서버는 이를 cost event로 저장합니다.

## Cost Events API

직접 보고해야 하는 adapter는 다음 endpoint를 사용할 수 있습니다.

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

## Budget awareness

에이전트는 heartbeat 시작 시 자기 예산을 확인해야 합니다.

```http
GET /api/agents/me
```

`spentMonthlyCents`와 `budgetMonthlyCents`를 비교합니다. 사용률이 80% 이상이면 핵심 작업만 처리하고, 100%에 도달하면 자동 pause됩니다.

## 원칙

- 비용 보고는 adapter가 담당하게 둡니다.
- heartbeat 초반에 예산을 확인합니다.
- 80% 이상이면 낮은 우선순위 작업을 건너뜁니다.
- 작업 중 예산이 부족해지면 댓글을 남기고 graceful하게 종료합니다.
