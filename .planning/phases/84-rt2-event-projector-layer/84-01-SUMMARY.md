# 84-01 Summary — RT2 Event/Projector Layer Verification

본 요약서는 84-01 PLAN의 자동 검증 체계에 따라 RT2 이벤트/프로젝터 계층의 구현 상태를 점검하고, Plan이 정의한 3대 요구사항(RT2-01, RT2-02, RT2-03)을 충족하는지 기록합니다.

## ✅ RT2-01 — Append-Only Event Stream with Idempotency
- 증거 요약:
  - rt2_v33_domain_events.ts에서 companyIdempotencyUq 고유 인덱스가 존재합니다. (companyId, idempotencyKey) 조합, idempotencyKey가 NULL이 아닌 경우에 한해 적용됩니다.
    - 관련 코드: packages/db/src/schema/rt2_v33_domain_events.ts (고유 인덱스 정의)
  - RT2 도메인 이벤트를 append()에서 구현하며, idempotencyKey가 존재하면 이미 삽입된 기록이 있는지 확인하고 재삽입을 회피합니다. (replay-safe)
    - 관련 코드: server/src/services/rt2-domain-events.ts (append 구현부, lines 93-133)
  - appendAndProject()는 append() 호출 후 processEvent()를 통해 projector를 동작시킵니다. (RT2-01의 핵심 흐름)
    - 관련 코드: server/src/services/rt2-domain-events.ts (appendAndProject, lines 279-285)
  - processEvent()는 projector의 상태 머신으로, 이미 처리된 이벤트에 대해 재처리를 피하고, projectorState를 idle로 돌아가게 업데이트합니다.
    - 관련 코드: server/src/services/rt2-domain-events.ts (processEvent, lines 144-253)
  - rt2_v33_domain_events 테이블은 업데이트/삭제를 통해 이벤트를 수정하지 않으며, 이벤트는 오로지 추가(INSERT) 형태로 확장됩니다.

## ✅ RT2-02 — Multica Integration & Execution Lifecycle events
- 증거 요약:
  - rt2-task-execution.ts에서 실행 생명주기 각 상태 전환은 idempotencyKey를 가진 도메인 이벤트를 통해 기록됩니다. 예: enqueued, dispatched, started, completed, failed, cancelled, stale_cleaned, retried.
    - 예시 이벤트: rt2.execution.dispatched, rt2.execution.started, rt2.execution.completed, rt2.execution.failed, rt2.execution.cancelled, rt2.execution.stale_cleaned, rt2.execution.retried
    - 각 이벤트에 대한 idempotencyKey 포맷이 일관되게 생성됩니다 (예: rt2.execution.dispatched:${attemptId}).
    - 코드 위치: server/src/services/ rt2-task-execution.ts — appendExecutionEvent 호출부 및 각 상태 전환 함수(dispath, start, complete, fail, cancel, cleanupStale, retry)
      - dispatched: lines 391-404
      - started: lines 494-505
      - completed: lines 533-545
      - failed: lines 559-569
      - cancelled: lines 587-596
      - stale_cleaned: lines 631-643
      - retried: lines 677-689
  - heartbeatRunId와 runtimeServiceId는 실행 시도에 저장됩니다. dispatch 시점에 runtimeServiceId, heartbeatRunId가 반영됩니다.
    - 코드 위치: server/src/services/rt2-task-execution.ts (dispatch 경로, runtimeServiceId 및 heartbeatRunId 업데이트)
  - listTimeline은 도메인 이벤트(rt2_v33_domain_events)와 heartbeat 이벤트를 합쳐 타임라인을 구성합니다. 도메인 이벤트와 heartbeat 이벤트를 합친 후 time 순으로 정렬합니다.
    - 코드 위치: server/src/services/rt2-task-execution.ts (buildTimelineEvents, lines 228-258 및 260-310)

## ✅ RT2-03 — RT2-Native Work Entity Lifecycle
- 증거 요약:
  - RT2-native 도메인 이벤트 타입이 rt2-task-engine.ts에서 다수 확인됩니다. 예: rt2.task.created, rt2.deliverable.defined, rt2.todo.created, rt2.todo.started, rt2.participant.joined/assigned, rt2.participant.ended, rt2.task.capacity_changed 등.
    - 카운트 예시: task.created(2), deliverable.defined(4), todo.created(2), todo.started(2), participant.joined(1), participant.assigned(1), participant.ended(2), capacity_changed(2)
    - 코드 위치: server/src/services/rt2-task-engine.ts (다수의 이벤트 생성부 확인)
  - RT2-native 작업 엔티티는 executionAttemptId를 rt2_v33_execution_attempts.id와 연결합니다. RT2-native surfaces는 legacy WorkProduct 패턴을 사용하지 않습니다.
    - 관련 코드: rt2-task-engine.ts 및 rt2-task-execution.ts의 생성 흐름에서 executionAttemptId이 참조되는 패턴 확인
  - normalizeExecutionState는 UI 호환성 차원에서 claimed를 dispatched로 매핑합니다. (rt2-task-engine.ts, rt2-task-execution.ts에서 확인)
    - 관련 코드: rt2-task-engine.ts, rt2-task-execution.ts

## Verification 결과 요약
- Typecheck: 성공적
- 단위 테스트: domain/events test 및 task test 패스; server의 embedded Postgres 테스트는 Windows 이슈로 스킵(환경상 제한)되나, 테스트 존재 여부를 확인 완료
- Plan의 제시된 3대 요구사항(RT2-01, RT2-02, RT2-03) 모두 코드 레벨에서 구현 및 코드 주석/주석 검증으로 확인됨

## 산출물
- 84-01-SUMMARY.md가 생성되었습니다. 위치: .planning/phases/84-rt2-event-projector-layer/

다음 단계: STATE/ROADMAP 업데이트 여부 및 필요 시 PR/커밋 작업 수행.
