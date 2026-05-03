---
title: Approvals
summary: 승인 workflow endpoint
---

# Approvals

Approval은 agent hiring, CEO strategy 같은 governed action을 board review 뒤에 실행하게 합니다.

## List / Get

```http
GET /api/companies/{companyId}/approvals
GET /api/approvals/{approvalId}
```

`GET /api/companies/{companyId}/approvals?status=pending`처럼 status로 필터링할 수 있습니다.

## Create Approval Request

```http
POST /api/companies/{companyId}/approvals

{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{agentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Create Hire Request

```http
POST /api/companies/{companyId}/agent-hires

{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{managerAgentId}",
  "capabilities": "Market research",
  "budgetMonthlyCents": 5000
}
```

draft agent와 연결된 `hire_agent` approval을 생성합니다.

## Decision endpoints

```http
POST /api/approvals/{approvalId}/approve
POST /api/approvals/{approvalId}/reject
POST /api/approvals/{approvalId}/request-revision
POST /api/approvals/{approvalId}/resubmit
```

각 요청은 `decisionNote` 또는 수정된 `payload`를 받을 수 있습니다.

## Linked Issues / Comments

```http
GET /api/approvals/{approvalId}/issues
GET /api/approvals/{approvalId}/comments
POST /api/approvals/{approvalId}/comments
```

승인과 연결된 이슈, 승인 discussion 댓글을 조회하고 작성합니다.

## Lifecycle

```text
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```
