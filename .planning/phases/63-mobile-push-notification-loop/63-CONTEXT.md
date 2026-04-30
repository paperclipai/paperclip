# Phase 63: Mobile Push Notification Loop - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 63 implements the mobile/Web Push/APNs notification loop for RealTycoon2 native distribution readiness. The phase must make company/user/device-scoped push subscription state, minimal work-signal delivery, deep-link/click return to board review targets, and delivery/retry/failure evidence visible enough for operators to trust mobile notification readiness.

This phase owns push subscription/token registration evidence, revocation and rotation state, provider/device scoping, minimal payload semantics for RT2 work signals, click/deep-link routing back to review targets, delivery retry and invalid-token handling, permission-denied evidence, and capture reliability/reporting integration. It should not implement public store operations, marketing/reviewer workflows, final distribution gate aggregation, cross-company notification federation, or any automatic apply behavior. It should not reopen v2.9 DRAFT/NATIVE/MSG/REVIEW behavior except to add focused evidence hooks or fix concrete regression failures.

</domain>

<decisions>
## Implementation Decisions

### Implementation depth
- **D-01:** Implement Phase 63 as an evidence-first push notification contract plus focused tests and operator documentation, following the Phase 60 native signing gate, Phase 61 release channel gate, and Phase 62 resident surface gate pattern.
- **D-02:** Do not add broad native mobile scaffolding, APNs/Web Push provider dependencies, Tauri/mobile package dependencies, or `pnpm-lock.yaml` churn unless planning finds a narrow unavoidable reason. The first pass should validate subscription, payload, delivery, and click evidence from structured manifests and existing RT2 capture/review APIs.
- **D-03:** Add a deterministic root script for push readiness evidence, likely `scripts/rt2-push-notification-gate.mjs`, with durable output under `.planning/native-push-runs/<timestamp>/summary.json` and `report.md`.

### Subscription and token lifecycle
- **D-04:** Push registration evidence must be scoped by `companyId`, `userId` or external user identity, `deviceId`, `provider`, `platform`, and `registrationState`.
- **D-05:** Supported provider/platform vocabulary should distinguish Web Push/PWA and APNs/native-mobile paths without pretending one provider covers all devices. Recommended provider values are `web_push` and `apns`, with platform values such as `pwa`, `ios`, `macos`, and `desktop_web` if the evidence needs them.
- **D-06:** Registration state should fail closed with stable statuses such as `active`, `revoked`, `rotated`, `invalid`, `permission_denied`, `expired`, and `failed`. Only `active` tokens/subscriptions may pass delivery readiness; non-active states require reason/evidence and count as blocker or reliability evidence.
- **D-07:** Raw device tokens, APNs auth keys, VAPID private keys, provider passwords, and bearer credentials must never be committed or written into reports. Manifests may store token hashes, endpoint host/fingerprint, public-key references, or secret references only.
- **D-08:** Token rotation evidence must link the old registration, new registration, rotation timestamp, and reason. Revocation evidence must show operator/user action or provider invalidation and must prevent future delivery attempts to that registration.

### Work signal and payload semantics
- **D-09:** Push payloads must remain minimal. They should carry only signal type, company scope, target type/id, route/deep-link target, event ID/timestamp, and non-sensitive display labels needed for notification UX.
- **D-10:** Required RT2 work signals for this phase are `approval_waiting`, `failed_sync`, and `review_requested`. These map to existing board review and capture reliability surfaces rather than creating a separate notification inbox.
- **D-11:** Notification click/deep-link targets must return to the board review target or capture review inbox. For capture drafts, the route should resolve to the existing review surface for `/companies/:companyId/rt2/capture-drafts` or the board route that opens the relevant draft/card.
- **D-12:** Push notification payloads must not contain raw task descriptions, draft raw text, deliverable contents, secrets, provider credentials, or private foreground context. Full work detail remains loaded after authenticated app navigation.

### Delivery, retry, and click evidence
- **D-13:** Delivery evidence must record provider, device registration reference, signal type, target, event ID, queued/sent/delivered/failed status, attempt count, last attempt time, last error code, and next retry decision.
- **D-14:** Retry handling should be bounded and observable. Recommended retry states are `queued`, `sending`, `sent`, `delivered`, `failed`, `retry_scheduled`, `abandoned`, and `clicked`; retries must not hide a persistent provider failure.
- **D-15:** Token invalidation, permission denied, provider rejection, payload rejected, endpoint gone, and click-through missing should have stable blocker/metric codes so Phase 64 can aggregate them into distribution readiness.
- **D-16:** Click-through evidence must connect the provider event or service worker notification click to the target review route and include whether authenticated navigation reached the expected board/review target.

### Existing capture reliability integration
- **D-17:** Push metrics should extend the existing capture reliability/reporting vocabulary instead of creating a disconnected notification dashboard. Permission denied, token invalid, delivery failure, retry count, and click-through should be visible alongside capture reliability evidence where Phase 57/working-tree reporting already exposes failed sync, approval waiting, retry, and source rows.
- **D-18:** Push signals should reuse RT2 work states already visible in board/review surfaces: approval waiting cards, failed sync/capture failures, and review-requested drafts. New signal generation must not bypass `rt2WorkBoardService` review semantics or promotion guards.
- **D-19:** If backend schema/API work is needed, keep it additive and company-scoped. Prefer small tables or manifest-backed evidence records that can be traced to `rt2_capture_sources`, `rt2_capture_drafts`, activity log entries, and board review targets.

### PWA, service worker, and native boundary
- **D-20:** Existing `ui/public/sw.js` is the natural Web Push/PWA integration point. Phase 63 may add `push` and `notificationclick` handlers if planning keeps them credential-free and testable.
- **D-21:** APNs should be represented as a native/mobile provider contract and evidence path, not as a real credentialed send path in local tests. Provider credentials remain secret references, and fixture evidence should use hashes/placeholders.
- **D-22:** Tauri notification/deep-link/mobile capability remains a downstream/native integration target. Do not add Tauri plugins or `apps/desktop` solely to satisfy this phase unless the plan identifies a narrow, testable reason.

### Operator evidence and blockers
- **D-23:** Add a focused root package script and direct Node assertion test for the push notification gate, following `scripts/rt2-resident-surface-gate.mjs` and `scripts/rt2-release-channel-gate.mjs`.
- **D-24:** Required blockers should include missing provider registration, missing company/user/device scope, raw token/secret leakage, non-active registration without reason, missing rotation/revocation evidence, payload carrying sensitive content, unsupported signal type, missing deep-link target, failed delivery without retry/failure code, unbounded retry, invalid token not revoked, permission denied without operator evidence, and missing click-through evidence.
- **D-25:** Evidence outputs should be machine-readable enough for Phase 64 to consume without scraping Markdown. Keep stable top-level fields for status, blocker counts, registrations, signals, delivery attempts, click metrics, and capture reliability references.

### Documentation and downstream gate integration
- **D-26:** Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` with the Phase 63 push manifest shape, provider vocabulary, subscription lifecycle, minimal payload rules, click/deep-link target rules, and secret hygiene boundary.
- **D-27:** Update `doc/RELEASE-HOST-VERIFICATION.md` with the push notification gate command, output directory, blocker taxonomy, and operator interpretation.
- **D-28:** Phase 64 should be able to consume the Phase 63 `summary.json` as one distribution readiness input alongside native signing, updater/channel, resident surface, and v2.9 regression evidence.

### v2.9 regression protection
- **D-29:** Default verification should favor the new focused push gate test, existing capture/review route and UI tests touched by the plan, and `pnpm typecheck`. Do not run `pnpm test:e2e` as a default gate.
- **D-30:** No push flow may promote/apply a draft or task directly. A notification can take the operator to review, but approval/promotion remains an explicit board action.

### the agent's Discretion
- Exact manifest field names, report table layout, and blocker code names, provided they clearly map to `PUSH-01`, `PUSH-02`, and `PUSH-03` and fail closed.
- Whether the first implementation models push evidence as one combined manifest or separates registration, delivery, and click sections, provided one command validates the full readiness contract.
- Whether runtime-confidence aggregation is updated in Phase 63 or left to Phase 64, provided Phase 63 writes a stable `summary.json` that Phase 64 can consume.
- Whether minimal PWA service worker handlers are implemented in this phase or deferred to native/mobile packaging, provided the evidence gate still validates Web Push/PWA delivery and click semantics.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v3.0 milestone focus, RealTycoon2-first native distribution identity, and shipped v2.9 capture baseline.
- `.planning/REQUIREMENTS.md` - `PUSH-01`, `PUSH-02`, and `PUSH-03` requirement text and traceability.
- `.planning/ROADMAP.md` - Phase 63 goal, success criteria, and Phase 64 downstream boundary.
- `.planning/STATE.md` - Current handoff after Phase 62 and Windows verification caveats.
- `AGENTS.md` - Korean-first communication, RealTycoon2 terminology, verification policy, and lockfile policy.

### Phase 59-62 Foundation
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` - Tauri v2 baseline, mobile/Web Push/APNs owner phase, native capture approval boundary, resident surface handoff, and v3.0 gate references.
- `doc/RELEASE-HOST-VERIFICATION.md` - Existing release-host, native signing, release channel, resident surface, and runtime confidence evidence runbook.
- `.planning/phases/59-native-distribution-foundation/59-CONTEXT.md` - Locked decisions for Tauri baseline, `apps/desktop` boundary, mobile/Web Push/APNs ownership, and v2.9 regression gates.
- `.planning/phases/59-native-distribution-foundation/59-01-SUMMARY.md` - Phase 59 implementation and handoff summary.
- `.planning/phases/60-signing-and-notarization-pipeline/60-CONTEXT.md` - Locked decisions for native signing evidence and secret hygiene.
- `.planning/phases/60-signing-and-notarization-pipeline/60-01-SUMMARY.md` - Phase 60 implementation summary.
- `.planning/phases/61-release-channels-and-signed-updater/61-CONTEXT.md` - Locked decisions for installed channel/build identity, update lifecycle state, updater/channel evidence, and secret hygiene.
- `.planning/phases/61-release-channels-and-signed-updater/61-01-SUMMARY.md` - Phase 61 implementation summary.
- `.planning/phases/62-resident-tray-and-global-shortcut/62-CONTEXT.md` - Locked decisions for resident tray/global shortcut evidence, capture handoff, and Phase 63 boundary.
- `.planning/phases/62-resident-tray-and-global-shortcut/62-01-SUMMARY.md` - Phase 62 implementation summary and Phase 63 readiness note.

### Existing Release Evidence Assets
- `package.json` - Current focused `rt2:*` gate scripts, test scripts, and lockfile policy implications.
- `scripts/rt2-native-signing-gate.mjs` - Phase 60 evidence gate structure, blocker pattern, report writer, and secret rejection model.
- `scripts/rt2-native-signing-gate.test.mjs` - Focused direct assertion test pattern for native evidence gates.
- `scripts/rt2-release-channel-gate.mjs` - Phase 61 installed/update/channel state vocabulary and evidence output pattern.
- `scripts/rt2-release-channel-gate.test.mjs` - Focused updater/channel blocker coverage pattern.
- `scripts/rt2-resident-surface-gate.mjs` - Phase 62 resident evidence gate shape, blocker taxonomy, summary/report writer, and capture handoff validation pattern.
- `scripts/rt2-resident-surface-gate.test.mjs` - Focused resident surface blocker coverage pattern.
- `scripts/rt2-release-host-verify.mjs` - Existing release evidence harness and timestamped output convention.
- `scripts/rt2-runtime-confidence.mjs` - Existing confidence aggregation pattern that Phase 64 may extend.

### Capture, Review, And Reliability Baseline
- `ui/public/sw.js` - Existing PWA service worker; natural place for Web Push `push` and `notificationclick` handlers if implemented.
- `ui/public/site.webmanifest` - Existing RealTycoon2 PWA identity and quick-capture shortcut.
- `ui/src/lib/rt2-quick-capture-queue.ts` - Existing bounded mobile/native local queue semantics.
- `ui/src/pages/rt2/QuickCapturePage.tsx` - Existing quick-capture UI, send blockers, queue retry, and inbound draft submission flow.
- `ui/src/api/rt2-tasks.ts` - Existing `createInboundDraft`, capture source, capture queue, reliability report, draft revision, transition, promote, and fail API bindings.
- `ui/src/components/Rt2DailyBoard.tsx` - Existing board filters, capture review inbox, source evidence display, and capture reliability report UI.
- `ui/src/pages/rt2/DailyWorkPage.tsx` - Existing page integration for board, capture queue, and reliability report API calls.
- `server/src/routes/rt2-tasks.ts` - Existing inbound draft, capture source, capture queue, reliability report, revision, transition, promotion, and failure routes.
- `server/src/services/rt2-work-board.ts` - Persistent draft creation, source evidence, duplicate detection, permission blocking, reliability metrics, revision, review, and promotion boundaries.
- `packages/shared/src/types/rt2-task.ts` - `mobile`/`native` capture source, capture draft status, source evidence, queue filters, and reliability report types.
- `packages/shared/src/validators/rt2-task.ts` - Existing capture source and query validators that new push APIs/filters should align with.
- `packages/db/src/schema/rt2_work_board.ts` - Existing `rt2_capture_sources`, `rt2_capture_drafts`, and `rt2_capture_draft_revisions` schema.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-resident-surface-gate.mjs`, `scripts/rt2-release-channel-gate.mjs`, and `scripts/rt2-native-signing-gate.mjs` already provide the exact evidence-gate shape Phase 63 should reuse: parse manifest, validate fields, collect blockers/passed checks, write `summary.json` and `report.md`, reject raw secrets, and exit non-zero on blockers.
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` already lists Mobile/Web Push/APNs as Phase 63-owned and states that native capture from tray, shortcut, deep link, or push must enter persistent draft revision and board review without auto-apply.
- `ui/public/sw.js` is currently a network-first/offline fallback service worker with no push handlers, giving Phase 63 a small additive PWA surface if planning chooses to implement service worker click semantics.
- Existing capture sources and drafts already represent `mobile` and `native` source types, source evidence, event IDs/timestamps, signing status, permission blocking, duplicate warnings, semantic context, and review-only promotion.
- Current working tree already has additive capture queue filters and capture reliability report plumbing in `packages/shared/src/types/rt2-task.ts`, `packages/shared/src/validators/rt2-task.ts`, `server/src/routes/rt2-tasks.ts`, `server/src/services/rt2-work-board.ts`, `ui/src/api/rt2-tasks.ts`, `ui/src/components/Rt2DailyBoard.tsx`, and `ui/src/pages/rt2/DailyWorkPage.tsx`. Downstream work should preserve those in-flight edits and avoid reverting them.

### Established Patterns
- Native distribution phases are dependency-light and evidence-first. They validate operator contracts through deterministic manifests before introducing broad native shell/provider dependencies.
- Evidence output lives in timestamped `.planning/<evidence-kind>/<timestamp>/` directories with machine-readable and human-readable outputs.
- Distribution gates fail closed with stable blocker codes and next actions.
- Secret hygiene is enforced by scripts, tests, docs, and reports. Raw private keys, provider tokens, passwords, and signing material are blockers.
- RealTycoon2 product-facing naming is Korean-first; Paperclip remains infrastructure naming where already established.
- Focused tests plus `pnpm typecheck` are the practical default on this Windows host. `pnpm test:e2e` remains separate and should not be the default gate.

### Integration Points
- Add a Phase 63 push notification evidence gate under `scripts/`, likely `scripts/rt2-push-notification-gate.mjs`.
- Add a focused direct Node assertion test, likely `scripts/rt2-push-notification-gate.test.mjs`.
- Add package scripts such as `rt2:push-notification-gate` and `test:push-notification-gate`.
- Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` with the Phase 63 manifest and runbook.
- If UI/server changes are needed, connect them to existing capture review targets and reliability report routes rather than creating a separate notification inbox.
- Keep click/deep-link handoff pointed at board review/capture review surfaces; avoid adding any new apply/promotion path.

</code_context>

<specifics>
## Specific Ideas

- Push provider research should check official Web Push/Push API/Service Worker notification click references, Apple APNs token/remote notification references, and Tauri notification/deep-link/mobile plugin references before implementing provider-specific details.
- A good manifest shape should have top-level `registrations`, `signals`, `deliveries`, `clicks`, and `captureReliability` sections so Phase 64 can consume one summary without understanding provider-specific internals.
- Minimal payload rule: "wake and route, do not carry work content." Notification display can show safe labels, but sensitive task/draft details should load only after authenticated navigation.
- Click-through should be proven with a route target and reached-state evidence, not just "notification was clicked."
- Invalid token handling should both count a delivery failure and prove future sends are suppressed or the registration is marked revoked/invalid.
- Permission denied is not a silent skip. It must be visible as operator evidence and release-readiness risk.

</specifics>

<deferred>
## Deferred Ideas

- Final all-up distribution gate that combines unsigned, untrusted, wrong-channel, stale-updater, resident-surface, push, and v2.9-regressed artifact blocking belongs to Phase 64.
- Full native mobile app packaging, App Store/TestFlight operations, public store listing, reviewer account operations, marketing launch workflows, cross-company notification federation, and autonomous Jarvis apply remain outside Phase 63.
- Real credentialed APNs/Web Push provider sends in CI are deferred until secret management, platform packaging, and release environment policy are explicitly planned.

</deferred>

---

*Phase: 63-mobile-push-notification-loop*
*Context gathered: 2026-05-01*
