# Log Rotation And Retention Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add built-in file log rotation and retention for the local `server.log` so long-running Orchestrero instances do not grow a single unbounded log file.

**Architecture:** Keep file logging as the default, but replace the current single append-only file target with an app-managed rotating file target. Expose rotation controls in config, apply safe defaults for local installs, and keep the first rollout scoped to rotation/retention only. Do not bundle request-noise reduction into the same change.

**Tech Stack:** Node.js file streams, `pino`, `pino-http`, `pino-pretty`, shared Zod config schema, CLI config prompts, Vitest.

---

## Scope Decision

### Recommended approach

Implement **built-in app-managed rotation** for `logging.mode === "file"` and make it configurable in the Paperclip config.

Why this is the right first step:

- It works for the default local install path, not just Linux systems with `logrotate`.
- It keeps behavior inside the repo’s config and onboarding flow instead of requiring host-level setup.
- It directly addresses the observed failure mode: one huge `server.log` file under `~/.paperclip/instances/default/logs/`.

### Explicitly not in scope for this plan

- Reducing request log volume (`/api/health`, dev polling, etc.)
- Log shipping / cloud logging
- Plugin log retention
- Backup retention changes

Those are real follow-ups, but bundling them here would make root-cause verification harder.

## File Map

**Modify:**

- `packages/shared/src/config-schema.ts`
  Add logging rotation config to the shared config contract and defaults.
- `server/src/middleware/logger.ts`
  Replace the direct `destination: logFile` file target with a rotation-aware target.
- `cli/src/prompts/logging.ts`
  Surface rotation settings in interactive logging setup.
- `cli/src/commands/onboard.ts`
  Seed sane rotation defaults for new instances.
- `cli/src/commands/configure.ts`
  Ensure repaired/default config includes rotation defaults.
- `doc/DEVELOPING.md`
  Document rotation behavior, defaults, and where rotated files live.

**Create:**

- `server/src/logging/rotating-pretty-target.ts`
  Custom file target for pretty-printed server logs that handles rotation and retention.
- `server/src/logging/file-rotation.ts`
  Shared helpers for naming rotated files, pruning expired files, and performing startup rotation checks.
- `server/src/__tests__/logger-rotation.test.ts`
  Regression tests for rotation behavior and retention.

**Possibly modify for typed fixture updates (only if tests fail after schema expansion):**

- `cli/src/__tests__/onboard.test.ts`
- `cli/src/__tests__/doctor.test.ts`
- `cli/src/__tests__/allowed-hostname.test.ts`
- `cli/src/__tests__/worktree.test.ts`
- `cli/src/__tests__/telemetry.test.ts`
- `cli/src/__tests__/routines.test.ts`
- `cli/src/__tests__/company-import-export-e2e.test.ts`
- `server/src/__tests__/worktree-config.test.ts`

## Config Design

Add a nested rotation object under logging:

```ts
logging: {
  mode: "file" | "cloud";
  logDir: string;
  rotation: {
    enabled: boolean;      // default true
    maxFileSizeMb: number; // default 100
    maxFiles: number;      // default 10
  };
}
```

Rationale:

- `enabled` gives operators a fast escape hatch.
- `maxFileSizeMb` directly prevents another multi-GB single-file failure.
- `maxFiles` gives a bounded disk ceiling without introducing date math or compression in v1.
- Keep the schema small. Do not add compression, daily rotation, age-based pruning, or per-level routing yet.

Expected default footprint with `100 MB x 10 files`: about `1 GB` max for server log retention.

## Rotation Behavior

### File naming

Keep the active file as:

- `server.log`

Rotate old files to:

- `server.log.YYYYMMDD-HHMMSS`

This is simple, sortable, and stays adjacent to the active file.

### Rotation triggers

Rotate when either condition is true:

1. On startup, if existing `server.log` already exceeds `maxFileSizeMb`
2. During runtime, before appending a new log chunk that would push the active file over the threshold

### Retention

After each successful rotation:

- prune oldest rotated files until only `maxFiles - 1` rotated files remain
- keep the active `server.log` outside that rotated-file count

### Failure behavior

If rotation/pruning fails:

- continue logging to the active file if possible
- emit a warning to stdout/stderr
- do not crash server startup just because pruning failed

## Task 1: Add Config Surface

**Files:**

- Modify: `packages/shared/src/config-schema.ts`
- Modify: `cli/src/prompts/logging.ts`
- Modify: `cli/src/commands/onboard.ts`
- Modify: `cli/src/commands/configure.ts`

- [ ] Add `logging.rotation` to the shared config schema with safe defaults.
- [ ] Export the inferred type changes through the existing shared config exports.
- [ ] Update onboarding defaults so new configs include rotation settings.
- [ ] Update configure defaults so invalid/missing configs repair into the new shape.
- [ ] Extend the logging prompt to collect rotation settings only for `mode: "file"`.
- [ ] Keep `cloud` mode untouched.
- [ ] Run targeted CLI/type checks to catch any fixture objects that now need explicit `rotation`.

**Verification:**

- Run: `pnpm -r typecheck`
- Expected: no schema/type errors

## Task 2: Implement Rotation-Aware File Target

**Files:**

- Create: `server/src/logging/file-rotation.ts`
- Create: `server/src/logging/rotating-pretty-target.ts`
- Modify: `server/src/middleware/logger.ts`

- [ ] Extract file rotation utilities into a focused helper module.
- [ ] Implement a rotation-aware writable target for pretty-printed file logs.
- [ ] Keep stdout logging behavior unchanged.
- [ ] Rotate oversized `server.log` on startup before first append.
- [ ] Rotate again at runtime when the size threshold is crossed.
- [ ] Prune rotated files beyond `maxFiles`.
- [ ] Ignore rotation logic when `logging.mode !== "file"`.
- [ ] Keep current redaction and HTTP logger behavior unchanged.

**Implementation note:**

Do not attempt to bolt `copytruncate`-style behavior onto the existing plain file path destination. The logger must own the file stream lifecycle so it can reopen cleanly after rotation.

**Verification:**

- Run a targeted manual smoke flow with a tiny test threshold in a temporary log directory.
- Expected: `server.log` stays bounded and rotated sibling files appear.

## Task 3: Add Regression Tests

**Files:**

- Create: `server/src/__tests__/logger-rotation.test.ts`
- Modify: `server/src/__tests__/logger-tz.test.ts` only if logger transport assertions need updating

- [ ] Add a test for startup rotation when an existing log file is already oversized.
- [ ] Add a test for pruning old rotated files beyond `maxFiles`.
- [ ] Add a test that rotation is skipped when disabled.
- [ ] Add a test that stdout target config remains intact.
- [ ] Keep the timezone formatting regression test passing.

**Verification:**

- Run: `pnpm test -- server/src/__tests__/logger-rotation.test.ts server/src/__tests__/logger-tz.test.ts`
- Expected: all targeted logger tests pass

## Task 4: Document Operator Behavior

**Files:**

- Modify: `doc/DEVELOPING.md`

- [ ] Document the new logging rotation defaults.
- [ ] Document the active file and rotated file naming pattern.
- [ ] Document how to tune or disable rotation in config.
- [ ] Document that rotation is built in for file logging and does not require OS `logrotate`.

**Verification:**

- Manually read the updated section for consistency with actual config names and defaults.

## Task 5: End-To-End Verification

**Files:**

- No new files beyond prior tasks

- [ ] Run targeted logger tests.
- [ ] Run repo typecheck.
- [ ] Run full verification if feasible:
  - `pnpm -r typecheck`
  - `pnpm test:run`
  - `pnpm build`
- [ ] If full verification is too expensive for the turn, report exactly what was not run.
- [ ] Manually confirm that a local dev server still starts and writes logs in the configured directory.

## Follow-Up Plan (Separate Change)

After rotation lands, open a separate plan for **log volume reduction**:

- downsample or suppress repetitive `/api/health` logging
- consider lowering file log level from `debug` to `info` for default local installs
- keep structured ops events intact

That should be a separate change because it modifies observability semantics, not just retention.
