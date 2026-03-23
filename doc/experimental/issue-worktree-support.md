# Issue worktree support

Status: experimental, runtime-only, not shipping as a user-facing feature yet.

This branch contains the runtime and seeding work needed for issue-scoped worktrees:

- project execution workspace policy support
- issue-level execution workspace settings
- git worktree realization for isolated issue execution
- optional command-based worktree provisioning
- seeded worktree fixes for secrets key compatibility
- seeded project workspace rebinding to the current git worktree

We are intentionally not shipping the UI for this yet. The runtime code remains in place, but the main UI entrypoints are hard-gated off for now.

## What works today

- projects can carry execution workspace policy in the backend
- issues can carry execution workspace settings in the backend
- heartbeat execution can realize isolated git worktrees
- runtime can run a project-defined provision command inside the derived worktree
- seeded worktree instances can keep local-encrypted secrets working
- seeded worktree instances can rebind same-repo project workspace paths onto the current git worktree

## Hidden UI entrypoints

These are the current user-facing UI surfaces for the feature, now intentionally disabled:

- project settings:
  - `ui/src/components/ProjectProperties.tsx`
  - execution workspace policy controls
  - git worktree base ref / branch template / parent dir
  - provision / teardown command inputs

- issue creation:
  - `ui/src/components/NewIssueDialog.tsx`
  - isolated issue checkout toggle
  - defaulting issue execution workspace settings from project policy

- issue editing:
  - `ui/src/components/IssueProperties.tsx`
  - issue-level workspace mode toggle
  - defaulting issue execution workspace settings when project changes

- agent/runtime settings:
  - `ui/src/adapters/runtime-json-fields.tsx`
  - runtime services JSON field, which is part of the broader workspace-runtime support surface

## Why the UI is hidden

- the runtime behavior is still being validated
- the workflow and operator ergonomics are not final
- we do not want to expose a partially-baked user-facing feature in issues, projects, or settings

## Re-enable plan

When this is ready to ship:

- re-enable the gated UI sections in the files above
- review wording and defaults for project and issue controls
- decide which agent/runtime settings should remain advanced-only
- add end-to-end product-level verification for the full UI workflow
