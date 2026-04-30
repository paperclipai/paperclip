---
phase: 62
slug: resident-tray-and-global-shortcut
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-04-30
---

# Phase 62 - Validation Strategy

> Per-phase validation contract for resident tray and global shortcut evidence.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `assert/strict` focused script |
| **Config file** | none |
| **Quick run command** | `pnpm run test:resident-surface-gate` |
| **Full suite command** | `pnpm run test:resident-surface-gate && pnpm typecheck` |
| **Estimated runtime** | ~90 seconds focused, typecheck host-dependent |

## Sampling Rate

- **After every task commit:** Run `pnpm run test:resident-surface-gate` once the test script and implementation exist.
- **After every plan wave:** Run `pnpm run test:resident-surface-gate && pnpm typecheck`.
- **Before verification:** Focused test and typecheck must be green, or residual host issues must be recorded honestly.
- **Max feedback latency:** 5 minutes.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 62-01-01 | 01 | 1 | RES-01, RES-02, RES-03 | T-62-01 / T-62-02 / T-62-03 | Resident manifests fail closed on missing tray status, shortcut lifecycle, unsafe privacy behavior, and bypassed draft review handoff. | unit/CLI | `pnpm run test:resident-surface-gate` | Wave 0 complete | pending |
| 62-01-02 | 01 | 1 | RES-01, RES-02, RES-03 | T-62-01 / T-62-04 | Resident surface gate writes operator-readable `summary.json` and `report.md` evidence. | unit/CLI | `pnpm run test:resident-surface-gate` | Wave 0 complete | pending |
| 62-01-03 | 01 | 1 | RES-01, RES-02, RES-03 | T-62-05 | Operator docs expose exact command, manifest shape, output directory, privacy boundary, and Phase 64 handoff. | docs/static | `pnpm run test:resident-surface-gate` plus doc diff inspection | Wave 0 complete | pending |

## Wave 0 Requirements

Existing Node script/test infrastructure covers all phase requirements.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Documentation is operator-readable and does not claim a shipped native scaffold | RES-01, RES-02, RES-03 | Static tests cannot fully judge operator clarity or scope wording. | Inspect `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` for Phase 62 command, manifest shape, privacy rules, and deferred Tauri scaffold wording. |
| Planning truth sync is narrow | RES-01, RES-02, RES-03 | Git diff review is the safest guard with a dirty worktree. | Inspect `git diff -- .planning/REQUIREMENTS.md .planning/ROADMAP.md .planning/STATE.md .planning/PROJECT.md .planning/MILESTONES.md` before commit. |

## Validation Sign-Off

- [x] All tasks have automated verification or manual review steps.
- [x] Sampling continuity: focused test after implementation, typecheck before close.
- [x] No watch-mode flags.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-04-30
