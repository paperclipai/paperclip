# Phase 61: Release Channels and Signed Updater - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 61 implements internal, beta, and stable release channel metadata plus signed updater feed validation for RealTycoon2 native distribution readiness. The phase must make channel-specific version, artifact URL, checksum, signature, notes, rollout policy, rollback candidate, and update state visible enough for operators to decide whether a build can roll forward, pause, or roll back.

This phase should not implement resident tray behavior, OS-level global shortcuts, mobile push delivery, public store listing operations, or new v2.9 capture/review behavior. It may add repo-local channel/updater manifests, signed metadata validation, focused tests, operator docs, package scripts, and release/runtime evidence integration. The actual native desktop scaffold remains constrained by Phase 59 and should be added only if planning finds a narrow, unavoidable need.

</domain>

<decisions>
## Implementation Decisions

### Channel feed contract
- **D-01:** Treat `internal`, `beta`, and `stable` as distinct native release channel identities. Do not collapse them into the existing npm `canary` and `latest` tags. npm tags may be referenced as package-distribution evidence, but native updater channels need their own feed metadata and rollout policy.
- **D-02:** Every channel record must carry at least: channel name, version, build identity, generated timestamp, artifact URL, SHA-256 checksum, updater signature, release notes or notes URL, rollout policy, rollback candidate, and prerequisite signing evidence reference.
- **D-03:** Model artifacts per platform. macOS and Windows entries can share a channel/version but must have independent artifact URL, checksum, updater signature, and signing/trust evidence. A complete channel may not hide one platform's missing updater metadata behind the other platform's pass.
- **D-04:** Rollback candidate metadata is mandatory for each channel before a feed can be considered publishable. A channel can explicitly declare "no rollback available" only as a blocker or pre-release state, not as a passing release state.

### Signed updater validation
- **D-05:** Implement Phase 61 as a deterministic repo-local updater/channel gate before adding broad native shell dependencies. The gate should validate channel feed metadata and produce durable `summary.json` plus `report.md` evidence, following the Phase 44/47/60 evidence pattern.
- **D-06:** Signed updater metadata validation must fail closed before download/install/relaunch. Required checks include channel match, version/build identity, artifact URL, checksum format, updater signature presence or verification, release notes presence, rollout policy bounds, rollback candidate validity, and Phase 60 signing gate prerequisite status.
- **D-07:** Keep updater signing key material separate from OS code-signing identities. Public verification material may be committed or referenced by path; private updater keys and key passwords must be secret references only and must never appear in manifests, docs, tests, or reports.
- **D-08:** The first implementation should be compatible with Tauri v2 signed updater concepts but should not require adding Tauri dependencies or `apps/desktop` unless the plan identifies a narrow implementation reason. The repo can validate the feed contract with Node scripts and fixtures first.

### Operator-visible update state
- **D-09:** Operator output should expose installed channel/build identity, latest available channel/build identity, rollout decision, download/install/relaunch state, rollback candidate, and failure reason in machine-readable and human-readable evidence.
- **D-10:** Use a small explicit updater state vocabulary that can later map to the native shell: `idle`, `checking`, `available`, `downloading`, `downloaded`, `installing`, `relaunch_required`, `failed`, and `rolled_back`.
- **D-11:** Failure reports must group blockers by channel, platform, and check with stable codes and next actions. Examples: `CHANNEL_ARTIFACT_URL_MISSING`, `CHANNEL_CHECKSUM_INVALID`, `UPDATER_SIGNATURE_MISSING`, `ROLLBACK_CANDIDATE_MISSING`, `SIGNING_GATE_BLOCKED`, and `ROLLOUT_POLICY_INVALID`.

### Release and runtime evidence integration
- **D-12:** Phase 61 must consume Phase 60 native signing gate output as a prerequisite signal. A channel feed should not pass if the referenced signing gate summary is missing, blocked, or mismatched to the platform artifact identity.
- **D-13:** Add a focused root package script and test for the updater/channel gate, following the existing `scripts/rt2-*.mjs` and direct Node assertion test pattern.
- **D-14:** Update native distribution and release-host docs so operators know how to create channel manifests, run the gate, read update blockers, and decide rollback.
- **D-15:** Release workflow integration should stay guarded. Do not publish or auto-update from GitHub Actions in this phase unless the script can run in dry-run/evidence mode and cannot accidentally ship incomplete native artifacts.

### v2.9 regression protection
- **D-16:** Phase 61 must keep v2.9 DRAFT/NATIVE/MSG/REVIEW behavior closed as shipped baseline. Only add regression references or fix concrete focused-gate failures if existing tests fail.
- **D-17:** Default verification should favor focused updater/channel tests plus `pnpm typecheck`. `pnpm test:e2e` is not a default Phase 61 gate.

### the agent's Discretion
- Exact manifest filename, JSON field names, and report table layout, provided the required channel/updater facts are represented clearly and fail closed.
- Whether the evidence directory is named `.planning/native-updater-runs/`, `.planning/release-channel-runs/`, or a similar scoped path, provided it is timestamped and contains `summary.json` plus `report.md`.
- Whether signature validation starts as strict signature-presence plus key-reference hygiene or full cryptographic verification in the first plan, provided the plan explicitly documents the chosen pass criteria and does not fake trust.
- Whether runtime-confidence aggregation is updated in this phase or left as a documented follow-up, provided operator-visible updater state exists as durable evidence.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v3.0 milestone focus, RealTycoon2-first native distribution identity, and shipped v2.9 baseline.
- `.planning/REQUIREMENTS.md` - `DIST-04` and `DIST-05` requirement text and traceability.
- `.planning/ROADMAP.md` - Phase 61 goal, success criteria, and Phase 62-64 downstream boundaries.
- `.planning/STATE.md` - Current handoff and Phase 60 completion context.
- `AGENTS.md` - Korean-first communication, RealTycoon2 terminology, verification policy, and lockfile policy.

### Phase 59-60 Foundation
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` - Tauri v2 baseline, updater key material, channel evidence fields, and Phase 60 signing gate contract.
- `.planning/phases/59-native-distribution-foundation/59-CONTEXT.md` - Locked decisions for Tauri baseline, `apps/desktop` boundary, updater key separation, channel identities, and v2.9 regression gates.
- `.planning/phases/59-native-distribution-foundation/59-01-SUMMARY.md` - Phase 59 implementation and verification summary.
- `.planning/phases/60-signing-and-notarization-pipeline/60-CONTEXT.md` - Locked decisions for native signing evidence, secret hygiene, and Phase 61 updater separation.
- `.planning/phases/60-signing-and-notarization-pipeline/60-01-SUMMARY.md` - Phase 60 implementation summary and Phase 61 readiness note.
- `.planning/phases/60-signing-and-notarization-pipeline/60-VERIFICATION.md` - Passed signing evidence gate verification and requirement closure.

### Existing Release Evidence Assets
- `package.json` - Existing release, release-host, runtime-confidence, native foundation, and native signing gate scripts.
- `.github/workflows/release.yml` - Current canary/stable verification and publication jobs that Phase 61 may guard in dry-run/evidence mode.
- `scripts/release.sh` - Existing npm canary/stable release model, versioning, clean-worktree policy, and verification behavior.
- `scripts/create-github-release.sh` - Existing GitHub Release creation flow.
- `doc/RELEASING.md` - Current canary/stable runbook, rollback behavior, and release surface definitions.
- `doc/PUBLISHING.md` - Current package publishing and trusted publishing internals.
- `doc/RELEASE-AUTOMATION-SETUP.md` - Existing release workflow/security setup notes.
- `doc/RELEASE-HOST-VERIFICATION.md` - Release-host, native signing gate, and runtime-confidence operator runbook.
- `scripts/rt2-release-host-verify.mjs` - Existing timestamped evidence harness pattern.
- `scripts/rt2-runtime-confidence.mjs` - Existing runtime confidence aggregation and report pattern.
- `scripts/rt2-native-signing-gate.mjs` - Phase 60 signing/trust evidence prerequisite gate.
- `scripts/rt2-native-signing-gate.test.mjs` - Focused test pattern for platform evidence blockers and secret rejection.

### Native Package Boundary And Regression Gates
- `pnpm-workspace.yaml` - Current workspace layout; `apps/*` is not present yet.
- `ui/package.json` - Current Vite/React UI package scripts and dependency surface.
- `ui/vite.config.ts` - Existing Vite build/dev server configuration future native packaging should consume.
- `ui/public/site.webmanifest` - Existing RealTycoon2 PWA identity and quick-capture shortcut.
- `packages/shared/src/rt2-task.test.ts` - v2.9 draft/capture contract regression gate.
- `server/src/__tests__/rt2-task-routes.test.ts` - v2.9 route/capture regression gate.
- `ui/src/lib/rt2-quick-capture-queue.test.ts` - mobile/native quick capture queue regression gate.
- `ui/src/pages/rt2/QuickCapturePage.test.tsx` - quick capture UI/source handoff regression gate.
- `ui/src/components/Rt2DailyBoard.test.tsx` - board review/reliability UI regression gate.

</canonical_refs>

<code_context>
## Existing Code Insights

### Reusable Assets
- `scripts/rt2-native-signing-gate.mjs` already validates platform evidence manifests, rejects raw secrets, writes `summary.json` and `report.md`, and returns non-zero for blockers. Phase 61 should mirror this gate shape for updater/channel evidence.
- `scripts/rt2-release-host-verify.mjs` and `scripts/rt2-runtime-confidence.mjs` establish the repo pattern for timestamped evidence directories and operator-readable reports.
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` already defines updater key material, channel fields, and Tauri updater reference points. Phase 61 should extend it instead of creating a second source of truth.
- `.github/workflows/release.yml` already separates verify and publish jobs for canary/stable npm releases, giving Phase 61 a guarded insertion point if workflow wiring is needed.
- Existing v2.9 focused tests protect capture/review behavior so updater work can stay distribution-scoped.

### Established Patterns
- Operational release gates are Node `.mjs` scripts in `scripts/`, exposed through root `package.json`, and covered by small direct Node assertion tests.
- Evidence output convention is a timestamped `.planning/<evidence-kind>/<timestamp>/` directory containing machine-readable JSON and human-readable Markdown.
- Distribution evidence fails closed with explicit blockers and next actions rather than silently treating missing evidence as a pass.
- Secret values are referenced, not committed. Fixture manifests may use placeholders and generated test keys only.
- Focused tests plus `pnpm typecheck` are the practical default on this Windows host; broad `pnpm test` can be attempted when the plan needs it, but known timeout/embedded Postgres caveats must be recorded honestly.

### Integration Points
- Add a Phase 61 updater/channel gate under `scripts/`, likely using the existing `rt2-*` naming convention.
- Add a focused test script covering complete channel manifests, missing signature/checksum/rollback blockers, signing prerequisite mismatch, rollout policy validation, secret rejection, and CLI output.
- Add root package scripts for the gate and focused test.
- Update `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` with the channel manifest shape and runbook.
- Optionally update runtime confidence aggregation to consume the latest updater/channel evidence, if that stays small and does not reopen old v2.7 assumptions.

</code_context>

<specifics>
## Specific Ideas

- Treat release channel feeds as native distribution metadata, not as a direct alias of npm `canary`/`latest`.
- Keep a rollback candidate even for internal builds; internal may point to the previous internal build while stable should point to the last known good stable.
- Require a Phase 60 signing gate summary reference in each platform artifact entry so signed updater metadata cannot be considered valid before OS signing/trust evidence exists.
- Use stable blocker codes so future Phase 64 can combine unsigned, untrusted, wrong-channel, stale-updater, and v2.9-regressed artifact failures into one distribution gate.
- If full cryptographic signature verification is implemented in this phase, use generated fixture keys in tests and keep any real private key as a secret reference only.

</specifics>

<deferred>
## Deferred Ideas

- Resident tray/menubar and OS-level global shortcut behavior belong to Phase 62.
- Mobile/Web Push/APNs subscription, delivery, retry, token invalid, permission denied, and click-through evidence belong to Phase 63.
- Final all-up distribution gate that combines unsigned/untrusted/wrong-channel/stale-updater/v2.9-regressed artifact blocking belongs to Phase 64.
- Public store listing, marketing, reviewer accounts, cross-company federation, public marketplace, and autonomous Jarvis apply remain outside v3.0 distribution readiness.

</deferred>

---

*Phase: 61-release-channels-and-signed-updater*
*Context gathered: 2026-04-30*
