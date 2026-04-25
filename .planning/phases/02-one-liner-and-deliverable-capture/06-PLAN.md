---
phase: 02-one-liner-and-deliverable-capture
plan: 06
type: execute
wave: 3
depends_on:
  - 04
  - 05
files_modified:
  - packages/adapters/cursor-local/src/server/execute.ts
  - packages/adapters/opencode-local/src/server/execute.ts
  - packages/adapters/pi-local/src/server/execute.ts
  - packages/adapters/pi-local/src/server/models.ts
  - server/src/__tests__/pi-local-adapter-environment.test.ts
  - server/src/__tests__/cursor-local-adapter-environment.test.ts
  - server/src/__tests__/opencode-local-adapter-environment.test.ts
autonomous: true
gap_closure: true
requirements:
  - LOG-01
  - LOG-02
  - ECON-01
must_haves:
  truths:
    - "Adapter diagnostics reach their intended pass/warn/fail branches after Plan 05 temp command launch fixes."
    - "PI, Cursor, and OpenCode diagnostics classify mocked probe output deterministically on Windows."
    - "Phase 2 One-Liner and deliverable behavior remains unchanged while diagnostics are stabilized."
  artifacts:
    - path: "packages/adapters/pi-local/src/server/models.ts"
      provides: "PI package/model diagnostic classification support"
    - path: "packages/adapters/*/src/server/execute.ts"
      provides: "diagnostic probe launch and classification wiring for affected adapters"
    - path: "server/src/__tests__/*adapter-environment.test.ts"
      provides: "diagnostics coverage for mocked adapter probes"
  key_links:
    - from: "Plan 06 adapter environment diagnostics"
      to: "Plan 05 temp command launch fixes"
      via: "depends_on frontmatter and task prerequisites"
    - from: "adapter environment diagnostics"
      to: "mock probe outputs"
      via: "explicit Windows-safe command launch and classification"
---

# Phase 2 Plan 06 - Adapter Diagnostics Branch Fixes

## Objective

Fix adapter diagnostics branch classification after Plan 05 makes local temp command launch deterministic.

Scope guard: this is verification infrastructure for RealTycoon2 Phase 2. Do not change One-Liner product behavior, deliverable contracts, base-price rules, or RT2 route behavior.

## Source Audit

| Source | Item | Coverage |
|--------|------|----------|
| GOAL | Phase 2 full verification remains blocked after product must-haves passed | Covered by stabilizing adapter diagnostics blockers reported by the full-suite log |
| REQ | LOG-01, LOG-02, ECON-01 | Preserved; no One-Liner behavior changes |
| CONTEXT | D-01 through D-14 | Protected by scope guard |
| VERIFICATION | PI, Cursor, and OpenCode adapter diagnostics fail or time out under full suite | Covered by Tasks 1-2 |
| LOG | PI diagnostic pass/warn branches, Cursor hello-probe pass branches, and OpenCode timeout/model-unavailable branches fail | Covered by Tasks 1-2 |
| PLAN 04 | Windows-safe materialization helper exists | Required prerequisite for any remaining fixture materialization |
| PLAN 05 | Adapter temp command launch is fixed | Required prerequisite before diagnostics branch fixes |

Deferred items remain out of scope: Multica execution, CQRS events, wiki/graph projection, Jarvis quality, and amoeba ledger work.

## Tasks

```yaml
- id: task-1-pi-diagnostics-branches
  depends_on:
    - plan-04
    - plan-05
  files:
    - packages/adapters/pi-local/src/server/execute.ts
    - packages/adapters/pi-local/src/server/models.ts
    - server/src/__tests__/pi-local-adapter-environment.test.ts
  action: |
    Fix PI diagnostics tests and adapter probe wiring so mocked outputs reach deterministic diagnostic branches after Plan 05 temp command launch fixes.
    PI diagnostics must surface `pi_models_discovered`, `pi_hello_probe_passed`, and `pi_package_install_failed` in the relevant tests.
    Do not relax diagnostics assertions; the fix should make probes launch and classify correctly.
    This implements only verification infrastructure for LOG-01, LOG-02, and ECON-01; it must not change One-Liner product behavior.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/pi-local-adapter-environment.test.ts"
  done: "PI adapter environment diagnostics pass with deterministic pass and stale-package warning checks."

- id: task-2-cursor-opencode-diagnostics-branches
  depends_on:
    - task-1-pi-diagnostics-branches
  files:
    - packages/adapters/cursor-local/src/server/execute.ts
    - packages/adapters/opencode-local/src/server/execute.ts
    - server/src/__tests__/cursor-local-adapter-environment.test.ts
    - server/src/__tests__/opencode-local-adapter-environment.test.ts
  action: |
    Fix Cursor and OpenCode diagnostics tests and adapter probe wiring so mocked outputs reach deterministic diagnostic branches.
    Cursor diagnostics must reach the hello-probe pass branch when trust bypass args are provided or auto-added.
    OpenCode diagnostics must classify missing API keys and model-unavailable probe output without timing out.
    Do not relax diagnostics assertions; the fix should make probes launch and classify correctly.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/cursor-local-adapter-environment.test.ts server/src/__tests__/opencode-local-adapter-environment.test.ts"
  done: "Cursor and OpenCode adapter environment suites pass with deterministic diagnostic checks instead of launch failures or timeouts."
```

## Threat Model

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-06-01 | Spoofing | Diagnostics probe command resolution | mitigate | Use explicit test-owned command paths already stabilized by Plan 05. |
| T-02-06-02 | Denial of Service | Diagnostics probes | mitigate | Keep probe timeouts bounded and ensure failed command launch returns diagnostics instead of hanging. |
| T-02-06-03 | Repudiation | Adapter diagnostic results | mitigate | Preserve explicit pass/warn/fail assertions for each expected diagnostic branch. |
| T-02-06-04 | Tampering | Diagnostic classification | mitigate | Classify based on explicit mocked stdout/stderr/status signals, not ambient machine state. |

## Verification

Run:

```sh
pnpm exec vitest run server/src/__tests__/pi-local-adapter-environment.test.ts
pnpm exec vitest run server/src/__tests__/cursor-local-adapter-environment.test.ts server/src/__tests__/opencode-local-adapter-environment.test.ts
```

Do not run the full monorepo test or build gates in this plan; those gates belong to Plan 07 after runtime/worktree contention is fixed.

## Success Criteria

- Adapter diagnostics suites report intended diagnostic branches rather than launch failures or timeouts.
- Diagnostics branch assertions remain specific and are not skipped or weakened.
- One-Liner and deliverable product behavior is untouched.
- Plan 07 can run runtime/worktree contention fixes and the final full verification gate.

## Output

After completion, create `.planning/phases/02-one-liner-and-deliverable-capture/06-SUMMARY.md` with changed files, verification commands, and any adapter diagnostics still unstable.
