---
phase: 02-one-liner-and-deliverable-capture
plan: 04
type: execute
wave: 1
depends_on: []
files_modified:
  - packages/adapter-utils/src/server-utils.ts
  - packages/adapter-utils/src/server-utils.test.ts
  - server/src/__tests__/paperclip-skill-utils.test.ts
autonomous: true
gap_closure: true
requirements:
  - LOG-01
  - LOG-02
  - ECON-01
must_haves:
  truths:
    - "Phase 2 One-Liner and deliverable behavior remains unchanged while Windows fixture materialization is fixed."
    - "Adapter skill/auth fixtures no longer require developer-mode symlink privileges on Windows."
    - "Existing symlink cleanup semantics remain covered where real symlinks are available."
  artifacts:
    - path: "packages/adapter-utils/src/server-utils.ts"
      provides: "shared Windows-safe link/materialization helpers"
    - path: "packages/adapter-utils/src/server-utils.test.ts"
      provides: "unit coverage for helper fallback behavior"
    - path: "server/src/__tests__/paperclip-skill-utils.test.ts"
      provides: "coverage for stale maintainer-skill cleanup without Windows EPERM failures"
  key_links:
    - from: "adapter skill/auth fixture setup"
      to: "packages/adapter-utils/src/server-utils.ts"
      via: "shared materialization helper"
    - from: "server/src/__tests__/paperclip-skill-utils.test.ts"
      to: "Windows symlink fallback"
      via: "test fixture setup that does not assume symlink privilege"
---

# Phase 2 Plan 04 - Windows-Safe Link Materialization Helpers

## Objective

Close the Windows symlink `EPERM` verification blocker by narrowing the fix to shared link/materialization helpers and tests.

Scope guard: do not change One-Liner parsing, draft review, deliverable/base-price capture, routing, or commit behavior. This plan only stabilizes brownfield adapter/test infrastructure needed to verify Phase 2.

## Source Audit

| Source | Item | Coverage |
|--------|------|----------|
| GOAL | Phase 2 must clear full verification after One-Liner product behavior is already implemented | Covered by removing a verification-only Windows fixture blocker |
| REQ | LOG-01, LOG-02, ECON-01 | Preserved; no product behavior change |
| CONTEXT | D-01 through D-14 One-Liner and deliverable decisions | Protected by scope guard |
| VERIFICATION | `paperclip-skill-utils.test.ts` fails on Windows symlink `EPERM` | Covered by Tasks 1-2 |
| LOG | `codex-local-execute.test.ts` also reports auth/config symlink `EPERM`; adapter use-site wiring is deferred to Plan 05 | Helper contract created here for downstream use |

Deferred items remain out of scope: Multica execution, CQRS events, wiki/graph projection, Jarvis quality, and amoeba ledger work.

## Tasks

```yaml
- id: task-1-materialization-helper
  depends_on: []
  files:
    - packages/adapter-utils/src/server-utils.ts
    - packages/adapter-utils/src/server-utils.test.ts
  action: |
    Add a shared helper for materializing files/directories from a source path to a destination path.
    Preserve symlink behavior on platforms where it works.
    On Windows, use directory junctions where directory link semantics are required, and fall back to copy or hardlink-safe behavior for file assets when symlink creation returns EPERM.
    Return metadata that lets callers/tests distinguish symlink, junction, hardlink, and copy outcomes without requiring symlink-only assertions.
    Keep the helper generic; do not wire adapter-specific execute behavior in this plan.
  verify:
    automated: "pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts"
  done: "Helper exists, covers Windows EPERM fallback paths, and keeps non-Windows symlink behavior covered."

- id: task-2-skill-cleanup-fixture
  depends_on:
    - task-1-materialization-helper
  files:
    - server/src/__tests__/paperclip-skill-utils.test.ts
  action: |
    Update stale maintainer-skill cleanup tests to use the shared materialization helper from Task 1.
    Assertions must check cleanup behavior through realpath/content/helper metadata instead of assuming test fixtures can always create symlinks on Windows.
    Preserve the behavioral distinction between maintainer-owned runtime skills and user-owned custom skills.
  verify:
    automated: "pnpm exec vitest run server/src/__tests__/paperclip-skill-utils.test.ts"
  done: "The skill cleanup suite passes without Windows symlink privilege while still proving stale maintainer-only links are removed and custom skills are preserved."
```

## Threat Model

| Threat ID | Category | Component | Disposition | Mitigation Plan |
|-----------|----------|-----------|-------------|-----------------|
| T-02-04-01 | Tampering | Link materialization helper | mitigate | Preserve source contents exactly and expose materialization metadata so fallback behavior is testable. |
| T-02-04-02 | Information Disclosure | Auth/config fixture copies | mitigate | Keep fallback copies under caller-provided temp/runtime roots; do not introduce new persistent secret locations. |
| T-02-04-03 | Denial of Service | Windows filesystem cleanup | mitigate | Keep cleanup bounded and avoid retry loops that can hang the test process. |
| T-02-04-04 | Repudiation | Test fixture behavior | mitigate | Tests must assert helper metadata/content equivalence instead of silently accepting skipped symlink coverage. |

## Verification

Run:

```sh
pnpm exec vitest run packages/adapter-utils/src/server-utils.test.ts
pnpm exec vitest run server/src/__tests__/paperclip-skill-utils.test.ts
```

Do not run the full monorepo test or build gates in this plan; those gates belong to Plan 07 after dependent adapter, diagnostics, and runtime fixes land.

## Success Criteria

- Shared materialization helpers support Windows-safe file and directory fixture setup.
- `paperclip-skill-utils.test.ts` no longer fails on symlink `EPERM`.
- One-Liner and deliverable product behavior is untouched.
- Plans 05 and 06 can reuse the helper without reopening this scope.

## Output

After completion, create `.planning/phases/02-one-liner-and-deliverable-capture/04-SUMMARY.md` with changed files, verification commands, and any remaining helper limitations.
