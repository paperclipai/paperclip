# Phase 10: Daily Report and OKR/KPI Cockpit - Context

**수집일:** 2026-04-25
**상태:** 계획 및 실행 완료

<domain>

## Phase Boundary

이 Phase는 기존 project `Daily` tab과 daily report API를 RealTycoon2 운영자가 매일 쓰는 cockpit으로 끌어올린다. 범위는 일일보고 화면의 3패널 구조, task/to-do 중심 입력, 산출물과 품질/gold/XP 영향 요약, 그리고 작업 항목에서 Project/OKR 맥락으로 올라가는 traceability다.

</domain>

<decisions>

## Implementation Decisions

### Cockpit 구조

- **D-01:** 새 top-level 앱을 만들지 않고 기존 `ProjectDetail`의 `daily` tab을 cockpit으로 확장한다.
- **D-02:** 3패널은 왼쪽 navigation/context, 가운데 report/task editor, 오른쪽 Jarvis/detail 요약으로 구현한다.
- **D-03:** 기존 daily lane board는 유지하되 가운데 editor 영역으로 이동시켜 사용자가 익숙한 흐름을 버리지 않는다.

### 일일보고 내용

- **D-04:** daily board API가 화면에서 필요한 task, to-do, deliverable, 품질 상태, gold/XP 영향, AI 요약을 한 번에 반환한다.
- **D-05:** gold/XP 영향은 Phase 9의 immediate reward와 같은 방향의 deterministic estimate로 보여주며, 실제 ledger settlement는 별도 경제/품질 governance가 확정한다.

### OKR/KPI 추적

- **D-06:** task의 `goalId`를 우선 사용하고, 없으면 project의 `goalId` 또는 `project_goals` 연결을 fallback으로 사용한다.
- **D-07:** goal parent chain이 있으면 Mission/Objectives/KR 스타일 path로 표시한다. 현재 DB의 `level` 값은 그대로 보여주며 억지로 새 schema를 만들지 않는다.
- **D-08:** 진행률/KPI 신호는 현재 Phase에서는 daily report card와 to-do status/progress를 bottom-up summary로 집계한다.

### Gap 표시

- **D-09:** 산출물이 없는 작업은 `missing_deliverable`로 표시한다.
- **D-10:** 사용할 수 있는 task/project goal context가 없는 작업은 `missing_okr_context`로 표시한다.

</decisions>

<canonical_refs>

## Canonical References

### Product 기준

- `.planning/REQUIREMENTS.md` - `DAILY-01`, `DAILY-02`, `OKR-01`, `OKR-02`, `OKR-03` 완료 기준.
- `.planning/DEVPLAN-ALIGNMENT.md` - 개발기획서 대비 일일보고/OKR gap 기준.
- `AGENTS.md` - RealTycoon2 identity, Daily Report System, OKR/KPI hierarchy, Deliverable-first rule.

### Existing implementation

- `server/src/services/rt2-daily-report.ts` - daily board/wiki read model.
- `server/src/routes/rt2-daily-report.ts` - company-scoped daily report API.
- `packages/shared/src/types/rt2-daily-report.ts` - UI/API shared daily board contract.
- `ui/src/components/Rt2DailyBoard.tsx` - daily cockpit UI surface.
- `ui/src/pages/ProjectDetail.tsx` - project `daily` tab integration.

</canonical_refs>

<code_context>

## Existing Code Insights

### Reusable Assets

- `Rt2DailyBoard` already rendered three daily lanes and save actions.
- `rt2DailyReportService` already knew assigned to-dos, task parent, persisted card state, and daily wiki materialization.
- `issueWorkProducts` already stores RT2 deliverable metadata including `rt2BasePrice` and `rt2State`.
- `goals`, `projects`, `projectGoals`, `rt2V33TaskProfiles.goalId` already provide enough OKR context for a read model.

### Integration Points

- `GET /companies/:companyId/rt2/daily-report` now returns `cockpit`.
- `PUT /companies/:companyId/rt2/daily-report/cards/:todoIssueId` returns an enriched `card` plus `wikiPage`.
- `Rt2DailyBoard` reads `board.cockpit` without adding a new route.

</code_context>

<specifics>

## Specific Ideas

- 운영자 첫 화면은 “오늘 뭘 했고, 어떤 산출물/OKR/gold 영향이 남았는지”를 빠르게 판단해야 한다.
- Paperclip-style issue board가 아니라 RealTycoon2 daily cockpit으로 보여야 한다.

</specifics>

<deferred>

## Deferred Ideas

- 실제 ledger settlement와 quality approval 반영은 Phase 12 또는 경제/품질 governance 후속 작업에서 더 엄격하게 연결한다.
- Mission/Objectives/KR 전용 schema 확장은 현재 DB의 generic `goals.level`이 부족해지는 시점에 별도 phase로 다룬다.

</deferred>

---

*Phase: 10-daily-report-and-okr-kpi-cockpit*
*Context gathered: 2026-04-25*
