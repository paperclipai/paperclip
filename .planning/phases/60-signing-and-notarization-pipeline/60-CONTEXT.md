# Phase 60: Signing and Notarization Pipeline - Context

**Gathered:** 2026-04-30
**Status:** Ready for planning
**Mode:** auto

<domain>
## Phase Boundary

Phase 60 implements the signing and trust evidence pipeline for RealTycoon2 native distribution readiness. It must make macOS release artifacts accountable for Developer ID signing, hardened runtime, notarization submission/acceptance, ticket stapling, and Gatekeeper verification. It must make Windows release artifacts accountable for the selected trust path, installer/MSIX signing, timestamping, and install trust evidence. If required signing/trust evidence is missing or failed, the pipeline must block release publication and explain the failure in operator-readable output.

This phase should not implement release channels, signed updater feeds, rollout/rollback metadata, resident tray behavior, global shortcuts, mobile push delivery, public store listing operations, or new capture/review behavior. Those remain Phase 61 through Phase 64 or future scope. Phase 60 may add repo-local docs, scripts, tests, and release-gate wiring needed to validate signing evidence without committing real credentials or private key material.

</domain>

<decisions>
## Implementation Decisions

### Evidence-first release gate
- **D-01:** Implement Phase 60 as a deterministic signing evidence gate before attempting broad native packaging work. The gate should validate structured macOS and Windows evidence manifests plus referenced artifact/evidence files, then produce a machine-readable summary and human-readable report.
- **D-02:** The first implementation should be able to run in local/CI evidence mode with fixtures and placeholders. It must not require real Apple credentials, Windows certificate private keys, Azure signing credentials, or Tauri updater secrets to be present in the repo.
- **D-03:** Missing or failed evidence is a blocking release condition. The gate must return a failing exit code when required macOS or Windows evidence is absent, failed, untrusted, or references missing files.

### macOS signing and notarization evidence
- **D-04:** macOS evidence must explicitly cover artifact path, Developer ID Application identity, Apple Team ID, hardened runtime status, entitlement evidence owner/path, code-sign verification output, notarization submission ID/status, notarization log/reference, ticket stapling evidence, and Gatekeeper verification output.
- **D-05:** Hardened runtime, notarization, stapling, and Gatekeeper are separate checks. Passing code signing alone is not enough for Phase 60.
- **D-06:** The gate should accept evidence captured from real platform commands, but planning should keep command execution optional when the current host cannot produce macOS artifacts. The contract is to block incomplete evidence, not to fake success on Windows or Linux hosts.

### Windows signing and trust path evidence
- **D-07:** Windows evidence must explicitly record installer format, selected trust path, signer/certificate source reference, signing command/tool owner, timestamping status/TSA reference, signature verification output, and install trust or SmartScreen evidence.
- **D-08:** The selected Windows trust path must be a declared value, not inferred. Supported values should map to Phase 59 inventory: Store re-signing/MSIX, Azure Trusted Signing or Azure Code Signing, Azure Key Vault-backed signing command, EV/OV certificate path, or a documented custom sign command.
- **D-09:** Timestamping is mandatory evidence for Windows release artifacts. A signed installer without timestamp evidence remains a blocking failure.

### Operator-readable failure and audit output
- **D-10:** The gate should write evidence under timestamped run directories inside `.planning/native-signing-runs/`, with `summary.json` and `report.md`, following the existing release-host/runtime-confidence evidence pattern.
- **D-11:** Failure output must group blockers by platform and check, include a stable code, cite the source evidence path, identify the owner where known, and suggest the next command/action. Reports should be readable without inspecting raw CI logs.
- **D-12:** Secret values must be redacted or rejected. Documents and fixture manifests may contain secret references only, never raw Apple passwords, API keys, certificate private keys, keychain passwords, or updater private keys.

### Release workflow integration boundary
- **D-13:** Add the Phase 60 gate as a focused repo script and test first, then wire it as an explicit pre-publication release gate only where it can run without publishing artifacts accidentally. Existing npm canary/stable release behavior should not be rewritten wholesale.
- **D-14:** Phase 60 should integrate with existing `scripts/rt2-release-host-verify.mjs`, `scripts/rt2-runtime-confidence.mjs`, and release docs by adding native signing evidence as a new distribution signal rather than replacing existing release-host verification.
- **D-15:** Do not add Tauri/Electron dependencies, native build artifacts, or `pnpm-lock.yaml` churn unless the plan identifies a narrow, unavoidable reason. Phase 59 reserved `apps/desktop`; Phase 60 can validate signing evidence even before a full native shell scaffold lands.

### v2.9 regression protection
- **D-16:** Distribution signing work must leave the v2.9 DRAFT/NATIVE/MSG/REVIEW capture/review behavior closed as shipped baseline. Only add regression references or fix concrete gate failures if an existing focused gate fails.
- **D-17:** Default verification for this phase should favor focused script tests plus `pnpm typecheck`. `pnpm test:e2e` is not a default Phase 60 gate.

### the agent's Discretion
- Exact manifest field names and report layout, provided they clearly represent macOS and Windows required evidence and fail closed on missing data.
- Whether the implementation uses one combined script or small helper modules plus tests, provided scripts follow existing `scripts/rt2-*.mjs` patterns.
- Whether release workflow wiring is docs-only or a guarded workflow step in this phase, provided it does not require real secrets on every local developer run and does not publish unsigned artifacts.

</decisions>

<canonical_refs>
## Canonical References

**Downstream agents MUST read these before planning or implementing.**

### Phase Scope And Requirements
- `.planning/PROJECT.md` - v3.0 milestone focus, RealTycoon2-first distribution identity, and current native distribution boundary.
- `.planning/REQUIREMENTS.md` - `DIST-02` and `DIST-03` requirement text and traceability.
- `.planning/ROADMAP.md` - Phase 60 goal, success criteria, and Phase 61-64 downstream boundaries.
- `.planning/STATE.md` - Current handoff, Phase 59 completion context, and Windows verification caveats.
- `AGENTS.md` - Korean-first communication, RealTycoon2 terminology, verification policy, and lockfile policy.

### Phase 59 Foundation
- `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` - Native shell baseline, package layout, platform capability boundary, signing credential inventory, secret hygiene, and Phase 60 handoff.
- `.planning/phases/59-native-distribution-foundation/59-CONTEXT.md` - Locked decisions for Tauri baseline, `apps/desktop` boundary, macOS/Windows inventory, updater separation, and v2.9 regression gates.
- `.planning/phases/59-native-distribution-foundation/59-RESEARCH.md` - Prior research on Tauri signing/updater constraints and existing release evidence assets.
- `.planning/phases/59-native-distribution-foundation/59-01-SUMMARY.md` - Phase 59 implementation summary and verification evidence.

### Existing Release Evidence Assets
- `package.json` - Current workspace scripts, release scripts, existing Phase 59 validation script, release-host/runtime-confidence scripts, and lockfile policy implications.
- `.github/workflows/release.yml` - Current canary/stable verification and publication jobs that Phase 60 may gate.
- `scripts/rt2-release-host-verify.mjs` - Existing release-host evidence harness and timestamped `.planning/release-host-runs/` output pattern.
- `scripts/rt2-release-host-verify.test.mjs` - Existing test style for release evidence scripts.
- `scripts/rt2-runtime-confidence.mjs` - Existing runtime confidence aggregation and report pattern.
- `scripts/rt2-runtime-confidence.test.mjs` - Existing tests for confidence report behavior.
- `scripts/rt2-native-distribution-foundation.test.mjs` - Current document validation style for native distribution foundation.
- `scripts/release.sh` - Existing release command path and pre-publication verification behavior.
- `scripts/create-github-release.sh` - Existing GitHub Release creation flow.
- `doc/RELEASING.md` - Current canary/stable release runbook, smoke test guidance, and rollback references.
- `doc/PUBLISHING.md` - Current package publishing and trusted publishing internals.
- `doc/RELEASE-AUTOMATION-SETUP.md` - Existing release workflow/security setup notes.
- `doc/RELEASE-HOST-VERIFICATION.md` - Existing release-host evidence and runtime-confidence operator runbook.

### Native Package Boundary And Regression Gates
- `pnpm-workspace.yaml` - Current workspace layout; `apps/*` was intentionally not added in Phase 59.
- `ui/package.json` - Current Vite/React UI package scripts and dependency surface.
- `ui/vite.config.ts` - Existing Vite build/dev server configuration that future native packaging should consume.
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
- `scripts/rt2-release-host-verify.mjs` already writes per-run evidence directories with `summary.json`, `report.md`, blockers, owners, retry recommendations, and focused slice execution.
- `scripts/rt2-runtime-confidence.mjs` already aggregates release evidence and planning artifact gate status into operator-readable runtime confidence output.
- `scripts/rt2-native-distribution-foundation.test.mjs` already validates high-signal native distribution documentation and secret hygiene with a simple Node `.mjs` test.
- `package.json` already exposes focused `rt2:*` and `test:*` scripts for release confidence, identity gates, and native foundation checks.
- `.github/workflows/release.yml` already has separate verify and publish jobs for canary/stable releases, giving Phase 60 a clear pre-publication gate insertion point.

### Established Patterns
- Repo-local operational gates are Node `.mjs` scripts in `scripts/`, exposed through root `package.json`, and covered by direct Node assertion tests.
- Evidence output convention is a timestamped planning evidence directory containing `summary.json` plus `report.md`.
- Release gates should fail closed with explicit blockers instead of silently publishing incomplete artifacts.
- Real secrets are never committed; planning docs and test fixtures should use placeholders and secret references only.
- Focused tests plus `pnpm typecheck` are the practical default on this Windows host. Full `pnpm test` may be expensive or affected by known Windows embedded Postgres caveats.

### Integration Points
- Add a Phase 60 native signing/trust evidence script under `scripts/`, likely named with the existing `rt2-*` convention.
- Add a focused test script for manifest validation, blocker classification, redaction/secret rejection, and report generation.
- Add package scripts for running the gate and its focused test.
- Update release/native distribution docs so operators know what evidence files to provide and how blockers are interpreted.
- Optionally add guarded workflow wiring in `.github/workflows/release.yml` only after the script has a safe dry-run/evidence mode.

</code_context>

<specifics>
## Specific Ideas

- Treat macOS signing, hardened runtime, notarization, ticket stapling, and Gatekeeper as independent evidence checks so a partially signed artifact cannot pass.
- Treat Windows trust path, signing, timestamping, and install trust/SmartScreen evidence as independent checks so a signed-but-not-timestamped artifact cannot pass.
- Use stable blocker codes such as `MACOS_NOTARIZATION_MISSING`, `MACOS_GATEKEEPER_FAILED`, `WINDOWS_TIMESTAMP_MISSING`, and `WINDOWS_TRUST_PATH_MISSING` so reports are scriptable.
- Keep updater signing keys out of Phase 60 pass/fail logic except where the docs need to preserve the distinction between OS signing and updater signing. Phase 61 owns signed updater metadata.

</specifics>

<deferred>
## Deferred Ideas

- Release channels, signed updater metadata, rollout policy, and rollback candidate handling belong to Phase 61.
- Resident tray/menubar and OS-level global shortcut behavior belong to Phase 62.
- Mobile/Web Push/APNs subscription, delivery, retry, token invalid, permission denied, and click-through evidence belong to Phase 63.
- Final all-up distribution gate that combines unsigned/untrusted/wrong-channel/stale-updater/v2.9-regressed artifact blocking belongs to Phase 64.
- Public store listing, marketing, reviewer accounts, cross-company federation, public marketplace, and autonomous Jarvis apply remain outside v3.0 distribution readiness.

</deferred>

---

*Phase: 60-signing-and-notarization-pipeline*
*Context gathered: 2026-04-30*
