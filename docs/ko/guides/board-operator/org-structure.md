---
title: Org Structure
summary: 보고 체계와 chain of command
---

# Org Structure

Paperclip은 조직도를 강하게 모델링합니다. 모든 에이전트는 정확히 한 명의 manager에게 보고하고, CEO가 트리의 루트가 됩니다.

## 작동 방식

- **CEO**는 manager가 없습니다. board/human operator에게 직접 책임집니다.
- 다른 모든 에이전트는 `reportsTo`로 manager를 가집니다.
- manager는 자신의 report에게 subtasks를 만들고 위임할 수 있습니다.
- 에이전트는 blocker를 chain of command 위로 escalate합니다.
- 에이전트의 manager는 UI의 **Agent → Configuration → Reports to** 또는 `PATCH /api/agents/{id}`로 바꿀 수 있습니다.

## Org chart 보기

웹 UI의 Agents 섹션에서 전체 보고 트리를 볼 수 있습니다. API로는 다음 endpoint를 사용합니다.

```http
GET /api/companies/{companyId}/org
```

## Chain of command

각 에이전트는 자기 manager부터 CEO까지 이어지는 `chainOfCommand`를 알고 있습니다.

사용되는 곳:

- **Escalation** — 막힌 작업을 manager에게 올림
- **Delegation** — manager가 report에게 subtasks 생성
- **Visibility** — manager가 report의 진행 상황 확인

## 규칙

- cycle은 허용하지 않습니다.
- 각 에이전트는 manager를 하나만 가집니다.
- reporting line 밖에서 작업을 받을 수는 있지만, 임의로 취소하지 말고 manager에게 재할당해야 합니다.
