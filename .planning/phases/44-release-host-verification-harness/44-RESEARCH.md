# Phase 44: Release Host Verification Harness - Research

**Researched:** 2026-04-29
**Status:** Ready for planning

## Findings

### Existing verification path

- `package.json` maps `pnpm test` to `pnpm run test:run`, which calls `scripts/run-vitest-stable.mjs`.
- `scripts/run-vitest-stable.mjs` already splits the workspace into stable slices:
  - non-server Vitest projects
  - server project excluding serialized route/authz tests
  - each serialized route/authz test as its own invocation
- The stable runner exits on first failing slice and does not preserve structured evidence. Phase 44 should keep its slice model but add durable evidence, timeout classification, and rerun selection.

### Existing script pattern

- `scripts/rt2-milestone-artifact-gate.mjs` is the closest local pattern:
  - small Node `.mjs` CLI
  - deterministic text output
  - `--json` output
  - exported pure function for fixture tests
- `scripts/rt2-milestone-artifact-gate.test.mjs` verifies behavior through temp fixtures rather than invoking the whole repo.

### Release-host harness approach

- Implement a repo-local script `scripts/rt2-release-host-verify.mjs`.
- Expose package scripts:
  - `pnpm run rt2:release-host-verify`
  - `pnpm run rt2:release-host-rerun -- <summary.json>`
  - `pnpm run test:release-host-verify`
- Write evidence to `.planning/release-host-runs/<timestamp>/summary.json`, `report.md`, and per-slice log files.
- Rerun should load prior `summary.json`, select latest failed/timed-out slices, append attempts, and rewrite the same summary/report.

## Validation Architecture

- Unit/fixture tests should cover:
  - owner classification
  - failed/timed-out latest slice selection
  - timeout result creation
  - JSON/report persistence shape
- Phase verification should run:
  - `pnpm run test:release-host-verify`
  - `pnpm typecheck`
  - a short fixture invocation of the release-host script
  - full `pnpm test` when feasible, recorded through the new harness if it times out

## Risks

- Running the full release-host harness may take longer than the current command timeout on Windows. The harness must classify that as evidence rather than hide it.
- `scripts/run-vitest-stable.mjs` duplicates suite enumeration internally. If Phase 44 mirrors it, future changes could drift. Keep the copied constants visibly aligned and covered by tests where practical.

## RESEARCH COMPLETE
