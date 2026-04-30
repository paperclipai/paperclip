# Phase 64: v3.0 Distribution Gate and Capture Regression Closure - Context

**Gathered:** 2026-05-01
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 64 closes v3.0 Native Distribution Readiness by adding the final RealTycoon2 distribution gate and reconciling completion truth. Distribution readiness may be marked green only when the Phase 60 native signing summary, Phase 61 release channel/updater summary, Phase 62 resident surface summary, Phase 63 push notification summary, and focused v2.9 capture regression evidence all pass for the same release identity.

This phase should not add a Tauri/Electron scaffold, real signing credentials, real APNs/Web Push provider sends, public store listing operations, marketing/reviewer workflows, or new capture/review features. It may add a deterministic repo-local final distribution gate, focused tests, package scripts, operator docs, validation/verification/summary artifacts, and narrow planning truth updates for `DIST-06`.

</domain>

<decisions>
## Implementation Decisions

### Final distribution gate shape
- **D-01:** Implement Phase 64 as an evidence-first final gate, likely `scripts/rt2-distribution-gate.mjs`, following the Phase 60-63 `scripts/rt2-*.mjs` pattern. Do not add native framework dependencies, provider SDKs, `apps/desktop`, Cargo files, or lockfile churn.
- **D-02:** The gate must write durable evidence under `.planning/native-distribution-gate-runs/<timestamp>/` with `summary.json` and `report.md`.
- **D-03:** Add root package scripts for the gate and focused test, likely `rt2:distribution-gate` and `test:distribution-gate`.
- **D-04:** The final gate input should be a machine-readable manifest with a release identity plus summary references. Required inputs are native signing, release channel/updater, resident surface, push notification, and v2.9 regression evidence. Do not scrape Markdown reports as the primary contract.
- **D-05:** Each referenced Phase 60-63 summary must exist, parse as JSON, report `status: "passed"`, and contain zero blockers. Missing, unreadable, stale, or blocked summaries are release blockers.
- **D-06:** The final gate should propagate upstream blocker meaning instead of re-implementing every platform rule. Unsigned, unnotarized, untrusted, timestamp-missing, wrong-channel, resident, push, and secret-hygiene failures should appear in the final report with stable final blocker codes and upstream source paths.

### Release identity and freshness
- **D-07:** The manifest should declare target release identity: `channel`, `version`, `buildId`, `generatedAt`, and optional freshness policy such as `maxAgeHours`. Supported channels remain `internal`, `beta`, and `stable`.
- **D-08:** Wrong-channel means the target release channel does not match the Phase 61 release-channel summary's installed/latest channel identity, or the referenced resident surface summary reports a different installed channel/build identity.
- **D-09:** Stale updater evidence means the Phase 61 summary is older than the freshness window, lacks a usable `generatedAt` or `updateState.checkedAt`, or reports an updater check that predates the target release identity. Use a conservative default freshness window of 24 hours unless the manifest explicitly sets a stricter value.
- **D-10:** Resident and push summaries must be aligned to the same release identity or explicitly cite the same build/channel evidence. A push loop that passes for an unrelated build or company scope should not make this release green.

### v2.9 capture regression closure
- **D-11:** Phase 64 must keep v2.9 DRAFT/NATIVE/MSG/REVIEW behavior closed as shipped baseline. Only touch capture/review source code to fix a concrete regression exposed by focused gates.
- **D-12:** The final gate should validate focused regression evidence records rather than running the test suite inside the aggregator. Planning/execution should still run the focused commands and write verification artifacts.
- **D-13:** Required focused regression evidence should cover:
  - `packages/shared/src/rt2-task.test.ts`
  - `server/src/__tests__/rt2-task-routes.test.ts`
  - `ui/src/lib/rt2-quick-capture-queue.test.ts`
  - `ui/src/pages/rt2/QuickCapturePage.test.tsx`
  - `ui/src/components/Rt2DailyBoard.test.tsx`
  - `pnpm run test:identity-gate`
  - `pnpm run rt2:identity-gate`
  - `pnpm typecheck`
- **D-14:** `pnpm test:e2e` remains outside the default Phase 64 gate. Browser E2E and release-smoke remain separate suites unless the plan identifies a narrow release-smoke need.
- **D-15:** If a broad `pnpm test` run fails due to a known unrelated Windows timeout but the exact failing slice passes on rerun, record that honestly as residual risk or accepted debt. Do not convert it into a hidden pass.

### Planning truth and closure artifacts
- **D-16:** Phase 64 should create `64-VALIDATION.md`, `64-VERIFICATION.md`, and `64-01-SUMMARY.md` after implementation and verification.
- **D-17:** Mark `DIST-06` complete only after the final distribution gate, focused v2.9 regression bundle, and planning artifact reconciliation pass.
- **D-18:** Reconcile `.planning/ROADMAP.md`, `.planning/REQUIREMENTS.md`, `.planning/STATE.md`, `.planning/PROJECT.md`, and `.planning/MILESTONES.md` so v3.0 completion status agrees across source-of-truth files.
- **D-19:** Because `gsd-sdk query` is unavailable in this environment, direct planning doc edits are acceptable only when kept narrow, auditable, and limited to Phase 64 closure truth. Do not rewrite unrelated roadmap sections.

### Documentation and operator handoff
- **D-20:** Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` with the Phase 64 final gate manifest shape, release identity alignment, freshness policy, and v2.9 regression evidence requirements.
- **D-21:** Update `doc/RELEASE-HOST-VERIFICATION.md` with the final distribution gate command, output directory, blocker taxonomy, and operator interpretation.
- **D-22:** The final report should give operators one release-readiness answer with grouped blockers, upstream evidence source, owner, and next command. It should be readable without inspecting every Phase 60-63 report manually.

### Blocker taxonomy and security
- **D-23:** Use stable blocker codes for final aggregation, such as `SIGNING_SUMMARY_MISSING`, `SIGNING_SUMMARY_BLOCKED`, `UPDATER_SUMMARY_STALE`, `UPDATER_CHANNEL_MISMATCH`, `RESIDENT_SUMMARY_BLOCKED`, `PUSH_SUMMARY_BLOCKED`, `CAPTURE_REGRESSION_FAILED`, `CAPTURE_REGRESSION_MISSING`, `PLANNING_TRUTH_DRIFT`, and `SECRET_REFERENCE_REQUIRED`.
- **D-24:** The final gate manifest must reject obvious raw secrets and sensitive fields that are not secret references. Phase 64 should preserve the Phase 60-63 secret-hygiene boundary.
- **D-25:** The final gate should fail closed on missing evidence. An omitted optional-looking summary or regression record is a blocker, not a warning.

### the agent's Discretion
- Exact manifest field names, report table layout, and helper function structure, provided the required release identity, summary refs, regression records, freshness checks, and blocker codes are represented clearly.
- Whether final regression evidence is modeled as a compact `regressionEvidence.commands[]` list or as grouped DRAFT/NATIVE/MSG/REVIEW sections, provided each required command/test path has status and evidence.
- Whether runtime-confidence aggregation is updated in this phase or left as a documented follow-up, provided Phase 64 writes a stable `summary.json` that future runtime confidence can consume.
- Whether broad `pnpm test` is attempted after focused verification, provided focused gates and `pnpm typecheck` remain the required default and `pnpm test:e2e` is not run by default.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase scope and milestone truth
- `.planning/PROJECT.md` - v3.0 milestone focus, RealTycoon2-first distribution identity, shipped v2.9 baseline, and current operating constraints.
- `.planning/REQUIREMENTS.md` - `DIST-06` traceability and v3.0 completion status.
- `.planning/ROADMAP.md` - Phase 64 goal, success criteria, and v3.0 roadmap completion row.
- `.planning/STATE.md` - Current handoff after Phase 63 and verification caveats.
- `.planning/MILESTONES.md` - Active v3.0 milestone status.
- `AGENTS.md` - Korean-first communication, RealTycoon2 terminology, verification policy, and lockfile policy.

### Native distribution foundation and prior gate decisions
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` - Phase 59-64 distribution contract, Phase 60-63 manifest shapes, and v2.9 regression gate bundle.
- `doc/RELEASE-HOST-VERIFICATION.md` - Existing release-host, native signing, release channel, resident surface, push notification, and runtime-confidence runbooks.
- `.planning/phases/59-native-distribution-foundation/59-CONTEXT.md` - Tauri v2 baseline, package boundary, credential inventory, and v2.9 regression gate boundary.
- `.planning/phases/59-native-distribution-foundation/59-01-SUMMARY.md` - Phase 59 implementation and handoff summary.
- `.planning/phases/60-signing-and-notarization-pipeline/60-CONTEXT.md` - Native signing evidence and secret hygiene decisions.
- `.planning/phases/60-signing-and-notarization-pipeline/60-01-SUMMARY.md` - Phase 60 signing gate implementation summary.
- `.planning/phases/61-release-channels-and-signed-updater/61-CONTEXT.md` - Release channel/updater evidence, installed/update state, rollback, and signing prerequisite decisions.
- `.planning/phases/61-release-channels-and-signed-updater/61-01-SUMMARY.md` - Phase 61 implementation summary.
- `.planning/phases/62-resident-tray-and-global-shortcut/62-CONTEXT.md` - Resident surface, shortcut, privacy, and capture handoff decisions.
- `.planning/phases/62-resident-tray-and-global-shortcut/62-01-SUMMARY.md` - Phase 62 implementation summary.
- `.planning/phases/63-mobile-push-notification-loop/63-CONTEXT.md` - Push notification subscription, payload, delivery, click, reliability, and Phase 64 summary-consumption decisions.
- `.planning/phases/63-mobile-push-notification-loop/63-01-SUMMARY.md` - Phase 63 implementation summary.

### Existing evidence gate assets
- `package.json` - Current focused `rt2:*` and `test:*` scripts and lockfile policy implications.
- `scripts/rt2-native-signing-gate.mjs` - Phase 60 summary shape, blocker pattern, report writer, and secret rejection model.
- `scripts/rt2-native-signing-gate.test.mjs` - Focused native signing gate test style.
- `scripts/rt2-release-channel-gate.mjs` - Phase 61 installed/update state, channel summary shape, signing prerequisite validation, and report pattern.
- `scripts/rt2-release-channel-gate.test.mjs` - Focused release channel gate coverage.
- `scripts/rt2-resident-surface-gate.mjs` - Phase 62 resident summary shape, blocker taxonomy, and capture handoff validation.
- `scripts/rt2-resident-surface-gate.test.mjs` - Focused resident surface gate coverage.
- `scripts/rt2-push-notification-gate.mjs` - Phase 63 push summary shape, blocker taxonomy, click/reliability validation, and secret rejection.
- `scripts/rt2-push-notification-gate.test.mjs` - Focused push notification gate coverage.
- `scripts/rt2-release-host-verify.mjs` - Release-host evidence runner and summary shape for focused/broad test evidence.
- `scripts/rt2-runtime-confidence.mjs` - Existing confidence aggregation pattern that may later consume Phase 64 output.

### v2.9 capture regression baseline
- `.planning/phases/58-v29-verification-and-distribution-readiness-closure/58-CONTEXT.md` - Locked v2.9 closure boundary and focused DRAFT/NATIVE/MSG/REVIEW regression bundle.
- `.planning/phases/58-v29-verification-and-distribution-readiness-closure/58-01-SUMMARY.md` - v2.9 closure implementation and verification summary.
- `.planning/phases/58-v29-verification-and-distribution-readiness-closure/58-VERIFICATION.md` - Prior v2.9 regression verification evidence.
- `packages/shared/src/rt2-task.test.ts` - Shared DRAFT/NATIVE/MSG/REVIEW contract regression gate.
- `server/src/__tests__/rt2-task-routes.test.ts` - Server route regression gate for draft, native/mobile, messaging, review, and reliability flows.
- `ui/src/lib/rt2-quick-capture-queue.test.ts` - Native/mobile quick capture queue regression gate.
- `ui/src/pages/rt2/QuickCapturePage.test.tsx` - Quick capture UI and source handoff regression gate.
- `ui/src/components/Rt2DailyBoard.test.tsx` - Board review and capture reliability UI regression gate.
- `scripts/rt2-identity-gate.mjs` - RealTycoon2 product identity regression gate.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-native-signing-gate.mjs`, `scripts/rt2-release-channel-gate.mjs`, `scripts/rt2-resident-surface-gate.mjs`, and `scripts/rt2-push-notification-gate.mjs` already provide the summary/report pattern Phase 64 should reuse: parse manifest, validate evidence, collect blockers and passed checks, write `summary.json` plus `report.md`, exit non-zero on blockers, and reject raw secrets.
- The Phase 60-63 summaries expose `generatedAt`, `status`, `counts.blockers`, `blockers`, `passed`, and capability-specific fields such as `installed`, `updateState`, `tray`, `shortcut`, `captureHandoff`, `registrations`, `signals`, `deliveries`, `clicks`, and `captureReliability`.
- `scripts/rt2-release-host-verify.mjs` already has a machine-readable attempts model with command, status, timestamps, owner, timeout, and retry recommendation. Phase 64 regression evidence can use the same ideas without making the final gate run all tests internally.
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` already contain the operator-facing native distribution contract and should be extended, not replaced.
- Existing focused tests for the gate scripts are direct Node assertion tests, which is the right pattern for Phase 64.

### Established Patterns
- Native distribution phases are dependency-light and credential-free. They validate release/operator evidence before adding broad native packaging.
- Evidence output lives in timestamped `.planning/<evidence-kind>/<timestamp>/` directories with machine-readable and human-readable outputs.
- Distribution gates fail closed with stable blocker codes and next actions.
- Product-facing naming stays RealTycoon2-first and Korean-first where user-facing; Paperclip can remain infrastructure naming in package/script internals.
- Focused tests plus `pnpm typecheck` are the practical default on this Windows host. `pnpm test:e2e` is separate and should not be the default gate.

### Integration Points
- Add a Phase 64 final distribution gate under `scripts/`, likely `scripts/rt2-distribution-gate.mjs`.
- Add a focused direct Node assertion test under `scripts/rt2-distribution-gate.test.mjs`.
- Add package scripts in `package.json` for running the final gate and its test.
- Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` with Phase 64 manifest/runbook details.
- Create Phase 64 validation, verification, and summary artifacts after execution.
- Reconcile `.planning/REQUIREMENTS.md`, `.planning/ROADMAP.md`, `.planning/STATE.md`, `.planning/PROJECT.md`, and `.planning/MILESTONES.md` only after the final gate and focused regression checks pass.

</code_context>

<specifics>
## Specific Ideas

- Good manifest shape:
  - `release`: `{ "channel": "stable", "version": "2026.501.0", "buildId": "stable-2026.501.0", "generatedAt": "...", "maxAgeHours": 24 }`
  - `summaries`: `{ "signing": ".../summary.json", "updater": ".../summary.json", "resident": ".../summary.json", "push": ".../summary.json" }`
  - `regressionEvidence`: command/test records with `id`, `command`, `status`, `evidence`, `startedAt`, and `endedAt`.
- The final gate should answer one question: "Can this exact RealTycoon2 build be treated as v3.0 distribution-ready?"
- The final report should group blockers by `signing`, `updater`, `resident`, `push`, `regression`, `planning`, and `secret-hygiene`.
- "Stale updater" should be concrete and scriptable: missing `updateState.checkedAt`, updater summary older than the freshness window, or updater build/channel mismatch.
- Planning truth should not be updated before verification passes. The closure docs are part of the acceptance evidence, not a substitute for it.

</specifics>

<deferred>
## Deferred Ideas

- Full `apps/desktop` Tauri scaffold remains deferred until a later native packaging phase explicitly requires it.
- Real credentialed macOS/Windows signing, APNs/Web Push provider sends, release feed hosting, and production artifact upload remain operator-provided evidence inputs, not repo-local secrets.
- Public store listing, marketing, reviewer account operations, cross-company federation, public marketplace, and autonomous Jarvis apply remain outside v3.0 distribution readiness.
- Runtime-confidence aggregation may consume the Phase 64 final summary later if it is not completed narrowly in this phase.

</deferred>

---

*Phase: 64-v30-distribution-gate-and-capture-regression-closure*
*Context gathered: 2026-05-01*
