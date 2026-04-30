---
phase: 51-one-liner-to-board-capture-flow
plan: 01
subsystem: shared-capture-contract
status: complete
key-files:
  - packages/shared/src/types/rt2-task.ts
  - packages/shared/src/validators/rt2-task.ts
  - packages/shared/src/rt2-task.test.ts
  - ui/src/api/rt2-tasks.ts
---

# Phase 51 Plan 01 Summary

## Completed

- Added `web`, `floating`, and `voice` to the shared RT2 capture draft source contract.
- Updated UI API source typing to match the shared contract.
- Extended shared capture validator tests to cover web/floating/voice plus existing inbound sources.

## Verification

- `pnpm exec vitest run packages/shared/src/rt2-task.test.ts` - passed.
- `pnpm typecheck` - passed in final run.

## Self-Check

PASSED.
