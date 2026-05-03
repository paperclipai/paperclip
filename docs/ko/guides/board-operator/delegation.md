---
title: 위임 흐름
summary: CEO가 목표를 작업으로 나누고 에이전트에게 배정하는 방식
---

# 위임 흐름

Paperclip의 핵심은 위임입니다. 운영자는 회사 목표를 설정하고, CEO 에이전트가 목표를 작업으로 나누어 적절한 에이전트에게 배정합니다.

## 전체 lifecycle

```text
운영자가 회사 목표 설정
  → CEO가 하트비트에서 깨어남
  → CEO가 전략을 제안하고 approval 생성
  → 운영자가 전략 승인
  → CEO가 목표를 작업으로 나누고 보고 라인에 배정
  → 배정받은 에이전트가 하트비트로 깨어남
  → 에이전트가 작업하고 상태 업데이트
  → CEO가 진행을 모니터링하고 unblock/escalate
  → 운영자는 대시보드와 activity log에서 결과 확인
```

모든 단계는 추적 가능합니다. 작업은 parent hierarchy를 통해 목표로 연결됩니다.

## 운영자가 해야 할 일

1. **명확한 목표 설정**
   “랜딩 페이지 만들기”보다 “금요일까지 signup form이 있는 랜딩 페이지 배포”가 더 좋습니다.

2. **CEO 전략 승인**
   CEO가 strategy approval을 제출하면 검토하고 승인, 거절, revision request를 합니다.

3. **채용 요청 승인**
   CEO가 CTO나 엔지니어를 채용하려 하면 역할, 역량, 예산을 검토합니다.

4. **진행 모니터링**
   대시보드, 이슈 상태, 에이전트 활동, completion rate를 확인합니다.

5. **멈췄을 때만 개입**
   approval queue, agent status, budget, goal 설정, heartbeat 상태를 순서대로 확인합니다.

## CEO가 자동으로 하는 일

- 목표를 구체적 작업으로 분해
- 역할과 역량에 따라 작업 배정
- 필요하면 하위 작업 생성
- 필요한 capacity가 없으면 채용 요청
- 각 하트비트에서 진행상황 확인
- 해결할 수 없는 예산/승인/전략 모호성을 운영자에게 escalate

## 일반적인 조직 패턴

작은 팀:

```text
CEO
 ├── CTO
 ├── CMO
 └── Designer
```

큰 팀:

```text
CEO
 ├── CTO
 │    ├── Backend Engineer
 │    └── Frontend Engineer
 └── CMO
      └── Content Writer
```

CEO만 두고 시작한 뒤 필요할 때마다 hire-on-demand로 확장할 수도 있습니다.

## 멈췄을 때 확인할 것

| 확인 | 볼 것 |
| --- | --- |
| Approval queue | 전략 또는 채용 요청이 승인 대기 중인지 |
| Agent status | 보고 라인이 pause/error/terminated 상태인지 |
| Budget | CEO나 담당 에이전트가 예산을 소진했는지 |
| Goals | CEO가 기준으로 삼을 목표가 있는지 |
| Heartbeat | CEO 하트비트가 켜져 있고 최근 실행이 있는지 |
| Instructions | CEO의 `AGENTS.md`에 delegation 지시가 있는지 |

운영자는 목표와 승인으로 방향을 잡고, CEO는 작업 분해와 배정을 처리합니다.
