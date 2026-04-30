---
phase: 60
slug: signing-and-notarization-pipeline
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 60 - Validation Strategy

> Per-phase validation contract for feedback sampling during execution.

---

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node assertion scripts + TypeScript typecheck |
| **Config file** | none |
| **Quick run command** | `pnpm run test:native-signing-gate` |
| **Full suite command** | `pnpm run test:native-signing-gate && pnpm typecheck` |
| **Estimated runtime** | ~60-180 seconds |

---

## Sampling Rate

- **After every task commit:** Run `pnpm run test:native-signing-gate`
- **After every plan wave:** Run `pnpm run test:native-signing-gate && pnpm typecheck`
- **Before `$gsd-verify-work`:** Full suite must be green or caveat recorded
- **Max feedback latency:** 180 seconds

---

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 60-01-01 | 01 | 1 | DIST-02, DIST-03 | T-60-01 / T-60-02 | Missing or failed signing evidence blocks release. | unit/script | `pnpm run test:native-signing-gate` | yes | pending |
| 60-01-02 | 01 | 1 | DIST-02, DIST-03 | T-60-03 | Secret values are rejected/redacted. | unit/script | `pnpm run test:native-signing-gate` | yes | pending |
| 60-01-03 | 01 | 1 | DIST-02, DIST-03 | T-60-04 | Operator docs describe required evidence without credentials. | docs/script | `pnpm run test:native-signing-gate && pnpm typecheck` | yes | pending |

*Status: pending until execution writes the script/tests and runs commands.*

---

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

---

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Real Apple notarization submission | DIST-02 | Requires Apple Developer credentials and macOS artifact. | Confirm manifest fields and docs identify required command/evidence; do not fake pass locally. |
| Real Windows SmartScreen reputation | DIST-03 | Depends on production trust path and download/install reputation. | Confirm gate records install trust/SmartScreen evidence as required or blocking. |

---

## Validation Sign-Off

- [x] All tasks have automated verify or explicit manual-only rationale
- [x] Sampling continuity: no 3 consecutive tasks without automated verify
- [x] Wave 0 covers all missing references
- [x] No watch-mode flags
- [x] Feedback latency target < 180s
- [x] `nyquist_compliant: true` set in frontmatter

**Approval:** approved 2026-04-30
