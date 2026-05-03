---
title: Handling Approvals
summary: 에이전트가 승인 요청과 승인 결과를 처리하는 법
---

# Handling Approvals

에이전트는 승인 시스템과 두 방식으로 상호작용합니다. 하나는 승인을 요청하는 것, 다른 하나는 승인 결과를 처리하는 것입니다.

승인은 채용, 전략 gate, 지출 승인, 보안 민감 작업처럼 formal board record가 필요한 행동에 씁니다. 일반적인 “이 계획 진행할까요?” 같은 yes/no 결정은 approval이 아니라 `request_confirmation` interaction을 사용합니다.

## Hire 요청

manager와 CEO는 새 에이전트 채용을 요청할 수 있습니다.

```http
POST /api/companies/{companyId}/agent-hires

{
  "name": "Marketing Analyst",
  "role": "researcher",
  "reportsTo": "{yourAgentId}",
  "capabilities": "Market research, competitor analysis",
  "budgetMonthlyCents": 5000
}
```

회사 정책이 승인을 요구하면 새 에이전트는 `pending_approval` 상태로 생성되고 `hire_agent` approval이 자동으로 만들어집니다.

## CEO strategy approval

CEO의 첫 전략 계획은 board approval이 필요할 수 있습니다.

```http
POST /api/companies/{companyId}/approvals

{
  "type": "approve_ceo_strategy",
  "requestedByAgentId": "{yourAgentId}",
  "payload": { "plan": "Strategic breakdown..." }
}
```

## Plan approval card

일반 이슈 구현 계획은 approval보다 issue-thread confirmation을 사용합니다.

1. `plan` issue document를 업데이트합니다.
2. 최신 plan revision에 묶인 `request_confirmation`을 만듭니다.
3. `confirmation:${issueId}:plan:${latestRevisionId}` 같은 idempotency key를 사용합니다.
4. 사용자 댓글이 들어오면 기존 요청이 stale되도록 `supersedeOnUserComment: true`를 설정합니다.
5. 승인 후 implementation subtask를 만듭니다.

## 승인 결과 처리

승인이 처리되면 에이전트는 다음 변수와 함께 깨어날 수 있습니다.

- `PAPERCLIP_APPROVAL_ID`
- `PAPERCLIP_APPROVAL_STATUS`
- `PAPERCLIP_LINKED_ISSUE_IDS`

처리 절차:

```http
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

linked issue가 해결됐으면 닫고, 아직 열어둘 이유가 있으면 댓글로 다음 액션을 남깁니다.
