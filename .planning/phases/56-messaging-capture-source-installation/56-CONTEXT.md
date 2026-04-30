# Phase 56: Messaging Capture Source Installation - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 56 installs, connects, and verifies Slack/Teams/webhook capture sources so signed messaging payloads enter the same persistent capture draft revision and board review flow created by Phase 54 and extended by Phase 55.

This phase owns operator-facing source setup, signing secret/callback URL visibility, source label and health state, messaging inbound normalization, source-specific metadata preservation, permission/signing failure evidence, and distinguishable duplicate/unauthorized/malformed payload outcomes.

This phase should not build a generic plugin marketplace, broad plugin webhook framework, Slack/Teams OAuth app marketplace distribution, native/mobile local queue behavior, board review filtering, reliability reports, promotion-latency analytics, or full app-store/native distribution. Those belong to existing plugin infrastructure, future connector hardening, Phase 55, Phase 57, or later distribution scope.

</domain>

<decisions>
## Implementation Decisions

### Capture Source Setup Surface
- **D-01:** Build Phase 56 around the existing RT2 capture source model, not a new generic integration subsystem. `rt2_capture_sources` remains the company-scoped source installation record for Slack, Teams, and generic webhook capture.
- **D-02:** The operator setup surface should focus on `slack`, `teams`, and `webhook`. Existing `web`, `floating`, `voice`, `mobile`, and `native` sources may remain visible as evidence/status rows, but Phase 56 should not present them as messaging installations to configure.
- **D-03:** The setup UI must show source label, installation state, signing status, callback URL, signing secret setup/rotation action, health state, last inbound event time/id, last error code, and blocked reason.
- **D-04:** Signing secrets must not be displayed after save. The UI may let an operator enter or rotate a secret, then show only configured/missing/stale/signed status and operational health.
- **D-05:** Keep the setup surface near the existing One-Liner/daily work capture context, for example as a compact "메시징 입력 채널" section, instead of sending operators to generic plugin settings.
- **D-06:** Product-facing source setup copy must be Korean-first while preserving external source names such as Slack, Teams, webhook, callback URL, and signing secret.

### Public Messaging Inbound And Signing
- **D-07:** Add a dedicated messaging inbound route that external systems can call without a board user session. The existing authenticated `POST /companies/:companyId/rt2/one-liner/inbound-draft` remains for first-party web/PWA/native sends.
- **D-08:** The inbound route should resolve a company-scoped capture source by source type and/or source installation id, verify the configured signing secret, and then call the same `rt2WorkBoardService.createInboundDraft` path so messaging captures create normal draft/revision records.
- **D-09:** Use HMAC signing over a canonical normalized payload as the default verification model, reusing the existing `signCapturePayload` semantics where possible. The implementation can accept a request header such as `x-rt2-signature` and/or the existing `signature` payload field, but downstream evidence must record the resolved signing status.
- **D-10:** Missing or invalid signatures for a recognized installed source should create a `permission_blocked` draft with source evidence and reason code. Unknown company/source combinations may return a structured error without a draft if there is no safe company/source record to attach evidence to.
- **D-11:** A blocked or stale source should not silently accept payloads. It should create blocked evidence when source identity is known and update source health with the failure reason.
- **D-12:** Successful signed messaging payloads should enter the same reviewable draft lifecycle as web/mobile/native captures; Phase 56 must not auto-promote messaging captures to board tasks.

### Source Metadata And Payload Normalization
- **D-13:** Normalize Slack, Teams, and generic webhook payloads into the existing inbound draft fields: `source`, `text`, `channel`, `externalUserId`, `sourceInstallationId`, `eventId`, `eventTimestamp`, and `signature`.
- **D-14:** Preserve source-specific metadata in `sourceEvidence` or a narrow compatible extension to it. Useful metadata includes source label, channel/team/tenant ids, external user id, message/event id, timestamp, permalink/thread reference when available, and normalized provider kind.
- **D-15:** Do not store provider tokens, raw signing secrets, authorization headers, or unnecessary full payload blobs in capture draft evidence. Store enough redacted metadata for audit and review.
- **D-16:** Treat `eventId` as the primary idempotency hint for provider events when present. Content-hash duplicate detection remains useful, but repeated provider event ids and same-text duplicates should be distinguishable in audit details where feasible.
- **D-17:** If a payload is recognizable but lacks valid task text, persist a failed draft with a malformed/parse failure code and enough redacted source metadata for the operator to understand what arrived.

### Review And Audit Evidence
- **D-18:** The daily board capture inbox remains the operator review surface. Messaging drafts should show Slack/Teams/webhook source labels, source metadata, signing/permission status, duplicate warning, and malformed payload failure state in compact Korean UI.
- **D-19:** Duplicate, unauthorized source/signature, and malformed payload failures must be visually and semantically distinguishable in review/audit evidence. Recommended labels: `중복 의심`, `출처 차단`, `서명 오류`, `형식 오류`.
- **D-20:** Source health should be updated on every inbound attempt when the source record is known: last inbound event time/id, last error code, signing status, and blocked/stale reason as applicable.
- **D-21:** Phase 56 may add focused board inbox copy/chips to expose messaging failure types, but broad source/status filters and reliability reporting belong to Phase 57.
- **D-22:** Audit log entries should include source, status, duplicate id, permission/signing status, reason code, event id, and source installation id when available. They must not include signing secrets or sensitive authorization headers.

### Verification
- **D-23:** Add or extend shared validator/type coverage for messaging source configuration, source evidence metadata, and public inbound payload parsing.
- **D-24:** Add focused server tests for source setup/rotation, signed Slack/Teams/webhook inbound success, missing/invalid signature, blocked/stale source, duplicate payload, malformed payload, and source health updates.
- **D-25:** Add focused UI tests for the messaging source setup surface, secret non-disclosure after save, callback URL/status display, and board inbox failure labels.
- **D-26:** Verification should include `pnpm typecheck` and focused Vitest suites for changed shared/server/UI files. Run broad `pnpm test` only if feasible; the known Windows broad-suite timeout remains accepted host debt if focused checks pass.

### the agent's Discretion
- Exact route path, provided it is clearly dedicated to RT2 messaging capture, externally callable, and does not weaken normal board-auth routes.
- Exact settings surface placement, provided it stays near RT2 capture operations and remains Korean-first and compact.
- Exact metadata field shape, provided downstream review/audit can distinguish provider, event, channel, user, signing status, duplicate, authorization, and malformed payload evidence.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v2.9 milestone focus, RT2-first product rule, Korean-first capture/review loop, and deferred distribution/federation/autonomy scope.
- `.planning/REQUIREMENTS.md` - `MSG-01`, `MSG-02`, and `MSG-03` Phase 56 requirements.
- `.planning/ROADMAP.md` - Phase 56 goal and success criteria under v2.9.
- `.planning/STATE.md` - Current v2.9 planning state and milestone handoff.
- `.planning/phases/54-persistent-capture-draft-revision/54-CONTEXT.md` - Locked persistent draft revision, review states, source evidence, and promotion semantics.
- `.planning/phases/55-native-and-mobile-quick-capture-entry/55-CONTEXT.md` - Locked quick capture boundary and explicit deferral of Slack/Teams/webhook installation to Phase 56.
- `.planning/phases/51-one-liner-to-board-capture-flow/51-CONTEXT.md` - Existing One-Liner board review flow and capture handoff decisions.
- `.planning/phases/52-supporting-surfaces-and-identity-regression-gate/52-CONTEXT.md` - Korean-first product-facing identity and compact board surface constraints.
- `AGENTS.md` - Korean-first communication and RealTycoon2 terminology instruction for this repo.

### Capture Source Backend
- `packages/db/src/schema/rt2_work_board.ts` - `rt2_capture_sources`, `rt2_capture_drafts`, source evidence, signing status, duplicate, permission, and revision tables.
- `packages/db/src/migrations/0101_rt2_capture_source_hardening.sql` - Existing capture source/signing/evidence migration.
- `packages/db/src/migrations/0104_rt2_capture_draft_revisions.sql` - Existing draft revision migration.
- `packages/shared/src/types/rt2-task.ts` - Capture source/status/source evidence/queue/detail contracts to extend carefully.
- `packages/shared/src/validators/rt2-task.ts` - Source config, inbound draft, revision, transition, promote, and fail validators.
- `packages/shared/src/rt2-task.test.ts` - Shared capture contract tests to extend for messaging metadata and failure codes.
- `server/src/services/rt2-work-board.ts` - Source lookup/upsert, HMAC signing helper, inbound draft creation, duplicate detection, revision creation, source health update, queue listing, and failure transitions.
- `server/src/routes/rt2-tasks.ts` - Existing authenticated capture source and inbound draft routes; add public messaging inbound route here or a narrow adjacent route.
- `server/src/__tests__/rt2-task-routes.test.ts` - Focused server route coverage already includes signed capture evidence and should be extended for Phase 56 cases.

### Existing UI Surfaces
- `ui/src/api/rt2-tasks.ts` - Client helpers for capture sources, inbound drafts, capture queue, draft detail/revision/transition, promote/fail.
- `ui/src/pages/rt2/OneLinerPage.tsx` - Existing One-Liner page shows capture entrypoints and source evidence; likely home or reference for messaging source setup.
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Daily board container owns capture queue query and mutation invalidation.
- `ui/src/components/Rt2DailyBoard.tsx` - Board capture review inbox and compact Korean draft/failure evidence UI.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Focused component tests to extend for messaging source/failure labels.
- `ui/src/lib/queryKeys.ts` - Existing capture source/queue query keys for invalidation.

### Public Webhook References
- `server/src/routes/plugins.ts` - Reference for public webhook-style routes that intentionally do not require board authentication, while still validating declared capability/source identity.
- `server/src/services/routines.ts` and `server/src/__tests__/routines-service.test.ts` - Existing webhook/HMAC trigger behavior that can inform signature/timestamp failure tests without becoming the RT2 capture owner.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `rt2CaptureSources` already stores source, label, installation state, signing status, signing secret hash, last inbound event, last error code, blocked reason, and updater metadata.
- `rt2WorkBoardService.upsertCaptureSource` already creates/updates company-scoped source records and hashes signing secrets.
- `rt2WorkBoardService.createInboundDraft` already verifies source signing when a secret is present, creates `permission_blocked` drafts for missing/invalid signatures, detects duplicates, stores source evidence, creates revision `v1`, updates source health, and returns queue-ready summaries.
- `createOneLinerInboundDraftSchema` already accepts `slack`, `teams`, and `webhook` sources plus `sourceInstallationId`, `eventId`, `eventTimestamp`, and `signature`.
- `OneLinerPage` already fetches `captureSources` and `captureQueue` and renders source evidence rows, which can be upgraded from read-only evidence to a setup/install surface.
- `Rt2DailyBoard` already renders draft source labels, duplicate warnings, permission/signing evidence, revision controls, hold/reject/request-revision actions, and compact Korean status labels.
- Existing plugin webhook and routine webhook code provide public endpoint and HMAC test patterns, but RT2 capture should keep its own company-scoped source model.

### Established Patterns
- Shared Zod validators in `packages/shared` define the UI/server contract.
- Server routes validate request bodies before calling service methods; service methods own business rules and route handlers log activity.
- React Query owns client data refresh; source config and inbound attempts should invalidate capture source/queue and board-related queries as needed.
- RT2 product-facing surfaces are Korean-first and dense. Internal identifiers may remain English.
- Secrets are stored as hashes/secret refs, not displayed after save. Planning should preserve this non-disclosure behavior.
- Focused Vitest plus `pnpm typecheck` is the expected verification path on this Windows host.

### Integration Points
- Extend shared source evidence and inbound payload contracts only as much as needed to preserve messaging metadata and malformed payload evidence.
- Add a dedicated public messaging inbound route that normalizes Slack/Teams/webhook payloads and reuses `createInboundDraft`.
- Extend `rt2WorkBoardService` helpers for source health/error updates and malformed payload handling if current `createInboundDraft` cannot safely represent those failures.
- Upgrade the One-Liner/capture source evidence UI into a compact configuration surface for Slack, Teams, and webhook.
- Extend board inbox labels/chips so duplicate, signature/authorization, and malformed failures are distinguishable before Phase 57 adds filters/reports.
- Extend focused shared/server/UI tests around source setup, signed inbound, failure evidence, and source health.

</code_context>

<specifics>
## Specific Ideas

- Auto mode selected the conservative default: reuse the existing RT2 capture source/draft/revision path instead of introducing plugin-owned capture data.
- Phase 54 and 55 already locked the board review inbox as the review authority; messaging capture only feeds that queue.
- Current code already recognizes `slack`, `teams`, and `webhook` sources and has signed source evidence tests, so Phase 56 should harden the missing installation/public inbound/operator setup pieces rather than restarting the model.
- The existing read-only "Capture source evidence" block on `OneLinerPage` is a practical starting point for operator setup, but the final UI should be Korean-first and clearly operational.

</specifics>

<deferred>
## Deferred Ideas

- Broad board review filters, source/status/retry reliability report, and promotion-latency analytics belong to Phase 57.
- Slack/Teams marketplace OAuth app distribution, app-store/native packaging, push notifications, and public/open capture marketplace are future distribution/connector scope.
- Generic plugin webhook delivery history remains plugin infrastructure, not the canonical owner of RT2 messaging capture drafts.
- Cross-company federation full apply and autonomous Jarvis apply without approval remain outside v2.9 scope.

</deferred>

---

*Phase: 56-messaging-capture-source-installation*
*Context gathered: 2026-04-30*
