# Start Here

Last updated: 2026-03-09

## Current focus

Paperclip has already shipped the first executive-layer slice:

- `/briefings/board`
- `/briefings/results`
- `/briefings/plans`
- durable `records` plus promotion flows from issues, approvals, and runs

The current sprint branch exists to finish the missing pieces across all five phases:

- Phase 2: real briefing product with library, schedules, and approval-aware digest synthesis
- Phase 3: lightweight knowledge library with record publication
- Phase 4: portfolio board plus milestones
- Phase 5: attribution hardening, worktree isolation, and honest cost reporting everywhere

## Current branch

- Working branch: `codex/all-phases-executive-sprint`
- Baseline source branch: `development`

## Immediate priorities

1. Keep `DEV-DOCS/` aligned with the actual code as the sprint lands.
2. Add missing schema/shared contracts for schedules, knowledge, milestones, and worktree checkouts.
3. Extend the server/runtime before polishing the UI so routes and storage stay authoritative.
4. End with full verification:
   - `pnpm -r typecheck`
   - `pnpm test:run`
   - `pnpm build`
   - Playwright interactive QA across the executive surfaces

## Important current truths

- `/dashboard` is still the operational telemetry page.
- `Briefings` is present, but incomplete relative to the intended five-phase roadmap.
- There is no shipped knowledge library yet.
- There is no shipped portfolio page yet.
- Cost truthfulness exists on the board, but not yet across all money displays.
- Workspace isolation is not yet implemented.

## Read next

1. `DEV-DOCS/DEVELOPMENT-STATUS.md`
2. `DEV-DOCS/01-task-list.md`
3. `DEV-DOCS/recent-changes.md`
