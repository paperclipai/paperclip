# Phase 56 Research: Messaging Capture Source Installation

## RESEARCH COMPLETE

### Planning Question

What needs to be known to plan Phase 56 well: Slack/Teams/webhook capture source setup must become operator-configurable, signed messaging payloads must enter the existing capture draft revision/review flow, and duplicate/unauthorized/malformed failures must be distinguishable in board review and audit evidence.

### Scope Anchors

- `MSG-01`: Operators can install/connect Slack/Teams/webhook capture sources and see signing secret, callback URL, source label, and health status.
- `MSG-02`: Messaging inbound drafts enter the same draft revision/review flow while preserving source-specific metadata and permission failure details.
- `MSG-03`: Duplicate, unauthorized source, and malformed payload failures are distinguishable in review/audit evidence.

Phase 56 is not full Slack/Teams marketplace distribution, generic plugin webhook ownership, native/mobile queue behavior, review filtering, reliability reporting, or promotion latency reporting.

## Existing Assets

### Capture Source Model

- `packages/db/src/schema/rt2_work_board.ts` already has `rt2CaptureSources` with `source`, `label`, `installationState`, `signingStatus`, `signingSecretHash`, `lastInboundEventAt`, `lastInboundEventId`, `lastErrorCode`, and `blockedReason`.
- `rt2CaptureDrafts` already carries `sourceInstallationId`, `sourceSigningStatus`, `sourceEvidence`, `permissionStatus`, `failureCode`, `failureMessage`, duplicate fields, and revision-backed draft lifecycle.
- `packages/db/src/migrations/0101_rt2_capture_source_hardening.sql` already introduced source/signing/evidence fields.
- `packages/db/src/migrations/0104_rt2_capture_draft_revisions.sql` already introduced persistent draft revisions.

### Shared Contracts

- `packages/shared/src/validators/rt2-task.ts` already accepts capture sources `web`, `floating`, `voice`, `slack`, `teams`, `webhook`, `mobile`, and `native`.
- `createOneLinerInboundDraftSchema` already accepts `sourceInstallationId`, `eventId`, `eventTimestamp`, and `signature`.
- `failRt2CaptureDraftSchema` already distinguishes `source_failure`, `duplicate`, `permission`, and `parse_error`.
- `Rt2CaptureSourceEvidence` currently records source installation id, installation state, signing status, event id/timestamp, and reason code. Phase 56 can extend this with redacted provider metadata.

### Backend Service And Routes

- `rt2WorkBoardService.upsertCaptureSource` already hashes a signing secret and updates source label/state/status.
- `rt2WorkBoardService.createInboundDraft` already:
  - finds a capture source by type or installation id
  - verifies a source secret with HMAC
  - creates `permission_blocked` drafts for missing/invalid signatures
  - detects duplicate content
  - stores source evidence and semantic context
  - creates revision 1
  - updates source health fields after inbound
- `server/src/routes/rt2-tasks.ts` already has authenticated source list/upsert and inbound draft routes.
- There is no dedicated public RT2 messaging route yet. Existing plugin webhook routes show that public webhook routes can intentionally skip board authentication when they perform their own source validation.

### UI Surfaces

- `ui/src/pages/rt2/OneLinerPage.tsx` already lists capture entrypoints and renders read-only capture source evidence from `captureSources`.
- `ui/src/api/rt2-tasks.ts` already exposes `listCaptureSources`, `upsertCaptureSource`, and `createInboundDraft`.
- `ui/src/components/Rt2DailyBoard.tsx` already shows source labels, duplicate warnings, permission/signing evidence, failure messages, and capture review actions in the board inbox.
- `Rt2DailyBoard.test.tsx`, `packages/shared/src/rt2-task.test.ts`, and `server/src/__tests__/rt2-task-routes.test.ts` are the focused coverage anchors.

## Recommended Plan Shape

### One Plan Is Enough

The work is one coherent pipeline:

1. Configure a messaging capture source.
2. Copy/use its callback URL and signing secret.
3. Receive a signed external payload through a public route.
4. Normalize it into a capture draft.
5. Show source metadata and failure status in the existing board review queue.

Splitting into multiple waves would create awkward intermediate states, because the UI setup, route, service evidence, and board review labels all prove the same MSG-01..03 workflow.

### Implementation Approach

- Extend shared source evidence types with redacted `metadata` and a failure kind/reason vocabulary if needed.
- Add a narrow public inbound payload schema for Slack/Teams/webhook that accepts common normalized fields and provider-shaped fallbacks.
- Add a public route such as `POST /api/companies/:companyId/rt2/capture-sources/:source/inbound` that does not call `assertCompanyAccess`, but only accepts `slack`, `teams`, or `webhook`.
- Reuse `rt2WorkBoardService.createInboundDraft` for valid payloads.
- Add or refactor service helpers so recognized malformed payloads can still create a failed draft with `failureCode: "parse_error"` and redacted source evidence.
- Update source health for success, missing/invalid signature, blocked/stale source, duplicate, and malformed attempts.
- Upgrade the One-Liner capture source evidence section into a compact Korean setup surface for Slack/Teams/webhook.
- Add board inbox labels that distinguish duplicate, source blocked/signature failure, and malformed payload states without adding Phase 57 filters/reports.

## Risks And Constraints

- **Public inbound route risk:** External callers cannot use board sessions. Mitigate by resolving known company/source records, requiring signatures for installed signed sources, and limiting route scope to messaging capture.
- **Secret exposure:** Signing secrets must be written/rotated but never shown after save. Tests should assert that saved secret text is not rendered.
- **Evidence overcollection:** Raw provider payloads may contain tokens or private data. Store redacted metadata only.
- **Malformed payload loss:** If validation rejects before service logic, operators cannot see the failure. Use a narrow normalization layer that can persist failed recognized payloads.
- **Duplicate ambiguity:** Repeated event ids and same text are different operational cases. Use `eventId` in evidence and preserve duplicate warning details.
- **Scope creep:** Full review filters and reliability reports belong to Phase 57.

## Validation Architecture

Use focused Vitest and typecheck:

- Shared contract tests: `packages/shared/src/rt2-task.test.ts`
- Server route/service tests: `server/src/__tests__/rt2-task-routes.test.ts`
- Board inbox UI tests: `ui/src/components/Rt2DailyBoard.test.tsx`
- One-Liner/source setup UI tests if a test harness is added: `ui/src/pages/rt2/OneLinerPage.test.tsx`
- Typecheck: `pnpm typecheck`

Recommended focused command:

```sh
pnpm exec vitest run packages/shared/src/rt2-task.test.ts server/src/__tests__/rt2-task-routes.test.ts ui/src/components/Rt2DailyBoard.test.tsx
pnpm typecheck
```

Broad `pnpm test` remains optional on this Windows host if focused checks and typecheck pass, because prior phases recorded a known broad-suite timeout.
