# Phase 57: Capture Review Operations and Reliability - Research

**Researched:** 2026-04-30
**Status:** Complete
**Mode:** inline fallback because `gsd-sdk query` is unavailable in this runtime.

## Scope

Phase 57 should extend the existing RT2 capture draft/source/revision stack. The phase does not need a new analytics subsystem or page-level operations dashboard. The smallest safe implementation path is:

1. Add typed filter/report contracts in shared code.
2. Extend `rt2WorkBoardService` with filtered queue support and a source-grouped reliability report.
3. Add an authenticated report route adjacent to existing capture draft routes.
4. Extend the daily board capture inbox with compact filters and a report summary.
5. Add focused shared/server/UI tests plus `pnpm typecheck`.

## Existing Assets

- `packages/db/src/schema/rt2_work_board.ts`
  - `rt2_capture_sources` already stores source labels, installation state, signing state, last inbound event, last error code, and blocked reason.
  - `rt2_capture_drafts` already stores status, source, channel, external user, promoted ids, duplicate/failure/permission/source evidence, audit trail, `reviewedAt`, and timestamps.
  - `rt2_capture_draft_revisions` already stores latest revision evidence.
- `packages/shared/src/types/rt2-task.ts`
  - Existing queue shape has source summaries, status counts, drafts, latest revision, promoted ids, and source evidence.
- `packages/shared/src/validators/rt2-task.ts`
  - Capture source/inbound/revision/transition/promote/fail validators already exist.
- `server/src/services/rt2-work-board.ts`
  - `listCaptureQueue` returns recent capture drafts and summaries.
  - `promoteCaptureDraft` already records `captureDraftId`, `captureDraftRevisionId`, and revision number in deliverable work product metadata.
  - Promotion to task/todo currently records ids on the draft and activity log, but task/todo metadata may need capture evidence enrichment.
- `server/src/routes/rt2-tasks.ts`
  - Existing authenticated routes are the right place for queue filter/report reads.
- `ui/src/pages/rt2/DailyWorkPage.tsx`
  - Owns capture queue query and mutation invalidation.
- `ui/src/components/Rt2DailyBoard.tsx`
  - Owns capture review inbox UI, source/status labels, failure evidence labels, revision editor, and action buttons.

## Implementation Notes

### Queue Filters

The queue can keep its current default behavior while accepting optional filters:

- `sources`: source enum array
- `statuses`: capture status enum array
- `evidence`: `duplicate`, `failed_sync`, `approval_waiting`, `revised`

Server-side filtering is preferable because it gives route tests for REVIEW-01 and keeps future queues from depending on only the first 80 unfiltered rows. UI can still maintain local filter state and pass it through the API helper.

### Reliability Report

Use draft rows plus latest revision map. Group by source and compute:

- `draftCount`
- `reviewRequiredCount`
- `revisedCount`
- `duplicateCount`
- `failureCount`
- `permissionBlockedCount`
- `promotedCount`
- `retryCount`
- `averagePromotionLatencyMinutes`
- `maxPromotionLatencyMinutes`

Retry count must use durable evidence only. Good low-risk first pass:

- audit trail entries with action/text containing `retry`, `resent`, or `resend`
- source evidence metadata keys like `retryCount`, `retryAttempt`, or `attempt`

If no durable retry evidence exists, count 0.

### Round-Trip Evidence

Deliverable work product metadata already carries capture ids. To cover Task and To-Do promotion, add `captureDraftId`, `captureDraftRevisionId`, and `captureDraftRevisionNumber` into issue metadata when creating task/todo if the issue schema supports metadata. If not, keep the draft-side promoted id link and activity log as the implementation route and verify the API exposes enough fields for navigation.

## Risks

- **Route ordering:** `GET /capture-drafts/reliability-report` must be registered before `GET /capture-drafts/:draftId`.
- **Status mismatch:** UI filters should use shared enum values and helper predicates rather than raw Korean text.
- **Overcounting failures:** Duplicate is not the same as failed sync; report should separate duplicate from permission/source/malformed failures.
- **Latency null handling:** Sources with no promoted drafts should render empty latency text, not `0분`, because no latency exists.
- **Windows embedded Postgres:** Focused route tests may skip if embedded Postgres support is unavailable on the host. Record that explicitly.

## Validation Architecture

- Shared:
  - filter validator parses comma-separated source/status/evidence query values.
  - report type compatibility preserves existing queue contract.
- Server:
  - queue filters return matching rows for source/status/evidence categories.
  - promoted task/deliverable evidence retains draft/revision ids.
  - report groups source counts, failure/duplicate/retry metrics, and promotion latency.
- UI:
  - capture inbox renders filter controls and filters rows.
  - reliability report renders source rows and Korean empty latency.
  - promoted draft rows expose forward/back evidence labels.

## RESEARCH COMPLETE
