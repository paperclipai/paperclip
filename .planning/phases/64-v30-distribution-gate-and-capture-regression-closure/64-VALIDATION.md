---
phase: 64
slug: v30-distribution-gate-and-capture-regression-closure
status: approved
nyquist_compliant: true
wave_0_complete: true
created: 2026-05-01
---

# Phase 64 - Validation Strategy

> Per-phase validation contract for v3.0 distribution gate and capture regression closure.

## Test Infrastructure

| Property | Value |
|----------|-------|
| **Framework** | Node `assert/strict` focused script |
| **Config file** | none |
| **Quick run command** | `pnpm run test:distribution-gate` |
| **Full suite command** | `pnpm run test:distribution-gate && pnpm typecheck && pnpm test` |
| **Estimated runtime** | ~90 seconds focused, typecheck/test host-dependent |

## Sampling Rate

- **After TDD test creation:** Run `node scripts/rt2-distribution-gate.test.mjs` and expect failure until the implementation exists.
- **After implementation:** Run `pnpm run test:distribution-gate`.
- **Before closure:** Run focused v2.9 regression commands and `pnpm typecheck`.
- **Before final report:** Run `pnpm test` if feasible and record exact result.
- **Max feedback latency:** 5 minutes for focused gate work; broad test may exceed this and should be reported honestly.

## Per-Task Verification Map

| Task ID | Plan | Wave | Requirement | Threat Ref | Secure Behavior | Test Type | Automated Command | File Exists | Status |
|---------|------|------|-------------|------------|-----------------|-----------|-------------------|-------------|--------|
| 64-01-01 | 01 | 1 | DIST-06 | T-64-01 / T-64-02 / T-64-03 | Final gate fails closed on missing/blocked/stale/mismatched summaries, failed regression evidence, and raw secrets. | unit/CLI | `pnpm run test:distribution-gate` | Wave 0 complete | pending |
| 64-01-02 | 01 | 1 | DIST-06 | T-64-01 / T-64-02 | Final gate writes `summary.json` and `report.md` under `.planning/native-distribution-gate-runs/`. | unit/CLI | `pnpm run test:distribution-gate` | Wave 0 complete | pending |
| 64-01-03 | 01 | 1 | DIST-06 | T-64-04 | Focused v2.9 regression evidence and typecheck pass before distribution readiness is marked green. | regression/typecheck | focused Vitest commands plus `pnpm typecheck` | Wave 0 complete | pending |
| 64-01-04 | 01 | 1 | DIST-06 | T-64-04 | Planning truth updates are narrow and happen only after verification. | docs/static | planning doc diff inspection | Wave 0 complete | pending |

## Wave 0 Requirements

Existing Phase 60-63 gate scripts, package scripts, and docs exist and can be consumed by the final gate.

## Manual-Only Verifications

| Behavior | Requirement | Why Manual | Test Instructions |
|----------|-------------|------------|-------------------|
| Operator docs clearly explain the final gate without implying real credentialed signing/provider sends | DIST-06 | Static tests cannot fully judge operator clarity. | Inspect `doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` for Phase 64 command, manifest, output directory, freshness, blocker taxonomy, and deferred scope wording. |
| Dirty working tree preservation | DIST-06 | The repo has unrelated in-flight changes; only Phase 64 files should be staged. | Inspect `git status --short` and stage/commit only Phase 64 files. |
| Planning truth sync is narrow | DIST-06 | `gsd-sdk query` is unavailable, so direct edits are fallback-only. | Inspect `git diff -- .planning/REQUIREMENTS.md .planning/ROADMAP.md .planning/STATE.md .planning/PROJECT.md .planning/MILESTONES.md` before commit. |

## Validation Sign-Off

- [x] All tasks have automated verification or manual review steps.
- [x] Sampling continuity: focused gate test after implementation, focused v2.9 regression and typecheck before close.
- [x] No watch-mode flags.
- [x] `nyquist_compliant: true` set in frontmatter.

**Approval:** approved 2026-05-01
