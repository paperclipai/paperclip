# Phase 16: Trello-Based RealTycoon Work Board - Context

**Gathered:** 2026-04-25
**Status:** Ready for planning

<domain>
## Phase Boundary

이번 phase는 기존 `/issues` 기반 업무 표면을 RealTycoon2의 메인 Trello형 업무 보드로 감싸는 작업이다. 내부 API와 compatibility route는 유지하되, 사용자가 보는 기본 workflow는 Task/To-Do 카드, lane, drag/drop, 빠른 편집, 산출물/가격/OKR badge가 있는 RealTycoon2 업무 보드여야 한다.

</domain>

<decisions>
## Implementation Decisions

### 메인 업무 표면
- **D-01:** `/issues`의 기본 진입 경험은 list가 아니라 board다. 기존 list mode는 보조 보기로 남겨 둔다.
- **D-02:** localStorage key는 기존 `paperclip:issues-view`와 분리해 `realtycoon2:work-board`를 사용한다. 기존 Paperclip-shaped view preference가 새 메인 보드를 가리지 않게 한다.

### 카드 정보 구조
- **D-03:** 카드는 Task/To-Do type, identifier, title, 담당자, 우선순위, 산출물 수, 가격, OKR 연결 상태를 우선 노출한다.
- **D-04:** child issue가 있으면 상위 Task 카드에 To-Do count badge를 표시한다.
- **D-05:** `workProducts`가 있으면 산출물 count와 primary deliverable title을 표시하고, metadata의 `basePrice`, `basePriceCents`, `price`, `actualPrice`, `actualPriceCents` 중 가능한 값을 가격 badge로 합산한다.

### Trello형 조작
- **D-06:** drag/drop status 이동은 기존 `KanbanBoard`의 `@dnd-kit` 기반 동작을 유지한다.
- **D-07:** Trello quick edit에 해당하는 최소 조작으로 카드 내 lane/status select와 priority select를 제공한다.
- **D-08:** 각 lane과 board header에서 새 작업을 만들 수 있고, lane button은 해당 status를 생성 default로 전달한다.

### Scope Control
- **D-09:** 이번 phase에서는 DB schema나 route rename을 하지 않는다. 내부 `Issue` type, `/issues` route, `issuesApi`는 compatibility layer로 유지한다.
- **D-10:** native/mobile/messenger capture의 실제 앱 배포나 외부 Slack/Teams 설치 흐름은 `CAPTURE-01` contract 수준만 확인하고, 큰 구현은 후속 phase로 둔다.

### the agent's Discretion

보드 카드의 시각 밀도와 badge 색상은 기존 shadcn/tailwind 스타일을 따르며, 별도 디자인 시스템 재작성 없이 현재 컴포넌트에서 확장한다.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Product Direction
- `AGENTS.md` — RealTycoon2 identity, Paperclip/Multica engine-only policy, Task/To-Do/Deliverable/Jarvis terminology.
- `.planning/PROJECT.md` — v2.2 목표와 Trello 기반 RealTycoon2 작업 보드 요구.
- `.planning/REQUIREMENTS.md` — `TRELLO-01`, `TRELLO-02`, `CAPTURE-01`.
- `.planning/DEVPLAN-ALIGNMENT.md` — Phase 15 이후 정합성 약 85%, 남은 gap 중 Trello급 메인 업무 보드.

### Prior Phase Decisions
- `.planning/phases/15-identity-shell-hardening/15-CONTEXT.md` — Paperclip/Multica는 내부 engine/compatibility layer로 숨기고 product-facing 표면은 RealTycoon2/Jarvis/Task로 고정.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ui/src/components/KanbanBoard.tsx` — 기존 status lane drag/drop board. Phase 16에서 RealTycoon2 업무 보드 카드로 확장한다.
- `ui/src/components/IssuesList.tsx` — `/issues` page의 list/board toggle, filters, create dialog integration이 이미 존재한다.
- `ui/src/pages/Issues.tsx` — company-scoped task list data, live run data, update mutation 연결점.
- `ui/src/api/issues.ts` — status/priority update가 가능한 existing update API.
- `ui/src/components/NewIssueDialog.tsx` — Phase 15에서 Task/Sub-task 용어로 감싼 create dialog.

### Established Patterns
- `@dnd-kit/core`와 `@dnd-kit/sortable`을 이미 사용한다. Trello형 이동은 새 library 없이 유지한다.
- `Issue.workProducts`, `Issue.goal`, `Issue.parentId`는 카드 badge의 RealTycoon2 domain context로 재사용 가능하다.

### Integration Points
- `/issues` route는 유지하되 breadcrumb와 storage key, default view, visible copy를 RealTycoon2 업무 보드로 바꾼다.
- `onUpdateIssue`는 status/priority quick edit와 drag/drop 모두에서 동일하게 사용한다.

</code_context>

<specifics>
## Specific Ideas

사용자는 Paperclip 본체에 RealTycoon 장식을 단 형태가 아니라, 프론트엔드가 Trello 기반의 완전한 RealTycoon2 업무 보드로 보여야 한다고 명시했다. 따라서 이번 phase는 내부 engine rename보다 사용자 첫 화면과 조작 경험 전환에 집중한다.

</specifics>

<deferred>
## Deferred Ideas

- 실제 route rename(`/issues` → `/tasks`)과 shared type rename(`Issue` → `Task`)은 compatibility와 blast radius가 크므로 별도 migration phase로 다룬다.
- Slack/Teams/native/mobile capture의 실제 설치형 entrypoint는 Phase 16에서 보드 전환 후 후속 capture-hardening phase로 넘긴다.

</deferred>

---

*Phase: 16-trello-based-realtycoon-work-board*
*Context gathered: 2026-04-25*
