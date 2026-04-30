# Phase 62: Resident Tray and Global Shortcut - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 62 implements the resident desktop entry contract for RealTycoon2 native distribution readiness. The phase must make tray/menubar status and OS-level global shortcut state visible enough for operators to trust quick capture from the desktop shell, while preserving the v2.9 persistent draft review loop.

This phase owns resident tray/menubar status, tray quick-capture entry, global shortcut registration/unregistration/change state, conflict/permission/focus/privacy evidence, and capture handoff into existing persistent drafts. It should not implement mobile push, final distribution gate aggregation, public store operations, or any automatic apply behavior. It should not reopen v2.9 DRAFT/NATIVE/MSG/REVIEW behavior except to add regression references or fix concrete focused-gate failures.

</domain>

<decisions>
## Implementation Decisions

### Implementation depth
- **D-01:** Implement Phase 62 as an evidence-first resident surface gate plus operator documentation, following the Phase 60 native signing gate and Phase 61 release channel gate pattern.
- **D-02:** Do not add Tauri dependencies, `apps/desktop`, Cargo files, or `pnpm-lock.yaml` churn unless the plan identifies a narrow unavoidable reason. The first pass should validate the tray/shortcut contract from structured manifests and existing RT2 capture APIs.
- **D-03:** The gate should write durable machine-readable and human-readable evidence under `.planning/native-resident-runs/<timestamp>/` with `summary.json` and `report.md`.

### Tray and menubar status contract
- **D-04:** Tray/menubar status must expose quick capture availability, local queue/sync state, auth state, company state, installed channel, installed version/build ID, update lifecycle state, and the last failure reason when present.
- **D-05:** Installed channel/build identity and update lifecycle vocabulary must reuse the Phase 61 release channel gate contract. Do not invent a second updater state model.
- **D-06:** Tray status should be platform-aware for `macos` and `windows`. Linux may be documented as unsupported or optional evidence for this milestone, because v3.0 signing/updater readiness is macOS/Windows-centered.

### Global shortcut lifecycle
- **D-07:** Global shortcut evidence must track the configured accelerator, platform, registration state, conflict state, permission state, focus behavior, privacy behavior, and unregistration/change evidence.
- **D-08:** Registration state should fail closed with stable statuses such as `registered`, `unregistered`, `conflict`, `permission_required`, `unsupported`, and `failed`. A missing conflict or permission explanation is a blocker.
- **D-09:** Shortcut handling should open or focus the RealTycoon2 quick-capture surface. It must not read foreground app content, clipboard contents, screen/window titles, selected text, or private context automatically.

### Capture handoff and approval boundary
- **D-10:** Tray and shortcut capture must create or update persistent drafts through the existing `POST /companies/:companyId/rt2/one-liner/inbound-draft` route and `rt2WorkBoardService.createInboundDraft` behavior.
- **D-11:** Native desktop capture should use source `native` with channels that distinguish entry points, such as `native:tray` and `native:global-shortcut`, and should include event ID/timestamp and user/company context when available.
- **D-12:** Offline or blocked capture should reuse the existing quick-capture queue semantics rather than inventing a second queue. Queue state should surface as tray evidence and remain bounded.
- **D-13:** No tray or shortcut flow may call promote/apply actions directly. Draft promotion remains an operator review action through the board review inbox.

### Operator evidence and blockers
- **D-14:** Add a focused root script and test for the resident surface gate, following the `scripts/rt2-*.mjs` and direct Node assertion test pattern.
- **D-15:** Required blockers should include missing tray quick capture, missing queue/auth/company/build/channel/update state, missing shortcut accelerator, missing unregister/change evidence, conflict unresolved, permission required without explanation, privacy behavior that auto-reads foreground context, and capture handoff that bypasses draft review.
- **D-16:** Secret hygiene remains required. Any native manifest fields that reference tokens, keys, signing material, or provider credentials must use secret references only.

### Documentation and downstream gate integration
- **D-17:** Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` with the Phase 62 tray/shortcut manifest shape, status vocabulary, capture handoff rules, and privacy boundary.
- **D-18:** Update `doc/RELEASE-HOST-VERIFICATION.md` with the resident surface gate command, output directory, blockers, and operator interpretation.
- **D-19:** Phase 64 should be able to consume the Phase 62 `summary.json` as one distribution readiness input alongside native signing and updater/channel evidence.

### v2.9 regression protection
- **D-20:** Default verification should favor the new focused resident surface gate test, existing quick-capture/draft route tests where touched, and `pnpm typecheck`. Do not run `pnpm test:e2e` as a default gate.
- **D-21:** If planning touches existing capture source or draft types, keep changes additive and compatible with the current `native` source, `rt2_capture_sources`, `rt2_capture_drafts`, quick-capture queue, and review inbox contracts.

### the agent's Discretion
- Exact manifest field names, report table layout, and blocker code names, provided they clearly map to RES-01, RES-02, and RES-03 and fail closed.
- Whether runtime-confidence aggregation is updated in this phase or left to Phase 64, provided Phase 62 writes a stable `summary.json` that Phase 64 can consume.
- Whether the first evidence manifest models tray and shortcut as one combined file or separate sections, provided one command validates the full resident surface readiness contract.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v3.0 milestone focus, RealTycoon2-first native distribution identity, and shipped v2.9 capture baseline.
- `.planning/REQUIREMENTS.md` - `RES-01`, `RES-02`, and `RES-03` requirement text and traceability.
- `.planning/ROADMAP.md` - Phase 62 goal, success criteria, and Phase 63-64 downstream boundaries.
- `.planning/STATE.md` - Current handoff and Phase 61 completion context.
- `AGENTS.md` - Korean-first communication, RealTycoon2 terminology, verification policy, and lockfile policy.

### Phase 59-61 Foundation
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` - Tauri v2 baseline, tray/shortcut owner phase, updater channel contract, and native capture approval boundary.
- `doc/RELEASE-HOST-VERIFICATION.md` - Existing release-host, native signing, release channel, and runtime confidence evidence runbook.
- `.planning/phases/59-native-distribution-foundation/59-CONTEXT.md` - Locked decisions for Tauri baseline, `apps/desktop` boundary, tray/shortcut ownership, and v2.9 regression gates.
- `.planning/phases/59-native-distribution-foundation/59-01-SUMMARY.md` - Phase 59 implementation and handoff summary.
- `.planning/phases/60-signing-and-notarization-pipeline/60-CONTEXT.md` - Locked decisions for native signing evidence and secret hygiene.
- `.planning/phases/60-signing-and-notarization-pipeline/60-01-SUMMARY.md` - Phase 60 implementation summary.
- `.planning/phases/61-release-channels-and-signed-updater/61-CONTEXT.md` - Locked decisions for installed channel/build identity, update lifecycle state, and updater/channel evidence.
- `.planning/phases/61-release-channels-and-signed-updater/61-01-SUMMARY.md` - Phase 61 implementation summary and Phase 62 readiness note.

### Existing Release Evidence Assets
- `package.json` - Current focused `rt2:*` gate scripts and lockfile policy implications.
- `scripts/rt2-native-signing-gate.mjs` - Phase 60 evidence gate structure, blocker pattern, report writer, and secret rejection model.
- `scripts/rt2-native-signing-gate.test.mjs` - Focused direct assertion test pattern for native evidence gates.
- `scripts/rt2-release-channel-gate.mjs` - Phase 61 installed/update/channel state vocabulary and evidence output pattern.
- `scripts/rt2-release-channel-gate.test.mjs` - Focused updater/channel blocker coverage pattern.
- `scripts/rt2-release-host-verify.mjs` - Existing release evidence harness and timestamped output convention.
- `scripts/rt2-runtime-confidence.mjs` - Existing confidence aggregation pattern that Phase 64 may extend.

### Capture And Review Baseline
- `ui/src/lib/rt2-quick-capture-queue.ts` - Existing bounded mobile/native local queue.
- `ui/src/pages/rt2/QuickCapturePage.tsx` - Existing quick-capture UI, send blockers, queue retry, and inbound draft submission flow.
- `ui/src/api/rt2-tasks.ts` - Existing `createInboundDraft`, capture source, queue, draft revision, transition, promote, and fail API bindings.
- `server/src/routes/rt2-tasks.ts` - Existing inbound draft, capture source, capture queue, revision, transition, promotion, and failure routes.
- `server/src/services/rt2-work-board.ts` - Persistent draft creation, source evidence, duplicate detection, permission blocking, revision, review, and promotion boundaries.
- `packages/shared/src/types/rt2-task.ts` - `native` capture source, capture draft status, source evidence, and reliability report types.
- `packages/db/src/schema/rt2_work_board.ts` - Existing `rt2_capture_sources`, `rt2_capture_drafts`, and `rt2_capture_draft_revisions` schema.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-native-signing-gate.mjs` and `scripts/rt2-release-channel-gate.mjs` already provide the exact evidence-gate shape Phase 62 should reuse: parse manifest, validate fields, collect blockers/passed checks, write `summary.json` and `report.md`, and exit non-zero on blockers.
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` already lists resident tray/menubar and global shortcut as Phase 62-owned capabilities and states that native capture must enter persistent draft revision and board review.
- `scripts/rt2-release-channel-gate.mjs` already defines the installed channel/build identity and update lifecycle states that tray status should surface.
- `ui/src/lib/rt2-quick-capture-queue.ts` already supports bounded `mobile` and `native` queue items with local statuses `queued`, `sending`, `failed`, and `sent`.
- `server/src/services/rt2-work-board.ts` already persists source evidence, duplicate warnings, permission blocking, semantic context, latest revisions, and review-only promotion.

### Established Patterns
- Native distribution phases are currently credential-free and dependency-light. They validate operator evidence before broad native shell scaffolding.
- Evidence output lives in timestamped `.planning/<evidence-kind>/<timestamp>/` directories with machine-readable and human-readable outputs.
- Release and distribution gates fail closed with stable blocker codes and next actions.
- Product-facing naming remains RealTycoon2-first and Korean-first; Paperclip names remain internal infrastructure only.
- Focused tests plus `pnpm typecheck` are the practical default on this Windows host; broad `pnpm test` can be attempted when useful but known timeout/embedded Postgres caveats should be recorded honestly.

### Integration Points
- Add a Phase 62 resident surface evidence gate under `scripts/`, likely `scripts/rt2-resident-surface-gate.mjs`.
- Add a focused direct Node assertion test, likely `scripts/rt2-resident-surface-gate.test.mjs`.
- Add package scripts such as `rt2:resident-surface-gate` and `test:resident-surface-gate`.
- Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` with the Phase 62 manifest and runbook.
- Keep capture handoff pointed at existing inbound draft APIs and draft review surfaces; avoid adding new apply/promotion paths.

</code_context>

<specifics>
## Specific Ideas

- Tauri system tray docs show tray creation/customization with JavaScript or Rust APIs, menu items, menu click events, and tray icon events. Phase 62 should treat this as the future implementation target but validate the contract without requiring a scaffold in the first pass.
- Tauri global shortcut docs show a dedicated `global-shortcut` plugin with desktop support and setup through `pnpm tauri add global-shortcut` or Cargo plugin registration. Phase 62 should capture registration and conflict state as evidence before introducing dependency churn.
- Tauri notification docs require checking and requesting permission before sending notifications. Phase 62 should only surface notification/privacy state if useful; mobile push remains Phase 63.
- Tauri deep-link docs note desktop deep-link testing caveats, especially installed-app behavior. Phase 62 should not depend on deep-link success unless the plan adds a narrow, testable handoff.
- Shortcut privacy rule: the shortcut opens a capture surface and waits for explicit operator input. It must not scrape the active application context.

External official references checked during auto discussion:
- `https://v2.tauri.app/learn/system-tray/`
- `https://v2.tauri.app/plugin/global-shortcut/`
- `https://v2.tauri.app/reference/javascript/global-shortcut/`
- `https://v2.tauri.app/plugin/notification/`
- `https://v2.tauri.app/plugin/deep-linking/`

</specifics>

<deferred>
## Deferred Ideas

- Full `apps/desktop` Tauri scaffold remains deferred unless Phase 62 planning proves it is narrowly required.
- Mobile/Web Push/APNs subscription, delivery, retry, token invalid, permission denied, and click-through evidence belong to Phase 63.
- Final all-up distribution gate that combines unsigned, untrusted, wrong-channel, stale-updater, resident-surface, push, and v2.9-regressed artifact blocking belongs to Phase 64.
- Public store listing, marketing, reviewer accounts, cross-company federation, public marketplace, and autonomous Jarvis apply remain outside v3.0 distribution readiness.

</deferred>

---

*Phase: 62-resident-tray-and-global-shortcut*
*Context gathered: 2026-04-30*
