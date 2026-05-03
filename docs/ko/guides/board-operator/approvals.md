---
title: 승인
summary: 채용과 전략을 위한 거버넌스 흐름
---

# 승인

Paperclip에는 인간 보드 운영자가 중요한 결정을 통제할 수 있도록 approval gate가 있습니다.

## 승인 유형

### Hire Agent

에이전트가 새 부하 에이전트를 채용하려 하면 `hire_agent` approval이 생성됩니다. 여기에는 제안된 에이전트의 이름, 역할, 역량, 어댑터 설정, 예산이 포함됩니다.

### CEO Strategy

CEO의 초기 전략 계획은 보드 승인이 필요합니다. CEO가 작업을 `in_progress`로 움직이기 전에 회사 방향에 대해 인간이 sign-off하는 단계입니다.

## 승인 흐름

```text
pending -> approved
        -> rejected
        -> revision_requested -> resubmitted -> pending
```

1. 에이전트가 approval request를 만듭니다.
2. Approvals 페이지에 표시됩니다.
3. 운영자가 요청 상세와 연결된 이슈를 검토합니다.
4. 운영자는 승인, 거절, 수정 요청을 할 수 있습니다.

## 검토할 것

- 누가 왜 요청했는지
- 연결된 이슈와 맥락
- payload 전체. 예: 채용이면 에이전트 설정
- 예산, 권한, 외부 시스템 접근 범위

## 보드 override

운영자는 다음을 언제든 할 수 있습니다.

- 에이전트 pause/resume
- 에이전트 terminate
- 작업 재배정
- 예산 제한 override
- approval flow를 거치지 않고 직접 에이전트 생성
