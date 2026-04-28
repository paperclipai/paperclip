---
phase: 01-rt2-shell-and-product-truth
plan: 02
type: execute
wave: 1
depends_on: []
files_modified:
  - server/src/__tests__/opencode-local-adapter-environment.test.ts
  - server/src/__tests__/workspace-runtime.test.ts
  - server/src/services/workspace-runtime.ts
  - packages/adapter-utils/src/server-utils.ts
  - scripts/provision-worktree.sh
  - cli/src/__tests__/worktree.test.ts
autonomous: true
gap_closure: true
requirements:
  - IDENT-01
  - IDENT-02
---

# Phase 1 Plan 02 - Windows Runtime and Worktree Gap Closure

## Objective

Close the remaining Phase 1 verification gap by making the Windows runtime/worktree test surface deterministic enough for `pnpm test:run` to pass, without undoing the RT2 shell cutover that Phase 1 already achieved.

## Threat Model

- Do not weaken company-scoped runtime env isolation while fixing Windows process handling.
- Do not mask real runtime-service failures by replacing them with fake pass conditions.
- Do not change the RT2 shell routes or navigation as part of this gap closure.

## Tasks

```yaml
- id: opencode-probe-diagnostics
  objective: Remove Windows-only hangs from opencode environment diagnostics
  files_modified:
    - server/src/__tests__/opencode-local-adapter-environment.test.ts
    - packages/adapter-utils/src/server-utils.ts
  read_first:
    - server/src/__tests__/opencode-local-adapter-environment.test.ts
    - packages/adapter-utils/src/server-utils.ts
    - .planning/phases/01-rt2-shell-and-product-truth/01-VERIFICATION.md
  action: |
    Make the opencode diagnostic probe deterministic on Windows:
    - identify why the empty OPENAI_API_KEY and ProviderModelNotFoundError cases hang for 5s
    - ensure the fake opencode command exits promptly and the probe path resolves stdout/stderr without leaving a child process open
    - preserve the existing diagnostic classifications instead of loosening the assertions
  acceptance_criteria:
    - "pnpm exec vitest run server/src/__tests__/opencode-local-adapter-environment.test.ts exits 0"
    - "grep -n 'OPENAI_API_KEY' server/src/__tests__/opencode-local-adapter-environment.test.ts returns the empty-key diagnostic case"
    - "grep -n 'ProviderModelNotFoundError' server/src/__tests__/opencode-local-adapter-environment.test.ts returns the model-unavailable diagnostic case"

- id: workspace-provision-and-pnpm
  objective: Fix provision-command and local pnpm install failures in workspace runtime tests
  files_modified:
    - server/src/__tests__/workspace-runtime.test.ts
    - server/src/services/workspace-runtime.ts
    - scripts/provision-worktree.sh
  read_first:
    - server/src/__tests__/workspace-runtime.test.ts
    - server/src/services/workspace-runtime.ts
    - scripts/provision-worktree.sh
    - .planning/phases/01-rt2-shell-and-product-truth/01-VERIFICATION.md
  action: |
    Close the provision/worktree command gaps in Windows coverage:
    - align the provision-env expectation with the Windows bash-wrapper path strategy or make the wrapper preserve the required observable value
    - replace the failing runPnpm invocation path so worktree-local installs do not raise spawn EINVAL on Windows
    - keep provision-worktree behavior truthful for repo-local config, branding, and worktree-local node_modules setup
    - add retry-safe cleanup where persisted-worktree tests currently fail with EBUSY
  acceptance_criteria:
    - "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'runs a configured provision command inside the derived worktree' exits 0"
    - "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'provisions worktree-local pnpm node_modules instead of reusing base-repo links' exits 0"
    - "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'reattaches a missing persisted git worktree before manual control starts it' exits 0"

- id: runtime-service-lifecycle
  objective: Eliminate remaining Windows runtime-service timeouts in workspace runtime coverage
  files_modified:
    - server/src/__tests__/workspace-runtime.test.ts
    - server/src/services/workspace-runtime.ts
    - packages/adapter-utils/src/server-utils.ts
  read_first:
    - server/src/__tests__/workspace-runtime.test.ts
    - server/src/services/workspace-runtime.ts
    - packages/adapter-utils/src/server-utils.ts
    - .planning/phases/01-rt2-shell-and-product-truth/01-VERIFICATION.md
  action: |
    Make runtime-service startup and teardown deterministic on Windows:
    - inspect the shared-service and execution-workspace service launch path that currently times out across the ensureRuntimeServicesForRun suite
    - make the command spawn, readiness detection, and stop logic finish under test deadlines without leaking parent instance env
    - preserve sibling-workspace isolation and selected-service targeting semantics
  acceptance_criteria:
    - "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'reuses shared runtime services across runs and starts a new service after release' exits 0"
    - "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'does not leak parent Paperclip instance env into runtime service commands' exits 0"
    - "pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts -t 'stops only the selected execution workspace runtime service' exits 0"

- id: worktree-reseed
  objective: Close the remaining worktree reseed timeout under Windows
  files_modified:
    - cli/src/__tests__/worktree.test.ts
    - server/src/services/workspace-runtime.ts
  read_first:
    - cli/src/__tests__/worktree.test.ts
    - server/src/services/workspace-runtime.ts
    - .planning/phases/01-rt2-shell-and-product-truth/01-VERIFICATION.md
  action: |
    Fix the reseed timeout without changing the intended behavior:
    - keep the current worktree ports, instance id, and branding preserved across reseed
    - ensure the reseed path exits deterministically on Windows and does not hang on child process cleanup
    - reuse the same Windows-safe worktree/runtime helpers introduced for the server-side fixes
  acceptance_criteria:
    - "pnpm exec vitest run cli/src/__tests__/worktree.test.ts -t 'reseed preserves the current worktree ports, instance id, and branding' exits 0"
```

## Verification

- `pnpm exec vitest run server/src/__tests__/opencode-local-adapter-environment.test.ts`
- `pnpm exec vitest run server/src/__tests__/workspace-runtime.test.ts`
- `pnpm exec vitest run cli/src/__tests__/worktree.test.ts`
- `pnpm test:run`

## Success Criteria

- The failures listed in `01-VERIFICATION.md` no longer reproduce.
- `pnpm test:run` passes on this Windows environment.
- Phase 1 can be re-run through `$gsd-execute-phase 1 --gaps-only --auto --chain` without reopening RT2 shell scope.
