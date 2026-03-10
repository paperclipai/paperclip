# Start Here

Last updated: 2026-03-10

## Current focus

Paperclip has already shipped the executive-layer sprint:

- `/briefings/board`
- `/briefings/briefings`
- `/briefings/results`
- `/briefings/plans`
- `/briefings/portfolio`
- `/knowledge`
- durable `records`, schedules, milestones, knowledge publication, and promotion flows

## Current branch

- Working branch: `codex/ci-development-first`
- Baseline source branch: `development`

## Immediate priorities

1. Keep `DEV-DOCS/` aligned with the actual code and branch policy.
2. Move PR verification to `development`, where feature work is supposed to land.
3. Move lockfile ownership to `development`, where integration actually happens.
4. End with full verification:
   - `pnpm -r typecheck`
   - `pnpm test:run`
   - `pnpm build`

## Important current truths

- `/dashboard` is still the operational telemetry page.
- The executive sprint is merged on `development`.
- `development` is the gated integration branch.
- `master` is the promotion branch after beta/live soak.
- CI-owned lockfile updates belong on `development`, not on feature branches.

## Read next

1. `DEV-DOCS/DEVELOPMENT-STATUS.md`
2. `DEV-DOCS/01-task-list.md`
3. `DEV-DOCS/recent-changes.md`
