# Phase 57: Capture Review Operations and Reliability - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 57 turns the existing board capture review inbox into an operational review surface. It owns source/status/duplicate/failed-sync/approval-waiting/revised-draft filters, round-trip links between promoted work and original capture draft evidence, and a capture reliability report grouped by source with draft count, failure count, retry count, and promotion latency.

This phase should not reopen draft revision semantics, native/mobile queue mechanics, Slack/Teams/webhook installation, full native distribution, federation, autonomous Jarvis apply, or broad analytics outside capture review reliability. Those were handled by Phase 54-56 or remain future scope. Phase 57 may extend capture draft list/report contracts, `rt2-work-board` service/routes, daily board capture inbox UI, promoted work metadata, and focused tests only where needed for REVIEW-01 through REVIEW-03.

</domain>

<decisions>
## Implementation Decisions

### Review Inbox Filtering
- **D-01:** Keep the daily work board `One-Liner 보드 검수함` as the canonical review operations surface. Do not create a separate full-page capture operations app for Phase 57.
- **D-02:** Add compact Korean filter controls directly in the capture inbox for source, status, duplicate, failed sync, approval waiting, and revised draft. The controls should filter draft rows without disturbing the main board card filters.
- **D-03:** Source filters should cover the existing canonical sources: `web`, `floating`, `voice`, `mobile`, `native`, `slack`, `teams`, and `webhook`. Product-facing labels stay concise: `Web`, `빠른 기록`, `음성`, `Mobile`, `Native`, `Slack`, `Teams`, `Webhook`.
- **D-04:** Status filters should use operator language rather than raw enum names: `검수 필요`, `수정됨`, `보류됨`, `재검토 요청`, `반려됨`, `중복 의심`, `권한/서명`, `처리 실패`, `보드에 추가됨`.
- **D-05:** `duplicate` means either draft status is `duplicate` or `duplicateWarning`/`duplicateOfDraftId` exists. It must not rely only on a text label.
- **D-06:** `failed sync` means capture delivery or source validation failed before normal review, including `failed`, `permission_blocked`, signing/authorization failures, malformed payloads, source blocked/stale/not installed, or local retry evidence when present in source metadata.
- **D-07:** `approval waiting` should map to reviewable human-action states: `review_required`, `revision_requested`, and `on_hold`. It should not include already `promoted`, `rejected`, or terminal failures.
- **D-08:** `revised draft` should map to `status === "revised"` or latest revision number greater than 1. This lets revised drafts remain discoverable even if status changes after a transition.
- **D-09:** The list should remain bounded and scan-first. Keep the service default limit around the current 80-row queue unless planning finds a small query parameter is needed; avoid infinite scroll in this phase.

### Round-Trip Draft Evidence
- **D-10:** Promotion metadata is the canonical link from promoted work back to capture draft evidence. Preserve and expose `captureDraftId`, latest `captureDraftRevisionId`, and `captureDraftRevisionNumber` wherever a promoted Task/To-Do/Deliverable can be inspected.
- **D-11:** Extend task and todo promotion metadata if needed so REVIEW-02 covers all promotion targets, not only deliverable work products. Existing deliverable metadata already stores capture draft ids.
- **D-12:** The review inbox should expose forward links from a promoted draft to the promoted Task/To-Do/Deliverable ids already stored on the draft. Labels should be Korean and operational: `생성된 Task 보기`, `원본 초안 근거`, `수정 이력`.
- **D-13:** The promoted work surface may show compact capture evidence rather than duplicating the full draft detail. It should include source, event id/channel/user, original draft id, revision number, duplicate/signing/failure evidence if available, and a way back to the board/draft context.
- **D-14:** Do not copy raw provider payloads or signing secrets into promoted metadata. Only durable ids and redacted source evidence should move across the boundary.
- **D-15:** If a promoted work product or task cannot render a direct route yet, the API contract should still return the draft evidence link fields so UI can add navigation when the local surface supports it.

### Reliability Report Metrics
- **D-16:** Add a narrow capture reliability report contract rather than mixing report-only fields into every draft row. Recommended shape: company id, generated time, totals, rows by source, and optional status buckets.
- **D-17:** Group report rows by source. Each row should include source label, draft count, review-required count, revised count, duplicate count, failure count, permission-blocked count, promoted count, retry count, and promotion latency summary.
- **D-18:** Failure count should include `failed` and `permission_blocked`, plus malformed/signature/source-blocked evidence. Duplicate count remains separate so operators can distinguish bad source health from expected duplicate capture.
- **D-19:** Retry count should be derived from durable evidence only: audit trail actions that represent retry/resend, source evidence metadata retry counters, or event id retry markers if already persisted. If no durable retry evidence exists, return 0 and do not invent client-local retry counts.
- **D-20:** Promotion latency should be measured from draft `createdAt` to `reviewedAt` for `promoted` drafts. Report average and max latency in minutes; if no promoted drafts exist, use nulls and Korean empty text.
- **D-21:** The report should include all recent capture drafts for the company, not just currently active review rows, so promoted/failed history is visible. Keep it lightweight and bounded if needed.
- **D-22:** The report UI should sit near the capture inbox as a compact operations summary, not as a large dashboard. It should answer "which source is noisy or slow?" at a glance.

### API And Contract Shape
- **D-23:** Keep `listCaptureQueue` backward compatible. If filters are server-side, accept an optional query object but default behavior must still return the current queue shape.
- **D-24:** Add focused shared types and validators for capture queue filters and reliability report output. Do not overfit them to UI-only labels.
- **D-25:** Add a route such as `GET /companies/:companyId/rt2/capture-drafts/reliability-report` or a similarly narrow sibling under the existing capture-draft route tree.
- **D-26:** Query keys should distinguish the unfiltered queue, filtered queue, and reliability report so React Query invalidation remains predictable after promote/fail/revise/transition.
- **D-27:** Source/status filters can be implemented client-side first if the 80-row queue remains sufficient, but source/report aggregation belongs in the server so tests can verify REVIEW-03 independent of UI rendering.
- **D-28:** Activity/audit logging should remain in the existing route/service pattern. New report reads do not need activity log entries, but promotion metadata changes must preserve existing `rt2.capture.draft_promoted` logging.

### Verification
- **D-29:** Add shared contract tests for filter/report types and status/source compatibility.
- **D-30:** Add focused server tests for filtered queue behavior, promoted work metadata linking back to capture draft/revision evidence, reliability report source grouping, failure/retry counting, and promotion latency.
- **D-31:** Add focused UI tests for capture inbox filters, promoted draft link labels, and compact reliability report rendering with Korean empty/error states.
- **D-32:** Verification should include `pnpm typecheck` and focused Vitest suites for changed shared/server/UI files. Run broad `pnpm test` only if feasible; known Windows broad-suite timeout remains accepted host debt if focused checks pass.

### the agent's Discretion
- Exact route name and query parameter encoding, provided the contract is typed, company-scoped, and adjacent to capture draft operations.
- Exact chip/dropdown layout for capture inbox filters, provided it remains compact, Korean-first, and independent from main board filters.
- Exact latency bucket presentation, provided source-level draft/failure/retry/counts and average/max promotion latency are visible.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.9 milestone focus, RT2-first product rule, Korean-first board review loop, and deferred native distribution/federation/autonomy scope.
- `.planning/REQUIREMENTS.md` - `REVIEW-01`, `REVIEW-02`, and `REVIEW-03` Phase 57 requirements.
- `.planning/ROADMAP.md` - Phase 57 goal and success criteria under v2.9.
- `.planning/STATE.md` - Current v2.9 planning state and handoff from Phase 56.
- `.planning/phases/54-persistent-capture-draft-revision/54-CONTEXT.md` - Locked draft revision ownership, promotion latest-revision semantics, and durable draft evidence ids.
- `.planning/phases/55-native-and-mobile-quick-capture-entry/55-CONTEXT.md` - Locked mobile/PWA local queue boundary and explicit deferral of reliability reports to Phase 57.
- `.planning/phases/56-messaging-capture-source-installation/56-CONTEXT.md` - Locked Slack/Teams/webhook source installation, signing evidence, failure labels, and explicit deferral of filters/reports to Phase 57.
- `.planning/phases/51-one-liner-to-board-capture-flow/51-CONTEXT.md` - Existing One-Liner board review flow, promotion targets, and source evidence decisions.
- `.planning/phases/52-supporting-surfaces-and-identity-regression-gate/52-CONTEXT.md` - Korean-first compact support surface constraints.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Capture Draft Backend And Contracts
- `packages/db/src/schema/rt2_work_board.ts` - `rt2_capture_sources`, `rt2_capture_drafts`, `rt2_capture_draft_revisions`, indexes, status/source/evidence columns, and promoted ids.
- `packages/db/src/migrations/0101_rt2_capture_source_hardening.sql` - Existing capture source/signing/evidence migration.
- `packages/db/src/migrations/0104_rt2_capture_draft_revisions.sql` - Existing draft revision migration.
- `packages/shared/src/types/rt2-task.ts` - Capture draft/source/status/queue/detail contracts to extend with filter/report types.
- `packages/shared/src/validators/rt2-task.ts` - Capture source, inbound, revision, transition, promote/fail validators; likely home for query/report validators.
- `packages/shared/src/rt2-task.test.ts` - Focused shared contract tests to extend for filter/report compatibility.
- `server/src/services/rt2-work-board.ts` - Capture source lookup, inbound draft creation, queue listing, detail/revision/transition/promotion logic, and source health evidence.
- `server/src/routes/rt2-tasks.ts` - Existing authenticated capture draft/source routes and public messaging inbound route; add report/filter route here.
- `server/src/__tests__/rt2-task-routes.test.ts` - Embedded Postgres route tests for capture drafts, revisions, source evidence, public messaging inbound, and future Phase 57 report cases.

### Board And UI Surfaces
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Daily board container, capture queue query, mutation invalidation, and selected project/user context.
- `ui/src/components/Rt2DailyBoard.tsx` - Primary daily board, capture review inbox, draft cards, status/source labels, revision editor, and failure evidence labels.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused component tests for board filters, capture inbox, failure labels, and draft revision actions.
- `ui/src/api/rt2-tasks.ts` - Client helpers for capture queue, draft detail/revision/transition/promote/fail, and future reliability report call.
- `ui/src/lib/queryKeys.ts` - React Query keys for capture queue/report invalidation.
- `ui/src/pages/rt2/QuickCapturePage.tsx` - Local queue/retry source for durable event id and retry evidence boundaries.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2_capture_drafts` already stores company, source, channel, external user, status, promoted issue/work product ids, duplicate warning, failure fields, permission status, source evidence, semantic context, audit trail, reviewed timestamps, and created/updated timestamps.
- `rt2_capture_draft_revisions` already stores revision snapshots and revision numbers; latest revision can identify revised drafts and link promoted work back to reviewed input.
- `rt2_capture_sources` already stores source label, installation/signing state, last inbound event, last error code, and blocked reason for source-level health.
- `rt2WorkBoardService.listCaptureQueue` already returns sources, summary counts, latest revisions, and up to 80 draft summaries.
- `rt2WorkBoardService.promoteCaptureDraft` already uses latest revision snapshot and records draft/revision ids in deliverable work product metadata; this can be extended to task/todo metadata if needed.
- `Rt2DailyBoard` already renders the capture inbox, status/source/failure labels, duplicate evidence, revision editor, and action buttons in compact Korean UI.
- `DailyWorkPage` already invalidates capture queue and board/task/project queries after promote/fail/revise/transition.

### Established Patterns
- Shared Zod validators and exported TypeScript types define the UI/server boundary.
- Server routes validate inputs, service methods own business rules, and route handlers add activity log entries for mutations.
- Product-facing UI stays Korean-first and dense; raw enum names are hidden behind compact labels.
- React Query owns client data refresh, so new report reads need separate query keys and invalidation after capture mutations.
- Focused tests plus `pnpm typecheck` are the practical verification path on this Windows host.

### Integration Points
- Add optional queue filter parsing and/or client filter state around `rt2TasksApi.listCaptureQueue`, `DailyWorkPage`, and `CaptureReviewInbox`.
- Add a reliability report method in `rt2WorkBoardService`, route in `rt2-tasks`, shared output types, UI API helper, and query key.
- Add compact reliability summary rendering inside or adjacent to `CaptureReviewInbox`.
- Extend promotion metadata or read models so promoted Task/To-Do/Deliverable surfaces can return source draft/revision evidence.
- Extend focused shared/server/UI tests around REVIEW-01, REVIEW-02, and REVIEW-03.

</code_context>

<specifics>
## Specific Ideas

- Auto mode selected the conservative default: extend the existing RT2 capture draft/source/revision path instead of creating a new operations subsystem.
- Phase 54 already created the durable draft/revision evidence and marked Phase 57 as responsible for round-trip navigation and reliability reporting.
- Phase 56 already made duplicate/signature/source/malformed failures distinguishable in board review labels; Phase 57 should add filters and reports over that evidence instead of redefining failure semantics.
- The operator's first question should be answered from the board: "Which capture source needs attention, and which promoted work came from which draft?"

</specifics>

<deferred>
## Deferred Ideas

- Full app-store signing, updater, notarization, release channel, resident OS tray app, global shortcut, and mobile push notifications remain future native distribution scope.
- Slack/Teams marketplace OAuth app distribution and generic plugin webhook delivery history remain connector/plugin infrastructure, not Phase 57.
- Cross-company federation full apply, public/open capture marketplace, and autonomous Jarvis apply without approval remain outside v2.9 scope.
- Broad business intelligence analytics beyond capture draft reliability remain future reporting scope.

</deferred>

---

*Phase: 57-capture-review-operations-and-reliability*
*Context gathered: 2026-04-30*
