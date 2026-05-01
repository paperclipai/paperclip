# Phase 65: DevPlan Truth and Identity Cleanup - Research

## RESEARCH COMPLETE

## Goal

Plan Phase 65 so it can turn the v3.1 64% DevPlan baseline into concrete evidence and remove product-facing identity ambiguity without attempting a risky internal package rebrand.

## Findings

### Existing Assets

- `scripts/rt2-identity-gate.mjs` already implements a focused RealTycoon2 identity scanner with file/line/category output and direct Node tests.
- `scripts/rt2-distribution-gate.mjs`, `scripts/rt2-runtime-confidence.mjs`, and `scripts/rt2-milestone-artifact-gate.mjs` establish the local pattern for deterministic evidence gates: validate structured inputs, emit stable blocker codes, write `summary.json` and `report.md`, and expose a package script.
- `ui/src/pages/rt2/PlanAlignmentPage.tsx` already gives operators a single UI surface for development-plan alignment, but its labels and data are stale relative to the v3.1 64% baseline.
- `.planning/DEVPLAN-ALIGNMENT.md` is useful historical input, but it contains older 81%/94% claims and must not be the current truth source without recalculation.
- `.planning/research/ENGINE-REFERENCE-AUDIT.md` gives the key distinction for v3.1: RT2 product graph/runtime concepts are not yet Graphify v3 or Multica parity.

### Recommended Implementation

1. Add `scripts/rt2-devplan-alignment-gate.mjs`.
   - Encode the v3.1 baseline as a row-level matrix.
   - Validate that `complete` rows have evidence.
   - Validate that engine parity `complete` rows have reference-specific evidence.
   - Compute the current conservative score from row weights.
   - Write `.planning/devplan-alignment-runs/<timestamp>/summary.json` and `report.md`.

2. Extend `scripts/rt2-identity-gate.mjs`.
   - Keep the focused target model.
   - Add surface categories for product docs and server-facing operator copy.
   - Preserve allowed compatibility/internal uses.
   - Add tests for docs/server-facing failures and compatibility-boundary allowance.

3. Update product-facing truth surfaces.
   - Update `ui/src/pages/rt2/PlanAlignmentPage.tsx` to show v3.1 conservative status labels and 64% baseline.
   - Document RealTycoon2 product identity vs Paperclip compatibility/reference layer.
   - Adjust narrow server-facing copy where it visibly brands an operator-facing output as Paperclip.

4. Verify and close Phase 65.
   - Add package scripts for the new gate.
   - Run focused script tests, identity gate tests, identity scan, DevPlan alignment gate, and typecheck.
   - Create `65-VERIFICATION.md` and `65-01-SUMMARY.md`.
   - Update planning truth only after focused evidence passes.

## Validation Architecture

Phase 65 is script-heavy and can be validated with direct Node assertion tests plus typecheck.

Required automated commands:

- `node scripts/rt2-devplan-alignment-gate.test.mjs`
- `pnpm run test:devplan-alignment-gate`
- `pnpm run test:identity-gate`
- `pnpm run rt2:identity-gate`
- `pnpm run rt2:devplan-alignment-gate`
- `pnpm typecheck`

`pnpm test:e2e` is not part of the default validation set.

## Risks

- A repo-wide identity ban would break legitimate compatibility code. Mitigation: keep focused targets and compatibility-boundary tests.
- A new alignment score can look more precise than it is. Mitigation: expose row weights and conservative statuses in `summary.json` and report.
- UI copy could imply final v3.1 acceptance before Phases 66-70 execute. Mitigation: make `PlanAlignmentPage` say Phase 65 is the baseline, and Phase 71 owns final delta.

