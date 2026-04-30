# Phase 49: Daily Work Kanban Core - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 49 makes the daily work kanban board the first operational work surface for RealTycoon2. It owns the core 3-lane board experience for daily work: operators can reach the board first, move cards between To-Do, Doing, and Done with immediate persisted feedback, and understand each card's Task/To-Do/deliverable/owner/due/OKR-KPI/price/quality state without deep navigation.

This phase should not build full quick edit, board filter/sort/search, One-Liner draft review, mobile/native capture promotion, or Jarvis/wiki/graph/economy evidence panels. Those are Phase 50-52. Phase 49 may expose read-only card metadata and minimal lane movement controls only where required by BOARD-01, BOARD-02, and BOARD-03.

</domain>

<decisions>
## Implementation Decisions

### First operational route
- **D-01:** Introduce a dedicated daily work board route as the company-prefixed default operational destination, using RealTycoon2/Korean-facing labels such as `일일 업무` or `업무 보드`.
- **D-02:** Change the company root/default redirect from the Phase 48 `one-liner` default to the daily board route. Keep `one-liner` as a valid route for capture so Phase 51 can wire capture into the board without breaking existing links.
- **D-03:** Sidebar priority should put the daily board before dashboard/inbox-style supporting surfaces. The first click in the app should feel like work execution, not analytics or control-plane inspection.

### Lane semantics
- **D-04:** The visible and canonical daily board lanes for Phase 49 are exactly `To-Do`, `Doing`, and `Done`, shown in Korean as `할 일`, `진행 중`, and `완료`.
- **D-05:** Replace the older daily-report lane vocabulary (`today`, `support_1`, `support_2` / `오늘 할 일`, `보조창 1`, `보조창 2`) for this primary board. If existing persisted data exists, map `today -> todo`, `support_1 -> doing`, and `support_2 -> done` through migration or compatibility normalization.
- **D-06:** Lane movement should persist to the same RT2 daily board read/write path, not to local UI state only. Successful movement must update the card state immediately and keep daily wiki/activity materialization intact.

### Card information density
- **D-07:** Card front content should include, without expansion: Task/To-Do type, title, owner/assignee, due date if present, OKR/KPI connection, deliverable count/title hint, base price/gold impact, and quality state.
- **D-08:** Use compact badges/chips for metadata. The board is a repeated daily operations surface; avoid large hero/card marketing layouts and avoid requiring deep navigation to understand whether a card is missing deliverable or OKR context.
- **D-09:** Owner display can start with `assigneeUserId` or existing `Identity` patterns. Rich user profile rendering is useful but not required if the existing user directory is not already available on the board route.

### Existing asset reuse
- **D-10:** Reuse `Rt2DailyBoard`'s daily-report API integration and cockpit data as the persistence/read source, but redesign its lane labels and card surface for the primary board.
- **D-11:** Reuse `KanbanBoard`'s 3-lane Korean visual language and compact metadata patterns where practical, especially `할 일 / 진행 중 / 완료`, card badges, drag/drop affordance, and board-card metadata display.
- **D-12:** Do not duplicate a separate board backend if `rt2DailyReportApi.getBoard` and `saveCard` can satisfy BOARD-01-03 after lane normalization. If shared types must change, update `packages/shared`, server validation, database check/migration, and focused tests together.

### Persistence and feedback
- **D-13:** Drag/drop and lane select changes should optimistically show the target lane while save is pending, then confirm with a small Korean state (`저장중`, `저장됨`, `저장 실패`) on the moved card or lane.
- **D-14:** Failed saves must roll back or clearly mark the card as unsaved; do not silently leave the card in a lane that the server rejected.
- **D-15:** Keep the existing live event behavior for `rt2.daily-report.updated` and `rt2.daily-wiki.updated`; Phase 49 should not invent a new realtime channel unless the existing one cannot invalidate the board view.

### Scope split with Phase 50-52
- **D-16:** Only lane/status movement belongs in Phase 49. Editing title, deliverable, base price, quality evaluation, OKR badge, filters, sort, and search are Phase 50.
- **D-17:** One-Liner capture appearing in the board lane/inbox and draft approval/revision are Phase 51. Phase 49 may leave an entry link or empty-state hint, but should not build capture promotion.
- **D-18:** Jarvis/wiki/graph/economy should stay as secondary context in this phase. The board may show summarized quality/OKR/deliverable/gold state, but detailed evidence panels belong to Phase 52.

### Verification
- **D-19:** Add or update focused component tests for `Rt2DailyBoard` to assert the `할 일 / 진행 중 / 완료` lanes, visible card metadata, drag/drop or lane-select save calls, and pending feedback.
- **D-20:** Add focused route/navigation tests for the new primary daily board route and default company redirect.
- **D-21:** Add or update server/shared tests around lane validation and persistence if the canonical lane values change. Existing `rt2-daily-report-routes.test.ts` is the right route-level evidence path.
- **D-22:** Verification should include `pnpm typecheck` and focused Vitest tests for changed UI/shared/server files. Run `pnpm test` if feasible; if host constraints or long-running suites block it, record focused evidence explicitly.

### the agent's Discretion
- Exact route segment name, with preference for a clear stable path such as `/daily-work` over overloading `/dashboard`.
- Exact compact badge order and Korean microcopy, provided all BOARD-03 metadata is visible on the card.
- Whether the implementation adapts `Rt2DailyBoard` in place or wraps it in a new page component, provided the old knowledge-page daily tab does not become the only access point.

</decisions>

<specifics>
## Specific Ideas

- Phase 48 explicitly deferred making the 3-lane daily work board the first operational surface to Phase 49.
- The current `Rt2DailyBoard` already persists daily card state and materializes daily wiki, but its lane language reads like `오늘 할 일 / 보조창 1 / 보조창 2`, which does not satisfy the BOARD-02 To-Do/Doing/Done requirement.
- The current `KanbanBoard` already has the right 3-lane Korean mental model and metadata density, but it is issue-board oriented rather than daily-report persistence oriented.
- The best Phase 49 result is a daily work board that feels like the RealTycoon2 home surface, with knowledge/Jarvis/economy signals present only as compact evidence on cards.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.8 product identity and daily work UX goal, brownfield constraints, and RT2-first product rule.
- `.planning/REQUIREMENTS.md` - `BOARD-01`, `BOARD-02`, and `BOARD-03` Phase 49 requirements.
- `.planning/ROADMAP.md` - Phase 49 goal and success criteria under v2.8.
- `.planning/STATE.md` - Current milestone state: Phase 48 complete, Phase 49 ready.
- `.planning/phases/48-rt2-identity-and-korean-shell/48-CONTEXT.md` - Locked Phase 48 decision that Phase 49 owns the daily board as first operational surface.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Daily Board And Work Board Code
- `ui/src/components/Rt2DailyBoard.tsx` - Existing daily board component, lane UI, save behavior, cockpit side panels, and card metadata.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Existing component test for 3-lane rendering and save calls.
- `ui/src/api/rt2-daily-report.ts` - Client API for daily board read/save/wiki query.
- `ui/src/pages/rt2/KnowledgePage.tsx` - Existing page that mounts `Rt2DailyBoard` behind the Knowledge daily tab.
- `ui/src/components/KanbanBoard.tsx` - Existing 3-lane work-board UX, Korean lane labels, drag/drop, and compact card metadata.
- `ui/src/App.tsx` - Company root redirect and route table; Phase 49 must change default operational route here.
- `ui/src/components/Sidebar.tsx` - Main navigation priority and visible Korean labels.

### Server, Shared Types, And Persistence
- `packages/shared/src/types/rt2-daily-report.ts` - Current daily board/card/lane type definitions.
- `packages/shared/src/validators/rt2-daily-report.ts` - Current lane/date/save validation.
- `server/src/routes/rt2-daily-report.ts` - Daily board route handlers and live event emission.
- `server/src/services/rt2-daily-report.ts` - Daily card read/save, deliverable/OKR/quality summary, activity log, and wiki materialization.
- `packages/db/src/schema/rt2_v33_daily_report_cards.ts` - Persisted daily report card lane/status schema and checks.
- `server/src/__tests__/rt2-daily-report-routes.test.ts` - Existing route-level persistence and wiki materialization test.
- `packages/db/src/rt2-daily-report-persistence.test.ts` - Existing DB persistence coverage for daily report cards.

### Related Board Metadata
- `ui/src/api/rt2-tasks.ts` - Existing work-board card metadata API client.
- `server/src/services/rt2-work-board.ts` - Due date, quality status, price, checklist, attachment, and capture draft service patterns.
- `packages/db/src/schema/rt2_work_board.ts` - Existing board card metadata tables for due date, quality, price, checklist, attachments, and capture drafts.
- `packages/shared/src/types/rt2-task.ts` - Existing work-board and capture draft shared types.
- `packages/shared/src/validators/rt2-task.ts` - Existing board card update and capture validation schemas.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `Rt2DailyBoard` already renders cards from `Rt2DailyBoardData`, saves per-card lane/progress/note through `onSaveCard`, and shows daily cockpit summaries.
- `rt2DailyReportApi.getBoard` and `saveCard` already provide the core read/write contract for daily board persistence.
- `rt2DailyReportService.listDailyBoard` already derives card deliverable count, base price total, quality state, OKR context, gap flags, and cockpit summary.
- `KanbanBoard` already implements the desired 3-lane Korean board pattern, drag/drop via `@dnd-kit`, compact badges, due/quality/price display, and card metadata controls.
- `LiveUpdatesProvider` already recognizes `rt2.daily-report.updated` and can support board invalidation without a new event type.

### Established Patterns
- Routes stay English path segments while visible labels are Korean.
- Product-facing UI now favors RealTycoon2-first Korean copy after Phase 48.
- UI tests are focused Vitest/jsdom tests beside components.
- Shared validators in `packages/shared` define API contracts used by both UI and server.
- Server route tests for RT2 flows use embedded Postgres when host support is available, with accepted host-skip behavior already documented.

### Integration Points
- Add or update an RT2 daily board page/route in `ui/src/App.tsx`.
- Update `CompanyRootRedirect` and unprefixed redirect coverage so the selected company opens the daily board first.
- Update `Sidebar.tsx` to expose the daily board as a primary top-level work item.
- Update `Rt2DailyBoard.tsx` and its tests to use To-Do/Doing/Done semantics and card metadata required by BOARD-03.
- If lane values change at the API/storage layer, update `packages/shared/src/types/rt2-daily-report.ts`, `packages/shared/src/validators/rt2-daily-report.ts`, `server/src/services/rt2-daily-report.ts`, `packages/db/src/schema/rt2_v33_daily_report_cards.ts`, and add a migration that maps old lane values safely.
- Update focused tests for component behavior, route/default navigation, and daily report persistence.

</code_context>

<deferred>
## Deferred Ideas

- Card quick edit for title, status, deliverable, base price, quality evaluation, and OKR badge belongs to Phase 50.
- Board filters for today, mine, missing deliverable, approval waiting, and quality issue belong to Phase 50.
- One-Liner capture appearing immediately in the board lane or inbox belongs to Phase 51.
- One-Liner suggested work type/deliverable/price-quality/OKR review belongs to Phase 51.
- Mobile/native/inbound draft duplicate warning and source evidence belong to Phase 51.
- Jarvis/wiki/graph/economy as detailed card evidence or supporting panels belongs to Phase 52.
- Broader identity regression gate beyond the route/navigation changes belongs to Phase 52.

</deferred>

---

*Phase: 49-daily-work-kanban-core*
*Context gathered: 2026-04-30*
