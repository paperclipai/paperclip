# Phase 71 Research - v3.1 DevPlan Acceptance Gate

**Generated:** 2026-05-01T16:12:00+09:00
**Mode:** auto chain

## Current Assets

- `scripts/rt2-devplan-alignment-gate.mjs` already owns the v3.1 score matrix, 64% baseline, complete-claim evidence validation, engine parity overclaim blocking, and generated `.planning/devplan-alignment-runs/<timestamp>/summary.json` plus `report.md`.
- `scripts/rt2-devplan-alignment-gate.test.mjs` already tests baseline/current score, unsupported complete claims, and engine parity overclaims.
- `scripts/rt2-identity-gate.mjs` and `scripts/rt2-identity-gate.test.mjs` already provide the RealTycoon2 identity scan slice.
- `scripts/rt2-distribution-gate.mjs` is the best local pattern for final-gate summary/report output and stable blocker codes.
- `scripts/rt2-runtime-confidence.mjs` is the best local pattern for separating blockers, accepted debt, and future scope in an operator-readable report.
- Package scripts already expose `rt2:devplan-alignment-gate`, `test:devplan-alignment-gate`, `rt2:identity-gate`, and `test:identity-gate`.
- Phase 70 is committed, but the current worktree still contains dirty/untracked Phase 69 graph/corpus evidence paths. Phase 71 must report this state instead of silently closing the milestone.

## Smallest Safe Implementation

1. Add `scripts/rt2-v31-acceptance-gate.mjs`.
   - Run or evaluate focused checks.
   - Invoke the DevPlan alignment gate and consume its summary.
   - Report `baselineScorePct`, `currentScorePct`, and `scoreDeltaPct`.
   - Validate required evidence path existence.
   - Surface dirty/untracked prior-phase evidence anchors as blockers.
   - Write `.planning/v31-acceptance-runs/<timestamp>/summary.json` and `report.md`.
2. Add `scripts/rt2-v31-acceptance-gate.test.mjs`.
   - Test passing summary with injected command results.
   - Test failed focused check blocker.
   - Test non-positive score delta blocker.
   - Test dirty prior evidence anchor blocker.
   - Test output writing.
3. Add package scripts:
   - `rt2:v31-acceptance-gate`
   - `test:v31-acceptance-gate`
4. Update `scripts/rt2-devplan-alignment-gate.mjs` so `v31-acceptance-gate` becomes complete with Phase 71 evidence anchors.
5. Update the alignment gate test expectations to 100% current score and 10 complete rows.
6. Run focused script tests, then run the gate. If dirty Phase 69 evidence remains, the acceptance gate should block and the final report should say why.

## Verification Targets

- `node scripts/rt2-v31-acceptance-gate.test.mjs`
- `node scripts/rt2-devplan-alignment-gate.test.mjs`
- `pnpm run test:v31-acceptance-gate`
- `pnpm run rt2:v31-acceptance-gate`
- If the gate is not blocked by dirty prior evidence, follow with `pnpm typecheck && pnpm test`.

## Deferred

- Do not add `pnpm test:e2e` to default acceptance.
- Do not implement new product features.
- Do not clean, revert, or commit unrelated Phase 69 dirty work as part of Phase 71.
