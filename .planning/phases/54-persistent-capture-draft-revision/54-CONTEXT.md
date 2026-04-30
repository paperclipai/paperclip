# Phase 54: Persistent Capture Draft Revision - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 54 turns the existing One-Liner/capture review queue into a persistent draft revision workflow. It owns reopening captured drafts from the board review context, editing suggested work fields before approval, preserving the original input/source/failure/duplicate evidence, and keeping approve/reject/hold/request-revision state consistent with the board inbox.

This phase should not build the native tray/PWA/mobile entry itself, install Slack/Teams/webhook sources, add broad review filters/reliability reports, or reopen v2.8 board lane/card semantics. Those belong to Phase 55, Phase 56, Phase 57, or completed Phase 49-52 work. Phase 54 may extend the capture draft schema, shared validators/types, `rt2-work-board` service/routes, daily board capture inbox UI, and focused tests only where needed for DRAFT-01 through DRAFT-04.

</domain>

<decisions>
## Implementation Decisions

### Draft Record Ownership
- **D-01:** `rt2_capture_drafts` remains the canonical parent record for capture draft lifecycle. Add revision support around that table instead of creating a separate capture subsystem.
- **D-02:** Store every operator-editable draft snapshot as a persisted revision record. The current/latest revision should be easy to read from the draft queue without forcing downstream code to parse only `auditTrail`.
- **D-03:** Preserve `rawText`, source fields, duplicate evidence, permission/signing evidence, semantic context, and original parsed draft as immutable capture evidence. Operator edits should create new revision snapshots, not overwrite original input evidence.
- **D-04:** Keep product-facing terminology as draft/revision/review in code where useful, but Korean-first labels in UI: `초안`, `수정 이력`, `보류`, `반려`, `재검토 요청`, `승인`.

### Revision Data Shape
- **D-05:** Add a focused draft revision model, preferably `rt2_capture_draft_revisions`, with `draftId`, sequential `revisionNumber`, editable payload snapshot, change summary/reason, actor, and timestamp.
- **D-06:** The editable payload should cover title/task intent, work type/target, To-Do title, deliverable title/type, base price/price hint, quality hint, OKR/KPI candidate/goal id, source evidence note, and operator note.
- **D-07:** The existing `parsedDraft` can remain a denormalized latest snapshot for list rendering if that keeps reads simple, but revision rows are the audit source for who changed what and when.
- **D-08:** Use append-only revision creation for meaningful operator changes. Avoid silent in-place edits to `parsedDraft` without a revision row and audit action.

### Review State Semantics
- **D-09:** Expand draft status beyond the current `review_required`, `duplicate`, `permission_blocked`, `failed`, `promoted`, `discarded` set to represent operator review workflow: `review_required`, `revised`, `on_hold`, `revision_requested`, `rejected`, `duplicate`, `permission_blocked`, `failed`, `promoted`, and `discarded` if still needed.
- **D-10:** Approval/promotion should be allowed from reviewable states with a valid latest revision: `review_required`, `revised`, and `revision_requested` after edits. It should stay blocked for permission-blocked, failed, rejected, discarded, and unresolved duplicate/hold states unless a separate transition resolves them first.
- **D-11:** `reject`, `hold`, and `request revision` should be explicit state transitions with reason text. They should update `reviewedByUserId`/`reviewedAt` only when the state represents a human review decision, and should append audit trail entries.
- **D-12:** Duplicate drafts should default to conservative hold/reject/duplicate handling rather than one-click promotion. A later explicit revision can clear or explain duplicate risk, but original duplicate evidence remains visible.

### Promotion Uses Latest Revision
- **D-13:** `promoteCaptureDraft` must use the latest persisted revision snapshot for task/todo/deliverable creation, not reparse `row.rawText`.
- **D-14:** Promotion should keep the existing canonical owners: RT2 task profile, To-Do issue, work product, board card metadata, activity log, and daily board refetch. Draft revisions only prepare reviewed input; they do not become the canonical task/deliverable store after promotion.
- **D-15:** Promotion audit details should include `draftId`, latest `revisionId`/`revisionNumber`, target, promoted issue/work product ids, source evidence, duplicate warning, and semantic citation ids where available.
- **D-16:** Promoted board cards or work products should link back to the source draft evidence through metadata or a durable id so Phase 57 can add round-trip navigation and reliability reporting.

### Board Review UX
- **D-17:** The daily work board remains the primary review context. Operators should reopen a draft from the existing `One-Liner 보드 검수함`/capture inbox and see latest editable fields plus compact source/audit evidence.
- **D-18:** Prefer a compact inline expansion or review drawer within/near `Rt2DailyBoard` over a new full-page draft management surface. The board must remain dense and operational.
- **D-19:** Show revision history as concise rows: revision number, actor, time, status/change summary, and changed-field summary. Do not make operators read raw JSON.
- **D-20:** Save/reopen feedback should be explicit in Korean: `수정 저장됨`, `수정 이력 추가됨`, `보류됨`, `반려됨`, `재검토 요청됨`, `승인 중`, `보드에 추가됨`.

### API And Contract Shape
- **D-21:** Add narrow shared validators/types for draft revision update and status transition rather than overloading `promoteRt2CaptureDraftSchema` or `failRt2CaptureDraftSchema`.
- **D-22:** Recommended routes: get one draft detail with revisions, create/update revision, transition review state, then existing promote/fail routes can continue with adjusted semantics.
- **D-23:** Keep the list endpoint efficient. `listCaptureQueue` should include latest revision summary and review counts but not full revision history for every row.
- **D-24:** Backward compatibility matters: existing Phase 51 tests and UI paths that list, promote, and fail capture drafts should continue to work after adding revision fields.

### Verification
- **D-25:** Add/extend DB migration/schema tests or shared contract tests for revision row shape, status enum acceptance, latest revision projection, and immutable original evidence.
- **D-26:** Add server route tests for: inbound draft creates initial revision, revision update appends history, reopening returns original and latest snapshots, promote uses latest revision values, reject/hold/request-revision preserve inbox consistency, and duplicate/permission blocked drafts remain guarded.
- **D-27:** Add focused UI tests for daily board capture inbox reopen/edit/save/history/state-action behavior with Korean labels.
- **D-28:** Verification should include `pnpm typecheck` and focused Vitest suites for changed shared/server/UI files. Run broad `pnpm test` only if feasible; the known Windows full-suite timeout remains accepted host debt if focused checks pass.

### the agent's Discretion
- Exact table/column names, provided the model is append-only for revision history and keeps `rt2_capture_drafts` as parent lifecycle owner.
- Exact review drawer/inline expansion layout, provided it is reachable from the daily board capture inbox and stays compact.
- Whether `parsedDraft` is updated as latest denormalized snapshot, provided revision rows remain the audit source.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.9 milestone focus, RT2-first product rule, Korean-first daily work loop, and deferred native distribution/federation/autonomy scope.
- `.planning/REQUIREMENTS.md` - `DRAFT-01`, `DRAFT-02`, `DRAFT-03`, and `DRAFT-04` Phase 54 requirements.
- `.planning/ROADMAP.md` - Phase 54 goal and success criteria under v2.9.
- `.planning/STATE.md` - Current v2.9 planning state and handoff note for Phase 54.
- `.planning/phases/51-one-liner-to-board-capture-flow/51-CONTEXT.md` - Locked capture review queue, promotion, source evidence, duplicate warning, Korean board review decisions.
- `.planning/phases/52-supporting-surfaces-and-identity-regression-gate/52-CONTEXT.md` - Locked daily board primary surface and Korean compact support UI decisions.
- `.planning/phases/53-v28-verification-and-traceability-closure/53-CONTEXT.md` - v2.8 closure evidence and known focused verification commands.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Existing Capture Draft Backend
- `packages/db/src/schema/rt2_work_board.ts` - Existing capture sources and capture drafts schema, including `parsedDraft`, status, source evidence, duplicate warning, and `auditTrail`.
- `packages/db/src/migrations/0093_rt2_phase23_work_board_capture.sql` - Original capture draft/source schema migration.
- `packages/db/src/migrations/0101_rt2_capture_source_hardening.sql` - Capture source/signing/evidence hardening migration.
- `server/src/services/rt2-work-board.ts` - Capture source configuration, inbound draft creation, duplicate detection, capture queue listing, promotion/failure lifecycle, and audit trail behavior.
- `server/src/routes/rt2-tasks.ts` - Existing capture draft/source routes and activity logging.
- `server/src/__tests__/rt2-task-routes.test.ts` - Focused route coverage to extend for revision semantics.

### Shared Contracts And UI
- `packages/shared/src/types/rt2-task.ts` - Capture draft/source/status queue contracts to extend with latest revision/detail/history fields.
- `packages/shared/src/validators/rt2-task.ts` - Existing inbound/promote/fail validators and likely home for draft revision/transition validators.
- `packages/shared/src/rt2-task.test.ts` - Shared capture contract smoke tests to extend.
- `ui/src/api/rt2-tasks.ts` - Client API helpers for capture queue, promote, fail, and future draft revision/detail/transition calls.
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Daily board container that owns capture queue query and mutation invalidation.
- `ui/src/components/Rt2DailyBoard.tsx` - Primary daily board, capture review inbox, compact Korean UI patterns, and likely reopen/edit/history insertion point.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused component tests to extend for draft reopen/edit/history/state behavior.
- `ui/src/pages/rt2/OneLinerPage.tsx` - Web One-Liner composition surface that creates reviewable drafts and routes operators back to board review.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2_capture_drafts` already stores parent lifecycle data: raw input, normalized hash, parsed draft, status, promotion target, promoted ids, duplicate link/warning, failure reason, permission/source signing evidence, semantic context, audit trail, reviewer, and timestamps.
- `rt2WorkBoardService.createInboundDraft` already creates a reviewable draft from web/mobile/native/messaging-like sources and preserves source evidence plus duplicate information.
- `rt2WorkBoardService.listCaptureQueue` already provides queue summary and up to 80 draft rows for board review.
- `rt2WorkBoardService.promoteCaptureDraft` already creates task/todo/deliverable outputs and logs promoted audit evidence.
- `DailyWorkPage` already fetches `captureQueue` and invalidates capture queue, board, issue, and project task queries after promotion/failure.
- `Rt2DailyBoard` already renders capture inbox before the three canonical board lanes and has compact Korean control patterns.

### Established Patterns
- Shared Zod validators in `packages/shared` define UI/server route contracts.
- Business mutations live in service methods and routes add activity-log entries.
- RT2 product UI is Korean-first and dense; internal API identifiers can remain English.
- Existing board lane semantics stay `할 일`, `진행 중`, `완료`; capture draft review is an attached queue, not a fourth persisted lane.
- Focused tests are preferred on this host. Broad `pnpm test` may hit known Windows timeout debt.

### Integration Points
- Add a DB migration and schema export for draft revisions and any status fields needed by Phase 54.
- Extend `toCaptureDraft`/types to expose latest revision summary and, for detail route, revision history.
- Add service methods for `getCaptureDraftDetail`, `reviseCaptureDraft`, and `transitionCaptureDraftReviewState`.
- Update `promoteCaptureDraft` to derive promoted task/todo/deliverable fields from latest revision snapshot.
- Extend `rt2-tasks` routes and `rt2TasksApi` helpers for draft detail/revision/transition.
- Add compact reopen/edit/history UI to `CaptureReviewInbox` or a child component inside `Rt2DailyBoard`.
- Extend focused shared/server/UI tests around draft revision lifecycle and board inbox state.

</code_context>

<specifics>
## Specific Ideas

- Phase 51 already anticipated this exact need: "If draft revision before promotion needs persistence, add a focused draft-update route that stores an edited `parsedDraft`/review metadata and audit entry."
- The current backend reparses `row.rawText` during promotion. Phase 54 should fix that so operator edits are not lost.
- Use document-revision concepts elsewhere in the repo only as a conceptual reference; capture draft revisions should stay RT2 capture-specific because they must preserve source/duplicate/permission evidence and board state.
- Keep source evidence compact by default and expandable in the review drawer. The operator needs to see enough to trust/reject/hold, not raw JSON.

</specifics>

<deferred>
## Deferred Ideas

- Native tray/PWA/mobile capture entry and offline queue belong to Phase 55.
- Slack/Teams/webhook source installation and signed inbound payload setup belong to Phase 56.
- Review inbox filters, reliability report aggregation, promotion latency metrics, and source/status operations dashboard belong to Phase 57.
- Full app-store signing/updater/notarization, cross-company federation full apply, public/open capture marketplace, and autonomous Jarvis apply remain future milestone scope.

</deferred>

---

*Phase: 54-persistent-capture-draft-revision*
*Context gathered: 2026-04-30*
