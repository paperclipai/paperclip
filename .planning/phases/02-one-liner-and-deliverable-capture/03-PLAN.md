---
phase: 02-one-liner-and-deliverable-capture
plan: 03
type: execute
wave: 1
depends_on: []
files_modified:
  - cli/src/commands/worktree.ts
  - cli/src/__tests__/worktree.test.ts
autonomous: true
gap_closure: true
requirements:
  - LOG-01
  - LOG-02
  - ECON-01
---

# Phase 2 Plan 03 - Windows Worktree Reseed Gap Closure

## Objective

Close the remaining Phase 2 verification gap by making the worktree reseed teardown deterministic on Windows so the One-Liner phase can clear `pnpm test:run` and re-run the full verification gate truthfully.

## Threat Model

- Do not change the Phase 2 One-Liner product behavior while fixing this gap.
- Do not weaken worktree reseed safety checks around live targets, rollback, or preserved worktree identity.
- Do not hide embedded Postgres shutdown failures behind false-positive cleanup.

## Tasks

```yaml
- id: reseed-teardown-determinism
  objective: Eliminate the remaining Windows EBUSY failure in worktree reseed coverage
  files_modified:
    - cli/src/commands/worktree.ts
    - cli/src/__tests__/worktree.test.ts
  read_first:
    - cli/src/commands/worktree.ts
    - cli/src/__tests__/worktree.test.ts
    - .planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md
  action: |
    Inspect the reseed flow around `seedWorktreeDatabase()` and the failing cleanup path.
    Make source/target embedded Postgres shutdown and temp directory cleanup deterministic on Windows:
    - ensure the reseed path fully releases database handles before temp-root cleanup runs
    - add retry-safe cleanup only where Windows file locking is transient and expected
    - preserve the current worktree ports, instance id, branding, and rollback semantics
  acceptance_criteria:
    - "pnpm exec vitest run cli/src/__tests__/worktree.test.ts -t 'reseed preserves the current worktree ports, instance id, and branding' exits 0"
    - "pnpm exec vitest run cli/src/__tests__/worktree.test.ts exits 0"

- id: phase2-verification-rerun
  objective: Re-run the full Phase 2 verification gate after the reseed fix
  depends_on: [reseed-teardown-determinism]
  files_modified: []
  read_first:
    - .planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md
  action: |
    Re-run the verification sequence for Phase 2 after the reseed cleanup fix lands.
    Keep the gate truthful:
    - confirm the remaining worktree suite is green
    - confirm monorepo typecheck still passes
    - close `pnpm test:run`
    - rerun `pnpm build` only after the test gate is green
  acceptance_criteria:
    - "pnpm -r typecheck exits 0"
    - "pnpm test:run exits 0"
    - "pnpm build exits 0"
```

## Verification

- `pnpm exec vitest run cli/src/__tests__/worktree.test.ts`
- `pnpm -r typecheck`
- `pnpm test:run`
- `pnpm build`

## Success Criteria

- The `EBUSY` reseed cleanup failure no longer reproduces on Windows.
- Phase 2 verification can be recorded as passed without reopening One-Liner scope.
- The next chained GSD step can advance from Phase 2 instead of re-planning the same gap.
