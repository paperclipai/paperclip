# Phase 50: Work Card Editing and Board Controls - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 50 makes the Phase 49 daily work board fast to operate repeatedly. It owns board-context quick edit for title, lane/status, deliverable, base price, quality state, and OKR badge, plus board controls for today, mine, missing deliverable, approval waiting, quality issue, sort, and search.

This phase should not build One-Liner capture promotion, mobile/native inbound draft review, or Jarvis/wiki/graph/economy detail panels. Those remain Phase 51 and Phase 52. Phase 50 may touch daily board data contracts and existing work-board metadata APIs only where needed to make board edits and controls consistent.

</domain>

<decisions>
## Implementation Decisions

### Quick Edit Surface
- **D-01:** Keep quick edit inside the board context, not as a deep issue-detail navigation flow. Use compact inline controls or a small card-level edit panel so operators can adjust repeated work fields without leaving `daily-work`.
- **D-02:** The default card view stays scan-first. Editing controls should appear on intent, such as an edit button, expanded area, focused field, or compact popover, rather than making every card permanently form-heavy.
- **D-03:** Save title, lane/status, deliverable, base price, quality state, and OKR badge independently enough that one failed field does not make the whole card look saved. Show Korean pending/success/failure feedback near the edited card.

### Editable Fields And Ownership
- **D-04:** Lane/status editing should continue through the Phase 49 daily report save path for daily lane state and must keep daily wiki/activity materialization intact.
- **D-05:** Title editing should update the underlying To-Do issue title through the existing issue/task route pattern rather than storing a daily-board-only title override.
- **D-06:** Deliverable title/type/required/base-price editing should reuse RT2 deliverable/work product metadata conventions from the task engine and work-board services. Do not create a parallel deliverable table for daily cards.
- **D-07:** Base price editing should write the same RT2 deliverable metadata used by `rt2DailyReportService` to compute `basePriceTotal`, so card badges, Gold summary, and economy evidence stay consistent.
- **D-08:** Quality state editing should reuse `Rt2BoardQualityStatus` where possible (`none`, `pending_review`, `reviewed`, `needs_work`) and map the daily card's current summary label to that richer board-control vocabulary.
- **D-09:** OKR badge editing should attach or clear the task-level `goalId`/profile goal relation, with project goal as fallback display only. The UI should distinguish "OKR inherited from project" from "OKR directly set on task" if the data contract can expose that without broad schema churn.

### Filter And Search Controls
- **D-10:** Implement the required filters as explicit operator chips/toggles: `오늘 업무`, `내 업무`, `산출물 누락`, `승인 대기`, and `품질 이슈`.
- **D-11:** Filters should be combinable and should filter cards across all lanes while preserving lane grouping. Empty lanes remain visible with Korean empty text so operators know the filter is active.
- **D-12:** `오늘 업무` should anchor to the board `reportDate`; `내 업무` should anchor to the current board actor/user. Do not add a new global assignee model unless existing user/member data is already available.
- **D-13:** `산출물 누락` should use existing `missing_deliverable` gap flags and `deliverableCount === 0`.
- **D-14:** `품질 이슈` should include cards with `qualityStatus` requiring review or rework, including `pending_review` and `needs_work` if the richer status is exposed.
- **D-15:** `승인 대기` should use existing approval/review signals if available in work products or board metadata. If no precise approval field exists, implement the narrowest safe proxy and label it conservatively, then document the limitation in tests or code context.
- **D-16:** Search should match visible card text and key metadata: To-Do title, task title, assignee, deliverable title, OKR/goal title, and status/quality labels. Prefer client-side filtering for the current board payload unless dataset size or missing metadata forces a server query.

### Sort And Lane Order
- **D-17:** Sorting must not mutate persisted lane/status or manual lane movement. Treat sort as view order unless the user performs an explicit lane/status edit.
- **D-18:** Provide a small set of practical sort modes: recently updated, due date if available, missing evidence first, quality issue first, and price/gold descending. The default should preserve the server/current board order from Phase 49.
- **D-19:** Search/filter/sort state should survive normal board refreshes during the session but does not need a new persisted user preference unless an existing local preference pattern is trivial to reuse.

### Data Contract Shape
- **D-20:** Prefer extending the existing daily board response with the minimum missing edit/control fields over introducing a second board read model. The daily board should remain the primary surface from Phase 49.
- **D-21:** Reuse `rt2WorkBoardService.getBoardOverview` and `updateBoardCard` for due/quality/price-style metadata where it fits, but avoid forcing daily board callers to stitch inconsistent data client-side if the server can return a cohesive daily card payload.
- **D-22:** If new route endpoints are needed, keep them narrow and board-owned: update card title/status, upsert card deliverable/base price, update card quality, update task OKR. Validate shared schemas in `packages/shared` and route tests together.

### Product Copy And Layout
- **D-23:** All product-facing control labels, empty states, save states, validation messages, and filter chips should be Korean-first and RealTycoon2-facing.
- **D-24:** Keep the board utilitarian and dense. Avoid hero sections, explanatory marketing copy, or large nested cards; this is a repeated daily operations surface.
- **D-25:** Use stable compact controls with no layout jumps: fixed-height toolbar, predictable lane widths, compact chips, and edit affordances that do not cause neighboring cards to shift unexpectedly.

### Verification
- **D-26:** Add or update focused `Rt2DailyBoard` component tests for quick edit controls, Korean save/failure states, required filters, search, and sort preserving lane grouping.
- **D-27:** Add shared/server route tests for any new update contracts covering title, deliverable/base price, quality, OKR, and approval/quality filter semantics.
- **D-28:** Keep existing daily report route tests green and extend them where daily board payload fields or save materialization change.
- **D-29:** Verification should include `pnpm typecheck` and focused Vitest tests for changed UI/shared/server files. Run `pnpm test` if feasible; if Windows host constraints or long-running embedded Postgres suites block it, record focused evidence explicitly.

### the agent's Discretion
- Exact edit affordance, provided the board remains scan-first and quick edits do not require deep navigation.
- Exact filter toolbar visual treatment, provided the five required filter concepts are visible, composable, and Korean-labeled.
- Whether filter/search/sort are implemented fully client-side or with small server support, based on the fields available in the daily board payload.

</decisions>

<specifics>
## Specific Ideas

- Phase 49 already made `daily-work` the first operational board and explicitly deferred title, deliverable, base price, quality, OKR, filters, sort, and search to Phase 50.
- `Rt2DailyBoard` already has lane, bucket, progress, note edit controls and save feedback. Phase 50 should refine that into a board quick-edit experience and add the missing business fields rather than replacing the board.
- `KanbanBoard` already demonstrates an expandable card edit area, compact metadata badges, checklist/attachment controls, quality and price fields, and DnD behavior that can be reused conceptually.
- The strongest outcome is a board where an operator can narrow to "산출물 누락" or "품질 이슈", fix the card in place, and see the badge/summary update without losing lane position.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.8 product identity and daily work UX goal, RT2-first product rule, and current Phase 50 focus.
- `.planning/REQUIREMENTS.md` - `BOARD-04` and `BOARD-05` Phase 50 requirements.
- `.planning/ROADMAP.md` - Phase 50 goal and success criteria under v2.8.
- `.planning/STATE.md` - Current milestone state: Phase 48 and 49 complete, Phase 50 ready.
- `.planning/phases/49-daily-work-kanban-core/49-CONTEXT.md` - Locked scope split and daily board data/persistence decisions feeding Phase 50.
- `.planning/phases/48-rt2-identity-and-korean-shell/48-CONTEXT.md` - Korean-first RealTycoon2 product-surface decisions.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Daily Board Code
- `ui/src/components/Rt2DailyBoard.tsx` - Primary daily board component, current inline card controls, save feedback, filters insertion point, and card metadata rendering.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Existing component coverage for lanes, visible metadata, select save, and drag/drop save.
- `ui/src/api/rt2-daily-report.ts` - Client API for daily board read/save/wiki query.
- `packages/shared/src/types/rt2-daily-report.ts` - Current daily board/card/lane/gap types.
- `packages/shared/src/validators/rt2-daily-report.ts` - Current daily board save/list validation.
- `server/src/routes/rt2-daily-report.ts` - Daily board route handlers and live event emission.
- `server/src/services/rt2-daily-report.ts` - Daily card read/save, deliverable/OKR/quality summary, gap flags, activity log, and wiki materialization.
- `server/src/__tests__/rt2-daily-report-routes.test.ts` - Route-level evidence for daily board persistence and wiki materialization.

### Work Board And Editable Metadata
- `ui/src/components/KanbanBoard.tsx` - Existing compact card metadata, expandable card edit area, quality/price controls, checklist/attachment controls, and 3-lane board UX.
- `ui/src/api/rt2-tasks.ts` - Existing work-board overview and update client APIs.
- `packages/shared/src/types/rt2-task.ts` - `Rt2BoardCardMeta`, `Rt2BoardQualityStatus`, board overview, deliverable/task/todo summary types.
- `packages/shared/src/validators/rt2-task.ts` - Existing update board card, deliverable, capture, and task/todo validation schemas.
- `server/src/services/rt2-work-board.ts` - Existing board card metadata update, filters summary, capture/deliverable promotion, and semantic context patterns.
- `packages/db/src/schema/rt2_work_board.ts` - Existing due date, quality, price, checklist, attachment, and capture draft tables.
- `server/src/__tests__/rt2-task-routes.test.ts` - Existing task/work-board route coverage for deliverables, board overview/update, capture, and quality/price metadata.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Rt2DailyBoard` already groups cards into `할 일 / 진행 중 / 완료`, keeps per-card drafts, saves daily card lane/bucket/progress/note, supports drag/drop, and displays save states.
- `rt2DailyReportService.listDailyBoard` already derives deliverable count, submitted deliverables, base price total, quality status, OKR context, and gap flags.
- `rt2DailyReportService.saveDailyCard` already writes activity log entries and materializes daily wiki after board edits.
- `KanbanBoard` already has compact card badges, an expandable edit area, status/quality/price controls, and stable 3-lane visual language.
- `rt2WorkBoardService.getBoardOverview` already returns filter metadata for lanes, assignees, OKR IDs, quality statuses, and due buckets.
- `rt2WorkBoardService.updateCard` already updates due date, quality status, price gold, and detail notes for issue-linked board cards.

### Established Patterns
- Routes can remain English path segments while product-facing labels are Korean.
- Shared validators in `packages/shared` define contracts consumed by UI and server.
- Daily board saves should preserve RT2 activity log and wiki materialization, not bypass them with UI-only state.
- Server route tests use embedded Postgres where available; focused UI tests use Vitest/jsdom beside the component.
- Phase 49 made the daily board primary; Phase 50 should extend that board rather than reviving a separate legacy issue-board-first workflow.

### Integration Points
- Update `Rt2DailyBoard.tsx` with a compact toolbar for filters/search/sort and a card-level quick edit affordance.
- Extend `Rt2DailyReportCard` or compose it with existing `Rt2BoardCardMeta` if needed to expose deliverable title, richer quality status, approval/review state, direct/inherited OKR context, and due/filter fields.
- Add client API helpers in `ui/src/api/rt2-daily-report.ts` or reuse `rt2TasksApi` helpers where the endpoint already matches the field ownership.
- Add shared validators for any new update payloads in `packages/shared`.
- Add route/service handlers in `server/src/routes/rt2-daily-report.ts`, `server/src/services/rt2-daily-report.ts`, or narrow existing RT2 task routes based on field ownership.
- Update `server/src/__tests__/rt2-daily-report-routes.test.ts`, `server/src/__tests__/rt2-task-routes.test.ts`, and `ui/src/components/Rt2DailyBoard.test.tsx` for focused coverage.

</code_context>

<deferred>
## Deferred Ideas

- One-Liner capture appearing immediately in a board lane or inbox belongs to Phase 51.
- One-Liner suggested work type, deliverable, price/quality hint, and OKR/KPI review belongs to Phase 51.
- Mobile/native/inbound draft duplicate warning and source evidence belongs to Phase 51.
- Jarvis/wiki/graph/economy detail panels and broader identity regression gate belong to Phase 52.
- Persisted personal board-control preferences can be a future enhancement unless an existing local preference pattern makes it nearly free.

</deferred>

---

*Phase: 50-work-card-editing-and-board-controls*
*Context gathered: 2026-04-30*
