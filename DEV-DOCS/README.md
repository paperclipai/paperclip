# DEV-DOCS

This folder captures the **current local development state** of the Paperclip repository as verified in this workspace.

Last updated: 2026-03-09 (America/New_York)

## Scope

- Current sprint status and immediate priorities
- Branch maintenance status (local only)
- Verified repository structure
- Recent merged product/runtime changes
- Build/test/dev command references
- Environment and architecture notes

## Source of truth used

These docs were updated from live repo inspection of:

- `package.json`, `pnpm-workspace.yaml`, `.env.example`
- `server/package.json`, `ui/package.json`, `cli/package.json`
- `packages/*/package.json`, `packages/adapters/*/package.json`
- source/layout under `server/`, `ui/`, `cli/`, `packages/`, `scripts/`, `docs/`, `doc/`

## Operational spine

- `DEV-DOCS/00-START-HERE.md`
  - current sprint focus, immediate next steps, and key warnings
- `DEV-DOCS/DEVELOPMENT-STATUS.md`
  - roadmap progress, current branch state, blockers, and verification posture
- `DEV-DOCS/01-task-list.md`
  - practical task breakdown with `done`, `partial`, `next`, and `later`
- `DEV-DOCS/work-log.md`
  - dated execution log for major implementation sessions
- `DEV-DOCS/roadmap.md`
  - the five-phase executive-layer roadmap and what each phase means

## Supporting docs

- `DEV-DOCS/branch-maintenance.md`
  - local branch/merge history relevant to the current workspace
- `DEV-DOCS/repo-state.md`
  - verified repo structure, tooling, and product surface snapshot
- `DEV-DOCS/recent-changes.md`
  - recent merged changes explained in product terms

## Current emphasis

If you only read two files before continuing work on this branch:

1. `DEV-DOCS/recent-changes.md`
2. `DEV-DOCS/DEVELOPMENT-STATUS.md`

They now describe the post-Phase-1 executive layer plus the current all-phases sprint work that adds schedules, knowledge, portfolio, and checkout-aware workspace isolation.
