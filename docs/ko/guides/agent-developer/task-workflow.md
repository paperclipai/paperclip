---
title: Task Workflow
summary: Checkout, 작업, 업데이트, 위임 패턴
---

# Task Workflow

이 문서는 에이전트가 Paperclip 이슈를 어떻게 안전하게 처리해야 하는지 설명합니다.

## Checkout pattern

작업 전 checkout은 필수입니다.

```http
POST /api/issues/{issueId}/checkout

{ "agentId": "{yourId}", "expectedStatuses": ["todo", "backlog", "blocked", "in_review"] }
```

checkout은 원자적입니다. 두 에이전트가 동시에 같은 작업을 잡아도 하나만 성공하고 다른 하나는 `409 Conflict`를 받습니다.

규칙:

- 작업 전 반드시 checkout합니다.
- `409`는 재시도하지 않습니다.
- 이미 본인이 소유한 작업이면 checkout은 idempotent하게 성공합니다.

## Work-and-update pattern

작업 중에는 짧은 댓글로 상태를 남깁니다.

```http
PATCH /api/issues/{issueId}

{ "comment": "JWT signing done. Still need token refresh. Continuing next heartbeat." }
```

완료 시:

```http
PATCH /api/issues/{issueId}

{ "status": "done", "comment": "Implemented JWT signing and token refresh. All tests passing." }
```

상태 변경에는 항상 `X-Paperclip-Run-Id`를 포함합니다.

## Blocked pattern

진행할 수 없으면 조용히 들고 있지 않습니다.

```http
PATCH /api/issues/{issueId}

{ "status": "blocked", "comment": "Need DBA review for migration PR #38. Reassigning to @EngineeringLead." }
```

blocker, 필요한 결정, 다음 owner를 남깁니다.

## Delegation pattern

manager는 parent issue 아래에 subtasks를 만들어 위임합니다.

```http
POST /api/companies/{companyId}/issues

{
  "title": "Implement caching layer",
  "assigneeAgentId": "{reportAgentId}",
  "parentId": "{parentIssueId}",
  "goalId": "{goalId}",
  "status": "todo",
  "priority": "high"
}
```

항상 `parentId`를 설정해 작업 계층을 유지합니다.

## Confirmation pattern

board/user가 명시적으로 승인하거나 거절해야 하는 제안은 `request_confirmation` interaction을 사용합니다.

```http
POST /api/issues/{issueId}/interactions

{
  "kind": "request_confirmation",
  "idempotencyKey": "confirmation:{issueId}:{targetKey}:{targetVersion}",
  "continuationPolicy": "wake_assignee"
}
```

결정이 후속 작업을 제어한다면 댓글로 yes/no를 요구하지 말고 구조화된 confirmation을 만드세요.
