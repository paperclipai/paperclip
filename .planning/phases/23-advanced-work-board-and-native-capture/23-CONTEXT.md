# Phase 23: Advanced Work Board and Native Capture - Context

**Gathered:** 2026-04-25  
**Status:** Ready for planning

<domain>
## Phase Boundary

이번 phase는 RealTycoon2 업무 보드를 반복 업무에 실제로 쓸 수 있는 Trello급 카드 기능으로 보강하고, mobile/native/messenger entry가 직접 업무를 만들지 않고 감사 가능한 inbound draft queue를 거쳐 Task/To-Do/Deliverable로 승격되게 만든다.

</domain>

<decisions>
## Implementation Decisions

### Work Board Parity
- **D-01:** `/issues` compatibility route는 유지하되 product-facing 기본 표면은 RealTycoon2 업무 보드다.
- **D-02:** checklist, due date, quality status, price, attachment preview는 RT2 전용 board metadata 저장소에 둔다.
- **D-03:** priority와 assignee는 기존 issue update contract를 계속 사용한다.
- **D-04:** board filter/sort는 lane/status, 담당자, OKR, due date, price, quality status를 지원한다.

### Native Capture Queue
- **D-05:** mobile/native/messenger inbound는 irreversible task 생성이 아니라 `review_required` draft를 만든다.
- **D-06:** queue는 duplicate, permission, source failure 상태를 draft별 audit trail로 남긴다.
- **D-07:** review 승격 대상은 Task/To-Do/Deliverable이며, 기존 One-Liner parser와 RT2 task engine/work product contract를 재사용한다.

### Scope Control
- **D-08:** store-distributed native app, Slack/Teams app installation, desktop file watcher는 future scope다.
- **D-09:** 내부 `Issue`/`/issues` 명칭 대개편은 하지 않는다. RealTycoon2-facing surface를 우선 완성한다.

</decisions>

<canonical_refs>
## Canonical References

### Product and Planning
- `AGENTS.md` — RealTycoon2 identity, Paperclip/Multica engine-only policy, Task/To-Do/Deliverable source-of-truth rules.
- `.planning/ROADMAP.md` — Phase 23 goal and success criteria.
- `.planning/REQUIREMENTS.md` — `TRELLO-03`, `TRELLO-04`, `TRELLO-05`, `CAPTURE-02`, `CAPTURE-03`.
- `.planning/DEVPLAN-ALIGNMENT.md` — remaining Trello advanced parity and native capture queue gap.

### Prior Phase Decisions
- `.planning/phases/09-friction-zero-capture-surfaces/09-CONTEXT.md` — inbound capture must create reviewed draft payloads.
- `.planning/phases/14-daily-kanban-trello-parity/14-VALIDATION.md` — advanced Trello details deferred to Phase 23.
- `.planning/phases/16-trello-based-realtycoon-work-board/16-CONTEXT.md` — `/issues` stays as compatibility route while user-facing board is RealTycoon2.
- `.planning/phases/22-settlement-governance-and-anti-gaming/22-VERIFICATION.md` — price/economy data should stay RT2-controlled and auditable.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `ui/src/components/KanbanBoard.tsx` — Trello-style lane board and card rendering.
- `ui/src/components/IssuesList.tsx` — view state, filters, sort controls, create dialog integration.
- `server/src/routes/rt2-tasks.ts` — company-scoped RT2 task and inbound draft route.
- `server/src/services/rt2-task-engine.ts` — Task/To-Do/Deliverable creation rules.
- `packages/shared/src/one-liner-draft.ts` — deterministic parser used by queue promotion.

### Integration Points
- `packages/db/src/schema/rt2_work_board.ts` stores board metadata and capture drafts.
- `ui/src/api/rt2-tasks.ts` exposes board metadata and capture queue mutations.
- `server/src/__tests__/rt2-v23-route-fallback.test.ts` verifies Phase 23 route contracts without embedded Postgres.

</code_context>

<specifics>
## Specific Ideas

사용자가 요구한 “페이퍼클립이 감춰진 Trello 기반의 완전한 RealTycoon2” 방향에 맞춰, route/type compatibility는 내부에 남기고 보드와 capture UX는 RealTycoon2 용어와 흐름으로 보이게 한다.

</specifics>

<deferred>
## Deferred Ideas

- 실제 iOS/Android app distribution.
- Slack/Teams OAuth installation과 public webhook HMAC/replay protection.
- `/issues` → `/tasks` route/type rename migration.

</deferred>

---

*Phase: 23-advanced-work-board-and-native-capture*  
*Context gathered: 2026-04-25*
