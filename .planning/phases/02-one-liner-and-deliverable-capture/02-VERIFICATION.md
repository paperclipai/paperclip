---
status: complete
phase: 02-one-liner-and-deliverable-capture
updated: 2026-04-24
---

# Phase 2 Verification - One-Liner and Deliverable Capture

## Result

Phase 2 scope and all planned Windows gap-closure work are complete.

- One-Liner and deliverable capture must-haves are implemented.
- The original Windows reseed `EBUSY` gap is closed.
- Windows symlink/materialization failures are covered by junction or copy fallbacks.
- Slow full-suite runtime/worktree tests now have bounded Windows-safe timeouts.
- Full monorepo verification passes.
- Production build passes.

## Verified Must-Haves

1. One-Liner parses freeform input into a structured draft instead of bouncing back to the legacy issue dialog.
2. RT2 deliverables require `basePrice` across shared contracts, server persistence, and UI submission.
3. Global work-entry affordances route into `/:companyPrefix/one-liner`.
4. The remaining legacy RT2 dialog path no longer submits deliverable-aware work without base-price input.

## Gap Closure

Closed:

- `cli/src/__tests__/worktree.test.ts`
  - fixed Windows reseed cleanup and timing sensitivity.
- `server/src/__tests__/workspace-runtime.test.ts`
  - full-suite Windows runtime/worktree provisioning now passes.
- `server/src/__tests__/codex-local-skill-injection.test.ts`
  - Windows skill symlink repair now uses the materialization helper.
- `server/src/__tests__/cursor-local-skill-injection.test.ts`
  - test symlink setup is Windows-safe.
- `server/src/__tests__/dev-watch-ignore.test.ts`
  - directory symlinks use Windows junctions.
- `server/src/__tests__/heartbeat-comment-wake-batching.test.ts`
  - embedded Postgres temp directory cleanup retries on transient Windows locks.
- `server/src/__tests__/feedback-service.test.ts`
  - embedded Postgres temp directory cleanup retries on transient Windows locks.
- `server/src/__tests__/forbidden-tokens.test.ts`
  - script logic imports from a side-effect-free library module.
- `packages/db/src/client.test.ts`
- `packages/db/src/rt2-daily-report-persistence.test.ts`
- `server/src/__tests__/issues-service.test.ts`
- `server/src/__tests__/workspace-runtime-service-authz.test.ts`
- `server/src/__tests__/opencode-local-adapter-environment.test.ts`
  - embedded Postgres or adapter diagnostics timeouts are sized for Windows full-suite contention.

## Verification Run

Passed:

```sh
pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts --testTimeout=30000
pnpm exec vitest run cli/src/__tests__/worktree.test.ts --testTimeout=30000
pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts cli/src/__tests__/worktree.test.ts --testTimeout=30000
pnpm exec vitest run server/src/__tests__/codex-local-skill-injection.test.ts server/src/__tests__/cursor-local-skill-injection.test.ts server/src/__tests__/dev-watch-ignore.test.ts --testTimeout=30000
pnpm exec vitest run packages/db/src/client.test.ts packages/db/src/rt2-daily-report-persistence.test.ts server/src/__tests__/workspace-runtime-service-authz.test.ts server/src/__tests__/opencode-local-adapter-environment.test.ts --testTimeout=60000
pnpm exec vitest run server/src/__tests__/forbidden-tokens.test.ts
pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts server/src/__tests__/issues-service.test.ts server/src/__tests__/heartbeat-comment-wake-batching.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

Final full-suite result:

- `pnpm -r typecheck`: passed
- `pnpm test:run`: 277 test files passed, 1535 tests passed, 1 skipped
- `pnpm build`: passed

Note: Vitest and full build commands were run outside the Codex filesystem sandbox on this Windows machine because test/build process spawning hits sandbox `EPERM` in this environment.

## Score

- Must-haves verified: 4/4
- Verification gates passed: 3/3
- Overall status: complete

