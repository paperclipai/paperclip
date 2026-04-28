---
phase: 02-one-liner-and-deliverable-capture
plan: 05
type: execute
wave: 2
depends_on:
  - 04
files_modified:
  - packages/adapters/codex-local/src/server/codex-home.ts
  - packages/adapters/codex-local/src/server/execute.ts
  - packages/adapters/claude-local/src/server/prompt-cache.ts
  - packages/adapters/cursor-local/src/server/execute.ts
  - packages/adapters/gemini-local/src/server/execute.ts
  - packages/adapters/opencode-local/src/server/execute.ts
  - packages/adapters/pi-local/src/server/execute.ts
  - server/src/__tests__/codex-local-execute.test.ts
  - server/src/__tests__/claude-local-execute.test.ts
  - server/src/__tests__/cursor-local-execute.test.ts
  - server/src/__tests__/gemini-local-execute.test.ts
  - server/src/__tests__/pi-local-execute.test.ts
autonomous: true
gap_closure: true
requirements:
  - LOG-01
  - LOG-02
  - ECON-01
must_haves:
  truths:
    - "Local adapter command fixtures launch reliably on Windows targeted execute-suite runs."
    - "Plan 04 materialization helpers are used where adapter auth/config or skill fixtures need Windows-safe setup."
    - "Phase 2 One-Liner and deliverable behavior remains unchanged while adapter execute fixtures are stabilized."
  artifacts:
    - path: "packages/adapters/codex-local/src/server/codex-home.ts"
      provides: "Windows-safe Codex auth/config home materialization using Plan 04 helpers"
    - path: "packages/adapters/*/src/server/execute.ts"
      provides: "adapter command launch paths that work with Windows temp commands"
    - path: "server/src/__tests__/*local*execute.test.ts"
      provides: "execute coverage for Windows temp command launch"
  key_links:
    - from: "Plan 05 adapter auth/config setup"
      to: "Plan 04 materialization helper"
      via: "import from packages/adapter-utils/src/server-utils.ts"
    - from: "adapter execute tests"
      to: "mock temp commands"
      via: "explicit Windows-safe command launch"
---

# Phase 2 Plan 05 - Adapter Materialization and Temp Command Launch

## Objective

Use the Plan 04 helper contract and fix local adapter temp command execution so adapter execute suites are deterministic on Windows.

Scope guard: this is verification infrastructure for RealTycoon2 Phase 2. Do not change One-Liner product behavior, deliverable contracts, base-price rules, or RT2 route behavior.

## Source Audit

| Source | Item | Coverage |
|--------|------|----------|
| GOAL | Phase 2 full verification remains blocked after product must-haves passed | Covered by stabilizing adapter execute blockers reported by the full-suite log |
| REQ | LOG-01, LOG-02, ECON-01 | Preserved; no One-Liner behavior changes |
| CONTEXT | D-01 through D-14 | Protected by scope guard |
| VERIFICATION | Claude, Codex, Cursor, Gemini, and PI execute temp command launch fail under full suite | Covered by Tasks 1-2 |
| LOG | Codex symlink `EPERM` and local adapter launch failures | Covered by Tasks 1-2 |
| PLAN 04 | Shared materialization helper exists | Required dependency for auth/config/skill fixture wiring |

Deferred items remain out of scope: Multica execution, CQRS events, wiki/graph projection, Jarvis quality, and amoeba ledger work.

## Tasks

```yaml
- id: task-1-wire-materialization-helper
  depends_on:
    - plan-04
  files:
    - packages/adapters/codex-local/src/server/codex-home.ts
    - packages/adapters/codex-local/src/server/execute.ts
    - server/src/__tests__/codex-local-execute.test.ts
  action: |
    Replace direct symlink assumptions in Codex auth/config fixture setup with the Plan 04 shared materialization helper.
    Keep existing runtime locations and brownfield adapter names unchanged.
    Tests must assert resolved contents, runtime metadata, or expected command notes rather than requiring symlink-only behavior on Windows.
    This implements only verification infrastructure for LOG-01, LOG-02, and ECON-01; it must not change One-Liner product behavior.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/codex-local-execute.test.ts"
  done: "Codex execute tests no longer fail on auth/config symlink EPERM, and Codex materialization use-sites consume the shared helper."

- id: task-2-windows-temp-command-launch
  depends_on:
    - task-1-wire-materialization-helper
  files:
    - packages/adapters/codex-local/src/server/execute.ts
    - packages/adapters/claude-local/src/server/prompt-cache.ts
    - packages/adapters/cursor-local/src/server/execute.ts
    - packages/adapters/gemini-local/src/server/execute.ts
    - packages/adapters/opencode-local/src/server/execute.ts
    - packages/adapters/pi-local/src/server/execute.ts
    - server/src/__tests__/claude-local-execute.test.ts
    - server/src/__tests__/cursor-local-execute.test.ts
    - server/src/__tests__/gemini-local-execute.test.ts
    - server/src/__tests__/pi-local-execute.test.ts
  action: |
    Make mocked local adapter commands executable on Windows.
    Prefer `.cmd` wrappers for test-owned temp commands, or invoke temp JavaScript through `process.execPath` when the configured command has no Windows executable extension.
    Keep command resolution independent from developer-machine PATH quirks, PowerShell-specific behavior, POSIX shebang handling, or ambient ComSpec assumptions.
    Do not weaken execute assertions; fix fixture launch and resolution so the intended adapter behavior is exercised.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts"
  done: "Adapter execute suites start their mocked commands on Windows and pass through intended success/failure branches."
```

## Threat Model

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-05-01 | Spoofing | Temp adapter command resolution | mitigate | Resolve and launch explicit test-owned command paths; do not let global PATH order choose the executable. |
| T-02-05-02 | Tampering | Adapter auth/config fixture materialization | mitigate | Use Plan 04 helper metadata/content checks to prove copied or linked files match the intended source. |
| T-02-05-03 | Denial of Service | Adapter execute launch | mitigate | Ensure failed command launch returns bounded errors instead of hanging. |
| T-02-05-04 | Repudiation | Execute-suite behavior | mitigate | Preserve explicit success/failure assertions instead of replacing them with launch-only checks. |

## Verification

Run:

```sh
pnpm exec vitest run server/src/__tests__/codex-local-execute.test.ts
pnpm exec vitest run server/src/__tests__/claude-local-execute.test.ts server/src/__tests__/cursor-local-execute.test.ts server/src/__tests__/gemini-local-execute.test.ts server/src/__tests__/pi-local-execute.test.ts
```

Do not run the full monorepo test or build gates in this plan; those gates belong to Plan 07 after diagnostics and runtime/worktree contention are fixed.

## Success Criteria

- Adapter execute suites no longer fail because Windows cannot start test-owned temp commands.
- Adapter auth/config/skill use-sites consume the Plan 04 materialization helper where relevant.
- One-Liner and deliverable product behavior is untouched.
- Plan 06 can focus on adapter diagnostics branch classification without carrying execute-suite materialization scope.

## Output

After completion, create `.planning/phases/02-one-liner-and-deliverable-capture/05-SUMMARY.md` with changed files, verification commands, and any adapter execute launch issues still unstable.
