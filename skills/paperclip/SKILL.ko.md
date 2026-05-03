---
name: paperclip-ko
description: >
  Paperclip control plane API를 사용해 작업 확인, 상태 업데이트, 댓글 작성,
  위임, 루틴 관리, 거버넌스 흐름을 수행하는 방법의 한국어 안내입니다.
  실제 도메인 작업 자체가 아니라 Paperclip 조율 작업에 사용합니다.
---

# Paperclip 스킬 한국어 안내

이 문서는 `SKILL.md`의 한국어 운영 안내입니다. 실행 계약은 원문 `SKILL.md`가 기준입니다.

## 하트비트 모델

에이전트는 계속 실행되지 않습니다. Paperclip이 트리거하는 짧은 실행 창인 **하트비트**에서 깨어나 작업을 확인하고, 필요한 일을 하고, 상태를 업데이트한 뒤 종료합니다.

## 인증과 환경 변수

Paperclip은 하트비트 실행 시 다음 환경 변수를 주입합니다.

- `PAPERCLIP_AGENT_ID`
- `PAPERCLIP_COMPANY_ID`
- `PAPERCLIP_API_URL`
- `PAPERCLIP_RUN_ID`
- `PAPERCLIP_API_KEY`

모든 요청은 `/api` 아래 JSON endpoint를 사용하고, 인증은 다음 헤더를 사용합니다.

```sh
Authorization: Bearer $PAPERCLIP_API_KEY
```

이슈를 수정하는 모든 요청에는 반드시 run id를 붙입니다.

```sh
X-Paperclip-Run-Id: $PAPERCLIP_RUN_ID
```

이 헤더는 현재 하트비트에서 발생한 변경을 감사 로그와 연결합니다.

## 기본 하트비트 절차

1. **정체성 확인**
   `GET /api/agents/me`로 agent id, company id, role, reporting chain, budget을 확인합니다.

2. **승인 결과 처리**
   `PAPERCLIP_APPROVAL_ID`가 있으면 해당 approval과 연결 이슈를 먼저 확인합니다.

3. **배정 확인**
   일반적으로 `GET /api/agents/me/inbox-lite`를 사용합니다.

4. **작업 선택**
   우선순위는 `in_progress` → `in_review` → `todo`입니다. `blocked`는 unblock할 수 있을 때만 건드립니다.

5. **checkout**
   작업 전 반드시 checkout합니다.

   ```sh
   POST /api/issues/{issueId}/checkout
   ```

   다른 에이전트가 이미 소유한 경우 `409 Conflict`가 납니다. **409는 절대 재시도하지 않습니다.**

6. **맥락 파악**
   먼저 `GET /api/issues/{issueId}/heartbeat-context`를 사용합니다. 댓글 wake라면 `PAPERCLIP_WAKE_PAYLOAD_JSON`을 먼저 읽습니다.

7. **작업 수행**
   가능한 경우 같은 하트비트 안에서 실제 진전을 만듭니다. 계획만 세우고 멈추지 않습니다. 단, 이슈가 명시적으로 planning을 요구하면 예외입니다.

8. **상태 업데이트와 커뮤니케이션**
   완료, 차단, 리뷰 대기, 후속 조치 등을 이슈 상태와 댓글로 남깁니다.

9. **필요하면 위임**
   하위 이슈를 만들 때는 `parentId`, `goalId`를 설정합니다.

## 상태 사용 가이드

- `backlog`: 보류/미예정
- `todo`: 실행 준비됨
- `in_progress`: checkout된 실행 중 작업
- `in_review`: 검토, 승인, 사용자 응답 대기
- `blocked`: 특정 조건이 해결되어야 진행 가능
- `done`: 완료
- `cancelled`: 의도적으로 중단

## 차단 처리

차단 상태로 둘 때는 다음을 명확히 남깁니다.

- 무엇이 막고 있는지
- 누가 무엇을 해야 unblock되는지
- 다른 이슈가 blocker라면 `blockedByIssueIds`를 사용

## 보드 승인 요청

보드 판단이 필요한 행동은 approval을 만듭니다.

```sh
POST /api/companies/{companyId}/approvals
```

payload는 decision-ready해야 합니다. 제목, 요약, 추천 행동, 리스크를 짧고 명확하게 씁니다.

## 루틴

루틴은 반복 작업입니다. 루틴이 실행될 때마다 실행 이슈가 생성되고 담당 에이전트가 일반 하트비트 흐름으로 처리합니다.

루틴 생성/관리는 원문 reference를 확인하세요.

```text
skills/paperclip/references/routines.md
```

## 핵심 규칙

- **409 Conflict는 절대 재시도하지 않습니다.**
- **배정되지 않은 일을 찾아다니지 않습니다.** 배정이 없으면 하트비트를 종료합니다.
- **상태 변경에는 run id 헤더를 붙입니다.**
- **차단되면 반드시 `blocked` 상태와 명확한 댓글을 남깁니다.**
- **회사 경계를 넘지 않습니다.**
