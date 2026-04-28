# Phase 10: Daily Report and OKR/KPI Cockpit - Discussion Log

> 감사 추적용 문서다. 계획/구현 입력의 canonical source는 `10-CONTEXT.md`다.

**Date:** 2026-04-25
**Phase:** 10 - Daily Report and OKR/KPI Cockpit
**Mode:** `/gsd-discuss-phase 10 --auto --chain`

---

## Cockpit 구조

| Option | Description | Selected |
|--------|-------------|----------|
| 기존 Project Daily tab 확장 | 기존 routing/query/cache를 재사용하고 운영자 흐름을 끊지 않는다 | yes |
| 새 RT2 Daily 앱 생성 | 별도 navigation surface를 만들지만 scope가 커진다 | |

**결정:** 기존 `ProjectDetail` daily tab을 3패널 cockpit으로 확장했다.

## 일일보고 read model

| Option | Description | Selected |
|--------|-------------|----------|
| API 응답 확장 | UI가 daily cockpit을 한 번에 그릴 수 있다 | yes |
| UI에서 여러 API 조합 | 서버 변경은 적지만 화면이 느슨하고 중복 query가 늘어난다 | |

**결정:** `Rt2DailyBoard` shared contract에 `cockpit`을 추가했다.

## OKR/KPI 연결

| Option | Description | Selected |
|--------|-------------|----------|
| Task goal 우선, Project goal fallback | 현재 schema를 활용하면서 traceability를 제공한다 | yes |
| 새 Mission/Objective/KR schema 도입 | 더 정확하지만 Phase 10 범위를 넘는다 | |

**결정:** `rt2V33TaskProfiles.goalId`, `projects.goalId`, `project_goals`를 사용한다.

## Gap 표시

| Option | Description | Selected |
|--------|-------------|----------|
| Daily card에 gap flag 포함 | 운영자가 보완해야 할 항목을 즉시 본다 | yes |
| 별도 audit 화면으로 분리 | 정교하지만 daily workflow에서 멀어진다 | |

**결정:** `missing_deliverable`, `missing_okr_context`를 board/card/cockpit에 노출한다.

## Deferred Ideas

- ledger settlement와 quality approval의 실제 회계 반영은 후속 governance/economy phase에서 정교화한다.
- Mission/Objectives/KR 전용 schema는 generic `goals.level`이 한계가 될 때 별도 phase로 다룬다.
