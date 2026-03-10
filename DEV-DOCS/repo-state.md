# Repository State Snapshot (Verified)

Date: 2026-03-09

## Monorepo + tooling

- Package manager: `pnpm@9.15.4`
- Node engine: `>=20`
- Workspace config (`pnpm-workspace.yaml`):
  - `packages/*`
  - `packages/adapters/*`
  - `server`
  - `ui`
  - `cli`

Top-level scripts (`package.json`):

- Dev:
  - `pnpm dev` (full dev runner)
  - `pnpm dev:watch`
  - `pnpm dev:once`
  - `pnpm dev:server`
  - `pnpm dev:ui`
- Build/typecheck/test:
  - `pnpm build`
  - `pnpm typecheck`
  - `pnpm test`
  - `pnpm test:run`
- DB:
  - `pnpm db:generate`
  - `pnpm db:migrate`
  - `pnpm db:backup`
- Utilities:
  - `pnpm paperclipai`
  - `pnpm secrets:migrate-inline-env`
  - `pnpm check:tokens`
  - smoke scripts under `scripts/smoke/`

## Environment defaults

From `.env.example`:

- `DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip`
- `PORT=3100`
- `SERVE_UI=false`

## Major project areas

- `server/` — `@paperclipai/server` (Express-based API/runtime, TS)
- `ui/` — `@paperclipai/ui` (React + Vite + TypeScript)
- `cli/` — `paperclipai` CLI (Commander + TS build via esbuild)
- `packages/shared` — shared types/constants/schemas
- `packages/db` — db client/migrations/backup/seed helpers
- `packages/adapter-utils` — shared adapter helpers
- `packages/adapters/*` — adapter packages:
  - `claude-local`
  - `codex-local`
  - `cursor-local`
  - `opencode-local`
  - `openclaw-gateway`
  - `pi-local`

## Current product surfaces to know about

If the app "looks fine" but the shape is unclear, this is the current mental model:

- `/dashboard`
  - still the narrow telemetry/operations page
  - metric cards, charts, recent activity, recent tasks
  - not the new executive summary surface
- `/briefings/board`
  - new executive board added in the recent merge
  - answers: outcomes landed, risks/blocks, decisions needed, project health, cost anomalies, executive rollups
- `/briefings/results`
  - durable results library
  - where deliverables, findings, blockers, decision outcomes, and status reports now live as first-class records
- `/briefings/plans`
  - durable planning library
  - where strategy memos, project briefs, decision records, operating plans, weekly objectives, and risk registers now live
- `/briefings/briefings`
  - briefing library for briefing records/templates/instances
- `/briefings/portfolio`
  - dedicated portfolio/program board
- `/knowledge`
  - lightweight knowledge library for published durable outputs
- `/briefings/records/:recordId`
  - shared detail page for plans, results, and briefings
  - shows markdown body, attachments, linked work, publish state, and activity
- issue / approval / agent run detail pages
  - still part of the operational layer
  - now include "Promote to result" entry points so execution artifacts can become durable outputs
  - agent run detail also exposes persisted workspace-isolation metadata such as checkout path and branch

## Recent architecture additions now present in code

The repository now includes a durable executive-record layer in addition to goals/projects/issues/runs:

- DB tables:
  - `records`
  - `record_links`
  - `record_attachments`
  - `briefing_view_states`
  - `briefing_schedules`
  - `knowledge_entries`
  - `project_milestones`
  - `workspace_checkouts`
- Shared contracts:
  - record categories: `plan`, `result`, `briefing`
  - record scopes: `company`, `project`, `agent`
  - explicit plan/result/briefing kind enums
  - explicit health and pricing-state enums
- Server routes:
  - company-scoped CRUD/list routes for plans, results, and briefings
  - board summary endpoint at `/api/companies/:companyId/briefings/board`
  - portfolio summary endpoint at `/api/companies/:companyId/briefings/portfolio`
  - shared record detail/mutation routes under `/api/records/:recordId/*`
  - schedule routes under `/api/records/:recordId/schedule`
  - knowledge routes under `/api/companies/:companyId/knowledge` and `/api/knowledge/:entryId`
  - milestone CRUD under `/api/projects/:id/milestones`
  - generic asset upload route at `/api/companies/:companyId/assets/files`
- UI routes:
  - `/briefings`
  - `/briefings/board`
  - `/briefings/briefings`
  - `/briefings/results`
  - `/briefings/plans`
  - `/briefings/portfolio`
  - `/briefings/records/:recordId`
  - `/knowledge`

## Security/runtime corrections included in the merged feature work

The recent executive-record work also shipped follow-up fixes:

- generic `/assets/files` uploads are now limited to inert document MIME types
- asset responses add `X-Content-Type-Options: nosniff`
- project health is derived from the full blocker/decision sets before the board truncates visible lists
- server tests now cover those regressions

## Major gaps still open after the current sprint branch

- checkout lifecycle management is still light
  - logical release of active checkout rows exists
  - physical cleanup/reaping is still future work
- attribution normalization still deserves a deeper audit sweep
- notifications/external reporting are still separate work
- knowledge search/retrieval is intentionally lightweight

## Source/build artifacts present

The repository currently includes built output directories such as:

- `server/dist/`
- `ui/dist/`
- `cli/dist/`
- `packages/*/dist/`

`node_modules/` is present locally.

## Docs layout

Two documentation trees exist and are both active in-repo:

- `docs/` (Mintlify-oriented docs, includes API/deploy/start/adapters sections)
- `doc/` (engineering notes/specs/plans and legacy/internal docs)

## Test footprint (high-level)

Verified first-party tests include:

- `server/src/__tests__/*.test.ts`
- `cli/src/__tests__/*.test.ts`
- `packages/adapters/opencode-local/src/server/*.test.ts`
- `packages/adapters/pi-local/src/server/*.test.ts`

(Repository also contains many dependency tests under `node_modules/`, which are not project-authored tests.)

## Quick validation commands

Use these for lightweight local validation:

```bash
git status -sb
git branch --format='%(refname:short)'
pnpm -r typecheck
pnpm test:run
```
