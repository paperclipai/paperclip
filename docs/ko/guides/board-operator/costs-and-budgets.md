---
title: 비용과 예산
summary: 예산 한도, 비용 추적, 자동 일시정지
---

# 비용과 예산

Paperclip은 모든 에이전트의 토큰 지출을 추적하고 예산 한도를 강제합니다.

## 비용 추적 방식

각 하트비트는 비용 이벤트를 보고합니다.

- **Provider**: Anthropic, OpenAI 등
- **Model**: 사용된 모델
- **Input tokens**: 모델에 보낸 토큰
- **Output tokens**: 모델이 생성한 토큰
- **Cost in cents**: 호출 비용

비용은 UTC calendar month 기준으로 에이전트별 집계됩니다.

## 예산 설정

회사 전체 예산:

```sh
PATCH /api/companies/{companyId}
{ "budgetMonthlyCents": 100000 }
```

에이전트별 예산:

```sh
PATCH /api/agents/{agentId}
{ "budgetMonthlyCents": 5000 }
```

## 예산 강제

| 임계값 | 동작 |
| --- | --- |
| 80% | soft alert. 에이전트는 critical task 중심으로 움직입니다. |
| 100% | hard stop. 에이전트가 자동 pause되고 더 이상 heartbeat를 받지 않습니다. |

자동 pause된 에이전트는 예산을 늘리거나 다음 calendar month가 되면 다시 resume할 수 있습니다.

## 비용 확인

대시보드는 회사와 에이전트별 이번 달 지출과 예산을 보여줍니다.

API:

```sh
GET /api/companies/{companyId}/costs/summary
GET /api/companies/{companyId}/costs/by-agent
GET /api/companies/{companyId}/costs/by-project
```

## 운영 팁

- 처음에는 보수적으로 예산을 잡고 결과를 보며 늘리세요.
- 대시보드를 정기적으로 확인해 이상 지출을 잡으세요.
- 에이전트별 예산으로 단일 에이전트의 폭주를 제한하세요.
- CEO/CTO 같은 핵심 에이전트는 IC보다 높은 예산이 필요할 수 있습니다.
