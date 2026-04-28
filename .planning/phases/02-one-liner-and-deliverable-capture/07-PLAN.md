---
phase: 02-one-liner-and-deliverable-capture
plan: 07
type: execute
wave: 4
depends_on:
  - 04
  - 05
  - 06
files_modified:
  - server/src/__tests__/workspace-runtime.test.ts
  - cli/src/__tests__/worktree.test.ts
  - vitest.config.ts
  - .planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md
autonomous: true
gap_closure: true
requirements:
  - LOG-01
  - LOG-02
  - ECON-01
must_haves:
  truths:
    - "Workspace-runtime and worktree tests pass in isolation and under the full monorepo suite."
    - "Full Phase 2 verification runs only after Plans 04, 05, and 06 blockers are closed."
    - "Build is run only after `pnpm test:run` is green."
  artifacts:
    - path: "server/src/__tests__/workspace-runtime.test.ts"
      provides: "contention-safe workspace runtime test coverage"
    - path: "cli/src/__tests__/worktree.test.ts"
      provides: "contention-safe worktree test coverage"
    - path: "vitest.config.ts"
      provides: "narrow test sequencing or timeout configuration only if needed"
    - path: ".planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md"
      provides: "truthful final verification status"
  key_links:
    - from: "workspace-runtime/worktree suites"
      to: "pnpm test:run"
      via: "bounded resource isolation under full-suite scheduling"
    - from: "Plan 07 final gate"
      to: "Plans 04, 05, and 06"
      via: "depends_on frontmatter and task prerequisites"
---

# Phase 2 Plan 07 - Runtime/Worktree Contention and Final Gate

## Objective

Fix the remaining Windows full-suite contention in workspace-runtime and worktree tests, then rerun the full Phase 2 gate in the correct order.

Scope guard: this plan is limited to runtime/worktree test contention and final verification notes. Do not change One-Liner product behavior unless a targeted test directly proves it regressed.

## Source Audit

| Source | Item | Coverage |
|--------|------|----------|
| GOAL | Phase 2 cannot advance until `pnpm test:run` and then `pnpm build` pass | Covered by Task 3 final gate |
| REQ | LOG-01, LOG-02, ECON-01 | Preserved; no product behavior change |
| CONTEXT | D-01 through D-14 | Protected by scope guard |
| VERIFICATION | Workspace-runtime and worktree pass in isolation but time out in full suite | Covered by Tasks 1-2 |
| LOG | Full-suite timeout cases in `workspace-runtime.test.ts` and `worktree.test.ts` | Covered by Tasks 1-2 |
| PLAN 04 | Windows-safe materialization helper | Required prerequisite before full gate |
| PLAN 05 | Adapter materialization and launch fixes | Required prerequisite before full gate |
| PLAN 06 | Adapter diagnostics branch fixes | Required prerequisite before full gate |

Deferred items remain out of scope: Multica execution, CQRS events, wiki/graph projection, Jarvis quality, and amoeba ledger work.

## Tasks

```yaml
- id: task-1-workspace-runtime-contention
  depends_on:
    - plan-04
    - plan-05
    - plan-06
  files:
    - server/src/__tests__/workspace-runtime.test.ts
    - vitest.config.ts
  action: |
    Isolate only the workspace-runtime tests that contend on Windows filesystem locks, git worktree metadata, runtime process registries, embedded services, or provisioning commands.
    Prefer `describe.sequential`/`it.sequential`, unique temp roots, explicit process cleanup, stronger bounded cleanup retries, and targeted per-test timeout adjustments over broad global serialization.
    If Vitest config changes are needed, keep them scoped and document why adjacent to the config.
    Do not skip tests or widen assertions to hide failures.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts"
  done: "Workspace-runtime tests pass in isolation with contention-sensitive cases explicitly isolated."

- id: task-2-worktree-contention
  depends_on:
    - task-1-workspace-runtime-contention
  files:
    - cli/src/__tests__/worktree.test.ts
    - vitest.config.ts
  action: |
    Stabilize the worktree tests that time out only during full-suite execution.
    Reuse the Plan 03 shutdown/cleanup pattern already recorded in `03-SUMMARY.md`.
    Keep temp roots unique, release embedded Postgres/process handles before cleanup, and make Windows cleanup retries bounded.
    Do not revert the Plan 03 reseed fix or skip the reseed/hook-copy tests.
  verify:
    automated: "pnpm exec vitest run cli/src/__tests__/worktree.test.ts"
  done: "Worktree tests pass in isolation, including reseed and linked-worktree hook-copy cases."

- id: task-3-final-phase2-gate
  depends_on:
    - task-1-workspace-runtime-contention
    - task-2-worktree-contention
  files:
    - .planning/phases/02-one-liner-and-deliverable-capture/02-VERIFICATION.md
  action: |
    Rerun the final Phase 2 gate after Plans 04, 05, and 06 are complete and Tasks 1-2 pass.
    Run targeted runtime/worktree tests together, then typecheck, then `pnpm test:run`.
    Run `pnpm build` only after `pnpm test:run` exits 0.
    Update `02-VERIFICATION.md` with the exact commands, pass/fail status, and any remaining blocker.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts cli/src/__tests__/worktree.test.ts && pnpm -r typecheck && pnpm test:run && pnpm build"
  done: "`pnpm test:run` and `pnpm build` pass in order, or `02-VERIFICATION.md` truthfully records the remaining blocker."
```

## Threat Model

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-07-01 | Denial of Service | Workspace-runtime tests | mitigate | Isolate contending cases and bound process/filesystem cleanup retries. |
| T-02-07-02 | Denial of Service | Worktree tests | mitigate | Release embedded services and git/worktree handles before cleanup; avoid unbounded retries. |
| T-02-07-03 | Tampering | Vitest sequencing config | mitigate | Keep config changes narrow and documented so unrelated suites are not silently serialized or skipped. |
| T-02-07-04 | Repudiation | Final verification status | mitigate | Record exact gate commands and status in `02-VERIFICATION.md`. |

## Verification

Run in this order:

```sh
pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts
pnpm exec vitest run cli/src/__tests__/worktree.test.ts
pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts cli/src/__tests__/worktree.test.ts
pnpm -r typecheck
pnpm test:run
pnpm build
```

`pnpm test:run` and `pnpm build` must stay in this last plan only.

## Success Criteria

- Workspace-runtime and worktree suites pass in isolation and together.
- `pnpm -r typecheck` passes.
- `pnpm test:run` passes before build is attempted.
- `pnpm build` passes after the test gate is green.
- `02-VERIFICATION.md` reflects the final Phase 2 status truthfully.
- One-Liner and deliverable product behavior remains unchanged.

## Output

After completion, create `.planning/phases/02-one-liner-and-deliverable-capture/07-SUMMARY.md` with changed files, final gate commands, and whether Phase 2 can advance.
