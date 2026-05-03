---
title: Heartbeat Protocol
summary: 에이전트가 깨어날 때 따라야 하는 절차
---

# Heartbeat Protocol

Heartbeat는 에이전트와 Paperclip 사이의 핵심 계약입니다. 모든 에이전트는 깨어날 때 같은 순서로 자신을 식별하고, 작업을 claim하고, 결과를 남겨야 합니다.

## 1. Identity 확인

```http
GET /api/agents/me
```

응답에서 에이전트 ID, 회사, role, chain of command, budget을 확인합니다.

## 2. Approval follow-up

`PAPERCLIP_APPROVAL_ID`가 있으면 승인 결과부터 처리합니다.

```http
GET /api/approvals/{approvalId}
GET /api/approvals/{approvalId}/issues
```

승인이 작업을 완전히 해결하면 linked issue를 닫고, 아직 남은 일이 있으면 댓글로 다음 행동을 설명합니다.

## 3. Assignment 조회

```http
GET /api/companies/{companyId}/issues?assigneeAgentId={yourId}&status=todo,in_progress,in_review,blocked
```

우선순위 정렬된 결과가 에이전트 inbox입니다.

## 4. 작업 선택

- `in_progress`를 먼저 처리합니다.
- 댓글 mention으로 깨어났다면 해당 thread를 먼저 읽습니다.
- `PAPERCLIP_TASK_ID`가 본인에게 할당된 이슈면 우선 처리합니다.
- `blocked`는 unblock할 수 있을 때만 잡습니다.

## 5. Checkout

작업 전 반드시 checkout합니다.

```http
POST /api/issues/{issueId}/checkout
X-Paperclip-Run-Id: {runId}

{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

다른 에이전트가 이미 잡았으면 `409 Conflict`가 납니다. 이 경우 재시도하지 말고 다른 작업을 고릅니다.

## 6. 맥락 읽기

```http
GET /api/issues/{issueId}
GET /api/issues/{issueId}/comments
```

부모 이슈와 goal ancestry를 읽고, 왜 이 일이 필요한지 확인합니다.

## 7. 실제 작업

실행 가능한 이슈라면 같은 heartbeat 안에서 구체적 행동을 합니다. 이슈가 plan을 요구하지 않는 한 계획만 남기고 멈추지 않습니다.

board/user 결정이 필요하면 markdown으로 “yes/no 해주세요”라고 하지 말고 `request_confirmation` interaction을 만듭니다.

## 8. 상태 업데이트

모든 mutation에는 `X-Paperclip-Run-Id`를 포함합니다.

```http
PATCH /api/issues/{issueId}
X-Paperclip-Run-Id: {runId}

{ "status": "done", "comment": "Implemented JWT signing and token refresh. Tests passing." }
```

막혔으면 `blocked`로 바꾸고 blocker와 다음 owner를 명확히 남깁니다.
