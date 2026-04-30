# Phase 64: v3.0 Distribution Gate and Capture Regression Closure - Research

**Date:** 2026-05-01
**Status:** Complete

## Research Question

What do we need to know to plan Phase 64 well?

Phase 64 should close `DIST-06` by proving that v3.0 distribution readiness is gated by all native distribution evidence and that v2.9 capture reliability has not regressed.

## Findings

### Existing gate pattern

The prior v3.0 phases established a consistent implementation pattern:

- `scripts/rt2-native-signing-gate.mjs` validates Phase 60 signing/trust evidence and writes `.planning/native-signing-runs/<timestamp>/summary.json` plus `report.md`.
- `scripts/rt2-release-channel-gate.mjs` validates Phase 61 release channel and signed updater metadata and writes `.planning/native-updater-runs/<timestamp>/summary.json` plus `report.md`.
- `scripts/rt2-resident-surface-gate.mjs` validates Phase 62 tray/global shortcut readiness and writes `.planning/native-resident-runs/<timestamp>/summary.json` plus `report.md`.
- `scripts/rt2-push-notification-gate.mjs` validates Phase 63 push readiness and writes `.planning/native-push-runs/<timestamp>/summary.json` plus `report.md`.

Each script is dependency-light, deterministic, manifest-driven, fail-closed, and covered by a focused direct Node assertion test. Phase 64 should reuse this pattern rather than introducing native dependencies or a new runner framework.

### Summary fields Phase 64 can consume

The Phase 60-63 summaries have stable common fields:

- `version`
- `generatedAt`
- `status`
- `manifestPath`
- `runDir`
- `counts.blockers`
- `blockers`
- `passed`

The Phase 61 and 62 summaries also expose `installed` and `updateState`, which are useful for release identity alignment and stale-updater checks. The Phase 63 summary exposes push-specific arrays and `captureReliability`.

### Final gate contract

The final gate should validate a new Phase 64 manifest that declares:

- Target release identity: channel, version, build ID, generated time, and max freshness age.
- Summary refs: signing, updater, resident, and push summary paths.
- Regression evidence: focused v2.9 capture test and identity/typecheck command records.

This keeps the final gate deterministic. It validates evidence records instead of running the full suite internally.

### v2.9 regression evidence

Phase 59 and Phase 58 already define the focused regression bundle:

- `packages/shared/src/rt2-task.test.ts`
- `server/src/__tests__/rt2-task-routes.test.ts`
- `ui/src/lib/rt2-quick-capture-queue.test.ts`
- `ui/src/pages/rt2/QuickCapturePage.test.tsx`
- `ui/src/components/Rt2DailyBoard.test.tsx`
- `pnpm run test:identity-gate`
- `pnpm run rt2:identity-gate`
- `pnpm typecheck`

The final gate can require command records for these checks, while the phase execution still runs the actual commands and records results in `64-VERIFICATION.md`.

### Documentation and planning truth

`doc/NATIVE-DISTRIBUTION-FOUNDATION.md` and `doc/RELEASE-HOST-VERIFICATION.md` are the right operator docs to extend. They already describe Phase 60-63 manifest shapes and commands.

After implementation passes, Phase 64 should create:

- `64-VERIFICATION.md`
- `64-01-SUMMARY.md`

Then reconcile:

- `.planning/REQUIREMENTS.md`
- `.planning/ROADMAP.md`
- `.planning/STATE.md`
- `.planning/PROJECT.md`
- `.planning/MILESTONES.md`

Because `gsd-sdk query` is unavailable in this environment, planning truth edits must stay narrow and auditable.

## Risks and Mitigations

| Risk | Mitigation |
|------|------------|
| Final gate gives a false green from stale or mismatched summaries | Require release identity alignment and max age checks against `generatedAt` and `updateState.checkedAt`. |
| Upstream failures are hidden by aggregation | Propagate upstream blockers into final blocker records with source paths. |
| Regression evidence is incomplete | Require all focused command IDs and `status: passed` records. |
| Secrets leak into final manifest or report | Reuse Phase 60-63 secret scanning approach and fail closed on sensitive raw fields. |
| Planning docs mark v3.0 complete before evidence passes | Update planning truth only after focused tests, final gate tests, and typecheck pass. |

## Recommended Plan

1. Add focused tests for a final distribution gate covering pass, missing summaries, blocked summaries, updater staleness, channel/build mismatch, regression failures, and raw secret rejection.
2. Implement `scripts/rt2-distribution-gate.mjs` with summary consumption, release identity alignment, freshness checks, regression evidence validation, secret hygiene, and summary/report output.
3. Add package scripts and operator docs.
4. Run focused verification, create Phase 64 verification/summary artifacts, then reconcile planning truth.

## Validation Architecture

Phase 64 validation should be TDD-oriented:

- First run `node scripts/rt2-distribution-gate.test.mjs` and observe failure because the script does not exist.
- Implement until `node scripts/rt2-distribution-gate.test.mjs` and `pnpm run test:distribution-gate` pass.
- Run focused v2.9 regression commands and `pnpm typecheck`.
- Attempt `pnpm test` if feasible and record any unrelated host/timeouts honestly.
- Do not run `pnpm test:e2e` by default.

## RESEARCH COMPLETE
