---
phase: 02-one-liner-and-deliverable-capture
plan: 05
subsystem: adapter execution verification
tags:
  - windows
  - adapters
  - materialization
  - verification-gap
requires:
  - 04-SUMMARY.md
provides:
  - Windows-safe adapter materialization use-sites
  - Windows-safe temp command launch for local adapter execute tests
affects:
  - packages/adapter-utils/src/server-utils.ts
  - packages/adapters/codex-local/src/server/codex-home.ts
  - packages/adapters/cursor-local/src/server/execute.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/cursor-local-execute.test.ts
requirements-completed:
  - LOG-01
  - LOG-02
  - ECON-01
completed: 2026-04-24
---

# Phase 2 Plan 05: Adapter Materialization and Temp Command Launch Summary

## Summary

Plan 05 stabilized local adapter execute tests on Windows by routing Codex auth/config and Cursor skill setup through the Plan 04 materialization helper, and by making the shared child-process launcher handle extensionless Node scripts used as test-owned adapter commands.

No One-Liner, deliverable, base-price, or RT2 product behavior was changed.

## Changes

- `packages/adapter-utils/src/server-utils.ts`
  - Added Windows-safe detection for extensionless Node scripts so temp adapter commands run through `process.execPath`.
  - Included extensionless PATH candidates before PATHEXT candidates on Windows.
  - Hardened `materializePath` with absolute source/destination paths and fallback for Windows link failures beyond `EPERM`.
- `packages/adapters/codex-local/src/server/codex-home.ts`
  - Replaced direct auth/config symlink creation with `materializePath`.
- `packages/adapters/cursor-local/src/server/execute.ts`
  - Removed direct `fs.symlink` as the default skill injection path.
  - Made Cursor skill home honor an explicit `HOME` before falling back to `os.homedir()`, which keeps tests isolated.
- `server/src/__tests__/codex-local-execute.test.ts`
  - Updated assertions to verify materialized content and installed skill availability rather than symlink-only behavior.
- `server/src/__tests__/cursor-local-execute.test.ts`
  - Updated runtime skill assertion to verify materialized skill contents.
- `packages/adapter-utils/src/server-utils.test.ts`
  - Added coverage for extensionless Node temp commands.

## Verification

- `pnpm exec vitest run server/src/__tests__/codex-local-execute.test.ts --testTimeout=10000`
  - Passed: 1 file, 9 tests.
- `pnpm exec vitest run server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts --testTimeout=10000`
  - Passed: 4 files, 15 tests.
- `pnpm exec vitest run server/src/__tests__/codex-local-execute.test.ts server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts --testTimeout=10000`
  - Passed: 5 files, 24 tests.
- `pnpm exec vitest run --config server/vitest.config.ts packages/adapter-utils/src/server-utils.test.ts --testTimeout=10000`
  - Passed: 2 files, 7 tests, 2 skipped.
  - Note: the existing server Vitest config also picked up `.claude/worktrees/m1-5-graphify/packages/adapter-utils/src/server-utils.test.ts`.
- `pnpm --filter @paperclipai/adapter-utils typecheck`
  - Passed.

## Deviations from Plan

- The common temp-command launch fix landed in `packages/adapter-utils/src/server-utils.ts`, although the plan's `files_modified` list focused on adapter execute files. This is the shared launch path used by the affected adapters and is the smallest stable fix.
- `packages/adapter-utils/src/server-utils.test.ts` was updated to cover the shared launch behavior.
- An initial Cursor test run created a temporary `ascii-heart` junction in the real Cursor skills home before the `HOME` handling fix. It was removed during cleanup.

## Issues Encountered

None remaining for Plan 05.

## Self-Check: PASSED

The Plan 05 execute suites now pass on Windows-targeted runs. Plan 06 can proceed to diagnostics branch classification.
