# Phase 60: Signing and Notarization Pipeline - Discussion Log

> **Audit trail only.** Do not use as input to planning, research, or execution agents.
> Decisions are captured in CONTEXT.md — this log preserves the alternatives considered.

**Date:** 2026-04-30
**Phase:** 60-Signing and Notarization Pipeline
**Areas discussed:** Evidence-first release gate, macOS signing and notarization evidence, Windows signing and trust path evidence, Operator-readable failure and audit output, Release workflow integration boundary, v2.9 regression protection
**Mode:** auto (`--auto --chain`)

---

## Evidence-first release gate

| Option | Description | Selected |
|--------|-------------|----------|
| Deterministic evidence gate | Validate structured evidence manifests, produce `summary.json` and `report.md`, and fail closed on missing/failed evidence. | yes |
| Direct native packaging first | Add native package dependencies and signing commands before evidence contracts are stable. | |
| Documentation only | Document expectations without adding a runnable gate. | |

**User's choice:** auto-selected deterministic evidence gate.
**Notes:** Matches existing release-host/runtime-confidence script patterns and avoids requiring real signing credentials in repo.

---

## macOS signing and notarization evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Separate checks for signing/runtime/notarization/stapling/Gatekeeper | Treat each macOS trust step as required evidence. | yes |
| Code signing only | Consider Developer ID signing enough for Phase 60. | |
| Host-specific commands only | Require macOS command execution even when the current host cannot produce macOS evidence. | |

**User's choice:** auto-selected separate macOS trust checks.
**Notes:** Phase 60 success criteria explicitly require Developer ID signing, hardened runtime, notarization, ticket stapling, and Gatekeeper evidence.

---

## Windows signing and trust path evidence

| Option | Description | Selected |
|--------|-------------|----------|
| Declared trust path plus timestamp/install trust evidence | Require explicit trust path, signing evidence, timestamping, and install trust/SmartScreen evidence. | yes |
| Hard-code one trust provider | Force Azure, Store, or EV/OV certificate path before the operator chooses. | |
| Signature-only pass | Accept signed artifact evidence without timestamp/install trust evidence. | |

**User's choice:** auto-selected declared trust path plus timestamp/install trust evidence.
**Notes:** Phase 59 inventory keeps Windows trust path configurable; Phase 60 should validate whichever selected path is declared.

---

## Operator-readable failure and audit output

| Option | Description | Selected |
|--------|-------------|----------|
| Planning evidence directory with blockers | Write `.planning/native-signing-runs/<timestamp>/summary.json` and `report.md` with stable blocker codes. | yes |
| Console-only output | Fail the command but leave no durable evidence artifact. | |
| Raw CI logs only | Depend on workflow logs instead of operator-readable reports. | |

**User's choice:** auto-selected durable planning evidence with blockers.
**Notes:** Mirrors `.planning/release-host-runs` and `.planning/runtime-confidence`.

---

## Release workflow integration boundary

| Option | Description | Selected |
|--------|-------------|----------|
| Focused script/test first, guarded release integration | Add a script and tests first; integrate into release pre-publication only when safe. | yes |
| Rewrite release automation | Replace current npm/GitHub release flow with native distribution flow. | |
| No release integration | Keep Phase 60 entirely disconnected from release gates. | |

**User's choice:** auto-selected focused script/test first.
**Notes:** Existing release jobs are already separated into verify and publish; Phase 60 should add a native signing gate without destabilizing publication.

---

## v2.9 regression protection

| Option | Description | Selected |
|--------|-------------|----------|
| Protect shipped capture/review baseline | Reference existing focused gates and only touch DRAFT/NATIVE/MSG/REVIEW if a gate fails. | yes |
| Reopen capture behavior | Change quick capture or board review semantics as part of distribution signing. | |
| Run Playwright by default | Treat `pnpm test:e2e` as default signing pipeline verification. | |

**User's choice:** auto-selected protect shipped capture/review baseline.
**Notes:** This follows Phase 59 and AGENTS guidance that Playwright E2E is separate from default verification.

## the agent's Discretion

- Exact manifest field names and report layout.
- Whether release workflow wiring is docs-only or a guarded workflow step in this phase.
- Whether implementation is a single script or small helper modules plus tests.

## Deferred Ideas

- Release channels and signed updater feed — Phase 61.
- Resident tray/menubar and global shortcut — Phase 62.
- Mobile/Web Push/APNs loop — Phase 63.
- Final distribution gate and v2.9 regression closure — Phase 64.
- Public store listing, marketing, reviewer accounts, marketplace, federation, autonomous Jarvis apply — outside v3.0 distribution readiness.
