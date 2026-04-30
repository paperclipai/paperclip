---
phase: 61
slug: release-channels-and-signed-updater
status: draft
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 61 - Validation Strategy

> Per-phase validation contract for release channel and signed updater evidence.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `assert/strict` focused script |
| **Config file** | none |
| **Quick run command** | `pnpm run test:release-channel-gate` |
| **Full suite command** | `pnpm run test:release-channel-gate && pnpm typecheck` |
| **Estimated runtime** | ~90 seconds focused, typecheck host-dependent |

## Sampling Rate

- **After every task commit:** Run `pnpm run test:release-channel-gate` once the test script and implementation exist.
- **After every plan wave:** Run `pnpm run test:release-channel-gate && pnpm typecheck`.
- **Before verification:** Focused test and typecheck must be green, or residual host issues must be recorded honestly.
- **Max feedback latency:** 5 minutes.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 61-01-01 | 01 | 1 | DIST-04, DIST-05 | T-61-01 / T-61-02 / T-61-03 | Channel/updater manifests fail closed on missing metadata, blocked signing prerequisites, and raw private key material. | unit/CLI | `pnpm run test:release-channel-gate` | Wave 0 complete | pending |
| 61-01-02 | 01 | 1 | DIST-04, DIST-05 | T-61-01 / T-61-04 | Operator docs expose exact command, manifest shape, output directory, and rollback policy. | docs/static | `pnpm run test:release-channel-gate` plus doc diff inspection | Wave 0 complete | pending |
| 61-01-03 | 01 | 1 | DIST-04, DIST-05 | T-61-05 | Planning truth marks requirements complete only after verification evidence exists. | artifact review | `pnpm typecheck` plus planning diff inspection | Wave 0 complete | pending |

## Wave 0 Requirements

Existing infrastructure covers all phase requirements.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Documentation is operator-readable and secret-free | DIST-04, DIST-05 | Static tests cannot fully judge operator clarity. | Inspect `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` for raw private key/password/token values and confirm command examples are runnable. |
| Planning truth sync is narrow | DIST-04, DIST-05 | Git diff review is the safest guard with dirty worktree. | Inspect `git diff -- .planning/REQUIREMENTS.md .planning/ROADMAP.md .planning/STATE.md .planning/PROJECT.md .planning/MILESTONES.md` before commit. |

## Validation Sign-Off

- [x] All tasks have automated verification or manual review steps.
- [x] Sampling continuity: focused test after implementation, typecheck before close.
- [x] No watch-mode flags.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** pending
