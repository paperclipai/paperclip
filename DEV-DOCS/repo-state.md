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
