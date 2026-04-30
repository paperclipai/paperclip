# Phase 51: One-Liner to Board Capture Flow - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 51 connects One-Liner capture to the Phase 49-50 daily work board. It owns the operator flow where new web One-Liner work and mobile/native/inbound drafts appear on the board as reviewable work, can be approved or revised with suggested work type, deliverable, price/quality hints, and OKR/KPI candidate, and preserve duplicate warning plus source evidence.

This phase should not redesign the daily board lanes, rebuild card quick edit/filter/search/sort, or move Jarvis/wiki/graph/economy into detailed side panels. Those are already Phase 49-50 or Phase 52 concerns. Phase 51 may extend the daily board, One-Liner page, capture queue, and narrow RT2 task/capture APIs only where required by CAPTURE-01, CAPTURE-02, and CAPTURE-03.

</domain>

<decisions>
## Implementation Decisions

### Board Review Surface
- **D-01:** The daily work board is the primary capture review surface. New One-Liner work and inbound drafts should be visible from `daily-work` without forcing operators back to the legacy One-Liner page.
- **D-02:** Use a board-level inbox/review strip or lane-adjacent capture section rather than adding a fourth persisted kanban lane. The canonical work lanes remain `할 일`, `진행 중`, and `완료`.
- **D-03:** Review-required and duplicate drafts should remain visible until approved, failed, or marked as duplicate. Promoted drafts should disappear from the active review queue and appear as normal board cards after board data refresh.
- **D-04:** The One-Liner page can stay as the dedicated composition surface, but after successful web capture it should guide the operator back to the daily board and invalidate daily board/capture queue queries.

### Web One-Liner Promotion
- **D-05:** Prefer creating a reviewable capture draft from the web One-Liner input before final promotion, instead of bypassing review by immediately creating a task. This aligns web, mobile, native, Slack, Teams, and webhook capture under the same approval/revision model.
- **D-06:** A reviewed draft may promote to `task`, `todo`, or `deliverable` through the existing `promoteCaptureDraft` contract. The default recommended target for a standalone One-Liner is `task`; if the operator selects an existing task/card context, promotion can be `todo` or `deliverable`.
- **D-07:** Promotion must create or update the underlying RT2 task/work product objects so Phase 49-50 board cards, deliverable badges, base price, quality status, OKR context, activity log, and daily wiki materialization continue to use canonical owners.
- **D-08:** After promotion, the board should show the created card immediately through query invalidation/refetch. Avoid UI-only placeholder cards unless the backend cannot return enough identity to refetch deterministically.

### Draft Review And Revision Fields
- **D-09:** The review UI must expose editable fields for work type/target, Task title, To-Do intent, deliverable title/type, base price, quality hint, OKR/KPI candidate, assignee or current actor, and source/daily-log note where available.
- **D-10:** The current parser output from `parseOneLinerInput` is the starting suggestion, not a locked result. Missing title, deliverable, or base price warnings should be shown as Korean review prompts rather than English parser text.
- **D-11:** Price/quality hints should remain advisory until the operator approves. Gold/reward evidence can preview the implication, but settlement issuance remains governed by existing quality/review settlement rules.
- **D-12:** OKR/KPI candidate selection should reuse existing goal/project context. If candidate inference is weak, show `OKR 없음` or inherited project goal rather than fabricating a confident match.

### Mobile Native And Inbound Evidence
- **D-13:** Mobile/native/inbound drafts should use the same board review queue as web drafts, not a separate One-Liner-only queue.
- **D-14:** Duplicate drafts should show the existing `duplicateWarning` and `duplicateOfDraftId` evidence prominently and should default to a conservative duplicate/hold action rather than one-click promotion.
- **D-15:** Source evidence should show source, channel, external user, installation/signing state, event id/time, permission status, and semantic citations when available. Keep it compact on the board and expandable in the review panel.
- **D-16:** Permission-blocked or source-failed drafts should be visible as review exceptions with a fail/reason path, but they should not create board cards until the operator resolves the issue.

### API And Data Contract Shape
- **D-17:** Reuse the existing capture source, capture queue, promote, and fail endpoints in `rt2-tasks` wherever possible. Add narrow shared validators only for missing review/update fields instead of introducing a second capture subsystem.
- **D-18:** If draft revision before promotion needs persistence, add a focused draft-update route that stores an edited `parsedDraft`/review metadata and audit entry. Do not encode revised values only in React state if the operator can leave and return.
- **D-19:** Daily board data should include enough capture queue summary or be composed with capture queue data in the daily board page so the board can render review counts and drafts without a separate navigation jump.
- **D-20:** Promotion/failure must continue logging `rt2.capture.draft_promoted` and `rt2.capture.draft_failed`, and should include source evidence/citation ids in audit details where already available.

### Product Copy And Layout
- **D-21:** Product-facing copy must be Korean-first and RealTycoon2-facing. Replace English review labels such as `review`, `duplicate`, `source evidence`, and parser warning text with Korean labels in the operator UI.
- **D-22:** Keep the board utilitarian and dense. The capture inbox should feel like an operations queue attached to the board, not a landing page or marketing explanation.
- **D-23:** Use existing compact chips, inline controls, and card edit patterns from `Rt2DailyBoard`; avoid nested cards inside cards and avoid large explanatory panels.
- **D-24:** The capture review state should have clear Korean save/action feedback: `검수 필요`, `중복 의심`, `승인 중`, `보드에 추가됨`, `처리 실패`.

### Verification
- **D-25:** Add or update focused UI tests for `OneLinerPage` and/or `Rt2DailyBoard` covering capture draft visibility, Korean review labels, duplicate warning/source evidence display, promotion action, and board query invalidation.
- **D-26:** Add shared/server route tests for inbound draft creation, queue listing, draft promotion, failure handling, duplicate status, and source evidence preservation if existing `rt2-task-routes.test.ts` does not already cover the exact Phase 51 flow.
- **D-27:** Add daily board integration coverage where promoted capture appears in the board lane/inbox after refetch, while the canonical lanes remain `할 일`, `진행 중`, `완료`.
- **D-28:** Verification should include `pnpm typecheck` and focused Vitest tests for changed UI/shared/server files. Run full `pnpm test` only if feasible on this host; Windows full-suite timeout remains accepted debt from prior phases and should be recorded if it blocks completion.

### the agent's Discretion
- Exact visual placement of the board capture inbox, provided it is visible from `daily-work` and does not alter the three canonical lanes.
- Whether web One-Liner first creates an inbound-style draft or uses a dedicated web draft route, provided the resulting review/promote contract is shared with mobile/native/inbound drafts.
- Exact OKR/KPI candidate heuristic, provided weak matches stay explicit and operator-approved.

</decisions>

<specifics>
## Specific Ideas

- Phase 49 made `daily-work` the first operational board and explicitly deferred One-Liner capture appearing in the board lane/inbox to Phase 51.
- Phase 50 made board quick edit/filter/search/sort complete; Phase 51 should extend that board instead of reviving a separate capture-only workflow.
- `OneLinerPage` already parses web input and creates tasks directly, while server-side inbound draft APIs already support review queues, duplicate warnings, source evidence, semantic context, promote, and fail. The strongest Phase 51 result is to unify those paths.
- Existing `createInboundDraft` already detects duplicate normalized input by source/hash and stores `sourceEvidence`, `semanticContext`, permission status, and audit trail. Preserve that evidence in the board review UI.

</specifics>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.8 product identity and daily work UX goal, RT2-first product rule, and current capture-flow focus.
- `.planning/REQUIREMENTS.md` - `CAPTURE-01`, `CAPTURE-02`, and `CAPTURE-03` Phase 51 requirements.
- `.planning/ROADMAP.md` - Phase 51 goal and success criteria under v2.8.
- `.planning/STATE.md` - Current milestone state: Phase 50 complete, Phase 51 planned.
- `.planning/phases/49-daily-work-kanban-core/49-CONTEXT.md` - Locked daily board route, lane, board persistence, and Phase 51 scope split decisions.
- `.planning/phases/50-work-card-editing-and-board-controls/50-CONTEXT.md` - Locked quick edit, filter/search/sort, and data ownership decisions feeding capture review.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### One-Liner And Capture Draft Code
- `packages/shared/src/one-liner-draft.ts` - Parser, draft shape, description builder, and reward evidence helper for One-Liner input.
- `ui/src/lib/one-liner-draft.ts` - UI-side parser/helper mirror used by the One-Liner page.
- `ui/src/pages/rt2/OneLinerPage.tsx` - Current web One-Liner composition/review UI, direct task creation behavior, capture source summary, and navigation handoff point.
- `ui/src/api/rt2-tasks.ts` - Client API helpers for create task, inbound draft, capture queue, promote, and fail.
- `packages/shared/src/types/rt2-task.ts` - Capture draft/source/status/evidence queue contracts.
- `packages/shared/src/validators/rt2-task.ts` - Promote/fail/inbound capture validators and existing task/todo/deliverable validation patterns.
- `server/src/routes/rt2-tasks.ts` - RT2 task/capture endpoints and activity logging.
- `server/src/services/rt2-work-board.ts` - Capture source, inbound draft creation, duplicate detection, queue listing, promotion, failure, source evidence, and audit trail behavior.
- `packages/db/src/schema/rt2_work_board.ts` - Capture sources and capture drafts schema.
- `packages/db/src/migrations/0093_rt2_phase23_work_board_capture.sql` - Existing capture draft schema migration.
- `packages/db/src/migrations/0101_rt2_capture_source_hardening.sql` - Existing capture source hardening migration.

### Daily Board Integration
- `ui/src/components/Rt2DailyBoard.tsx` - Primary daily board component, board controls, card quick edit, Korean lane labels, and likely capture inbox insertion point.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused component tests to extend for capture review behavior.
- `ui/src/api/rt2-daily-report.ts` - Daily board read/save and card update API helpers.
- `packages/shared/src/types/rt2-daily-report.ts` - Daily board/card data contract.
- `packages/shared/src/validators/rt2-daily-report.ts` - Daily board list/save/update validators.
- `server/src/routes/rt2-daily-report.ts` - Daily board route handlers and live event emission.
- `server/src/services/rt2-daily-report.ts` - Daily board read/save, metadata summaries, activity log, and wiki materialization.
- `server/src/__tests__/rt2-task-routes.test.ts` - Existing RT2 task/capture route coverage.
- `server/src/__tests__/rt2-daily-report-routes.test.ts` - Daily board route evidence to extend if board promotion/refetch behavior changes.
- `packages/shared/src/rt2-task.test.ts` - Shared capture draft/source contract smoke tests.
- `packages/shared/src/rt2-daily-report.test.ts` - Shared daily board contract smoke tests.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `parseOneLinerInput` already extracts task title, todo intent, daily log, deliverable title, base price, task mode, capacity, and warnings from semicolon/newline input.
- `OneLinerPage` already renders a web review form and submits `rt2TasksApi.create`, but it currently bypasses capture draft queue review for web input.
- `rt2WorkBoardService.createInboundDraft` already stores parsed draft, duplicate warning, permission status, source evidence, semantic context, and audit trail.
- `rt2WorkBoardService.listCaptureQueue`, `promoteCaptureDraft`, and `failCaptureDraft` already provide the core review lifecycle required by CAPTURE-02 and CAPTURE-03.
- `Rt2DailyBoard` already has compact Korean board controls, per-card quick edit, save feedback, and stable To-Do/Doing/Done lane semantics.

### Established Patterns
- Product-facing UI uses Korean labels while route segments and APIs can remain English.
- Shared validators in `packages/shared` define contracts consumed by UI and server.
- RT2 business mutations log activity and preserve audit details.
- Daily board changes should preserve existing daily report/wiki/materialization flow rather than writing detached UI-only state.
- Capture source state distinguishes installed/blocked/stale/error and signed/invalid/missing/stale evidence; Phase 51 should surface these facts rather than simplifying them away.

### Integration Points
- Add capture queue data fetching to the daily board page/container or extend the board payload with capture review summary.
- Add a compact board capture inbox/review component near `Rt2DailyBoard` lanes.
- Update `OneLinerPage` to create a reviewable draft or hand off to the board review flow, then invalidate capture queue and daily board queries.
- Add or extend client API helpers in `ui/src/api/rt2-tasks.ts` if draft revision persistence is needed.
- Add shared validator and server route support for draft revision only if the existing promote payload cannot carry reviewed values safely.
- Extend `server/src/__tests__/rt2-task-routes.test.ts`, `ui/src/components/Rt2DailyBoard.test.tsx`, and `ui/src/pages/rt2/OneLinerPage` tests for the end-to-end capture review path.

</code_context>

<deferred>
## Deferred Ideas

- Jarvis/wiki/graph/economy detailed evidence panels belong to Phase 52.
- Broader identity and Korean UX regression gate belongs to Phase 52.
- Persisted personal preferences for capture inbox visibility can be a future enhancement unless it falls out of existing local/session state patterns.
- More advanced LLM-based One-Liner inference is future scope; Phase 51 can use deterministic parser output and operator revision.

</deferred>

---

*Phase: 51-one-liner-to-board-capture-flow*
*Context gathered: 2026-04-30*
