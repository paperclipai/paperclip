---
phase: 63
slug: mobile-push-notification-loop
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 63 - Validation Strategy

> Per-phase validation contract for mobile push notification loop evidence.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `assert/strict` focused script |
| **Config file** | none |
| **Quick run command** | `pnpm run test:push-notification-gate` |
| **Full suite command** | `pnpm run test:push-notification-gate && pnpm typecheck` |
| **Estimated runtime** | ~90 seconds focused, typecheck host-dependent |

## Sampling Rate

- **After every task commit:** Run `pnpm run test:push-notification-gate` once the test script and implementation exist.
- **After every plan wave:** Run `pnpm run test:push-notification-gate && pnpm typecheck`.
- **Before verification:** Focused test and typecheck must be green, or residual host issues must be recorded honestly.
- **Max feedback latency:** 5 minutes.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 63-01-01 | 01 | 1 | PUSH-01, PUSH-02, PUSH-03 | T-63-01 / T-63-02 / T-63-03 | Push manifests fail closed on missing registration scope, raw secrets, unsafe payload content, invalid delivery/retry state, and missing click-through evidence. | unit/CLI | `pnpm run test:push-notification-gate` | Wave 0 complete | pending |
| 63-01-02 | 01 | 1 | PUSH-01, PUSH-02, PUSH-03 | T-63-01 / T-63-04 | Push notification gate writes operator-readable `summary.json` and `report.md` evidence. | unit/CLI | `pnpm run test:push-notification-gate` | Wave 0 complete | pending |
| 63-01-03 | 01 | 1 | PUSH-01, PUSH-02, PUSH-03 | T-63-05 | Operator docs expose exact command, manifest shape, output directory, provider vocabulary, minimal payload rule, click target rule, and Phase 64 handoff. | docs/static | `pnpm run test:push-notification-gate` plus doc diff inspection | Wave 0 complete | pending |

## Wave 0 Requirements

Existing Node script/test infrastructure covers all phase requirements.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Documentation is operator-readable and does not claim credentialed APNs/Web Push CI delivery | PUSH-01, PUSH-02, PUSH-03 | Static tests cannot fully judge operator clarity or scope wording. | Inspect `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` for Phase 63 command, manifest shape, provider rules, minimal payload rules, click evidence, and deferred provider-send wording. |
| Dirty working tree preservation | PUSH-03 | Git diff review is the safest guard because capture reliability files already have in-flight edits. | Inspect `git status --short` and stage/commit only Phase 63 files. |
| Planning truth sync is narrow | PUSH-01, PUSH-02, PUSH-03 | Direct state mutation is fallback-only because `gsd-sdk query` is unavailable. | Inspect `git diff -- .planning/REQUIREMENTS.md .planning/ROADMAP.md .planning/STATE.md .planning/PROJECT.md .planning/MILESTONES.md` before commit if closing the phase. |

## Validation Sign-Off

- [x] All tasks have automated verification or manual review steps.
- [x] Sampling continuity: focused test after implementation, typecheck before close.
- [x] No watch-mode flags.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-05-01
