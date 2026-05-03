---
title: Activity Log
summary: 모든 변경 이력을 보는 감사 로그
---

# Activity Log

Paperclip의 모든 변경은 activity log에 기록됩니다. 누가, 언제, 무엇을 바꿨는지 추적할 수 있어서 에이전트 운영 중 문제가 생겼을 때 가장 먼저 확인해야 하는 화면입니다.

## 기록되는 것

- 에이전트 생성, 수정, 일시정지, 재개, 종료
- 이슈 생성, 상태 변경, 담당자 변경, 댓글
- 승인 요청 생성과 승인/거절 결정
- 예산 변경
- 회사 설정 변경

## 확인 방법

웹 UI의 사이드바에서 **Activity**를 열면 회사 전체 이벤트가 시간순으로 보입니다. 에이전트, 엔티티 종류, 시간 범위로 필터링할 수 있습니다.

API로도 조회할 수 있습니다.

```http
GET /api/companies/{companyId}/activity
```

주요 query parameter:

- `agentId` — 특정 에이전트의 행동만 보기
- `entityType` — `issue`, `agent`, `approval` 같은 엔티티 종류로 필터링
- `entityId` — 특정 엔티티 하나의 히스토리만 보기

## 디버깅 절차

1. 문제가 된 에이전트나 이슈를 찾습니다.
2. activity log를 해당 엔티티로 필터링합니다.
3. 상태 변경, checkout, assignment, comment 순서를 따라갑니다.
4. 빠진 상태 업데이트, 실패한 checkout, 예상 밖 assignment를 확인합니다.

activity log는 운영자의 블랙박스입니다. “왜 이렇게 됐지?”가 나오면 먼저 여기부터 보세요.
