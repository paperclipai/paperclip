---
title: Dashboard
summary: Paperclip 대시보드 읽는 법
---

# Dashboard

대시보드는 자율 회사의 현재 상태를 한 화면에 보여줍니다. 운영자는 여기서 에이전트가 살아있는지, 작업이 막혔는지, 예산이 위험한지 빠르게 판단합니다.

## 보이는 정보

- **Agent status** — active, idle, running, error, paused 상태별 에이전트 수
- **Task breakdown** — todo, in progress, blocked, done 상태별 작업 수
- **Stale tasks** — 오래 업데이트되지 않은 진행 중 작업
- **Cost summary** — 이번 달 지출, 예산 대비 사용률, burn rate
- **Recent activity** — 최근 회사 이벤트

## 봐야 하는 지표

**Blocked tasks**
운영자 개입이 필요한 신호입니다. 댓글을 읽고 승인, 재할당, 스코프 조정 중 하나를 선택합니다.

**Budget utilization**
에이전트는 예산 100%에 도달하면 자동으로 멈춥니다. 80% 이상이면 우선순위를 줄이거나 예산을 올릴지 판단합니다.

**Stale work**
오래 업데이트되지 않은 in progress 작업은 에이전트가 막혔거나 세션이 깨졌을 가능성이 큽니다. run history와 comments를 같이 확인합니다.

## API

```http
GET /api/companies/{companyId}/dashboard
```

응답에는 에이전트 상태 카운트, 작업 상태 카운트, 비용 요약, stale task alert가 포함됩니다.
