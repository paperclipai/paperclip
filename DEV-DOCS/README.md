# DEV-DOCS

This folder captures the **current local development state** of the Paperclip repository as verified in this workspace.

Last updated: 2026-03-13 (America/New_York)

## Scope

- Current sprint status and immediate priorities
- Branch maintenance status (local only)
- Verified repository structure
- Recent merged product/runtime changes
- Current QoL adoption work around issue assignment, new-issue dialog flow, and operator-facing log privacy
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
- `DEV-DOCS/CONDENSE-AUDIT.md`
  - whole-repo safe-simplification backlog with hotspot scoring, batch sequencing, and doc overlap guidance
- `DEV-DOCS/ARCHITECTURE.md`
  - detailed system boundaries, entity model, runtime flow, roadmap semantics, and governance rules
- `DEV-DOCS/INFRASTRUCURE.md`
  - infrastructure reference for runtime processes, config, persistence, storage, secrets, adapters, realtime, and schedulers
- `DEV-DOCS/MAP.md`
  - interaction map showing how the server, UI, CLI, adapters, records, and governance flows connect
- `DEV-DOCS/UPSTREAM-COMPARISON-2026-03-11.md`
  - selective upstream adoption log showing what was adopted, deferred, and rejected in this fork
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

1. `DEV-DOCS/ARCHITECTURE.md`
2. `DEV-DOCS/DEVELOPMENT-STATUS.md`

If the task is about safe simplification or codebase cleanup, read `DEV-DOCS/CONDENSE-AUDIT.md` immediately after those two files.
If the task is about runtime topology, deployment, or subsystem interactions, read `DEV-DOCS/INFRASTRUCURE.md` and `DEV-DOCS/MAP.md`.
If the task is about upstream parity or selective backports, read `DEV-DOCS/UPSTREAM-COMPARISON-2026-03-11.md`.
If the task is about assignee UX, create-issue behavior, or transcript privacy, read `DEV-DOCS/work-log.md` for the latest change notes.
