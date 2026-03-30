# AGENTS.md

## Purpose

Paperclip: control plane for AI-agent companies. V1 target in `doc/SPEC-implementation.md`.

## Read This First

1. `doc/GOAL.md` → `doc/PRODUCT.md` → `doc/SPEC-implementation.md` → `doc/DEVELOPING.md` → `doc/DATABASE.md`

## Repo Map

```
server/          # Express REST API
ui/              # React + Vite board UI
packages/db/     # Drizzle schema, migrations
packages/shared/ # types, constants, validators
packages/adapters/ # agent adapters (Claude, Codex, Cursor)
packages/adapter-utils/ # shared adapter utilities
packages/plugins/ # plugin system
doc/             # operational/product docs
```

## Dev Setup

PGlite embedded (no `DATABASE_URL` needed):

```sh
pnpm install && pnpm dev
```

- API/UI: `http://localhost:3100`
- Health: `curl http://localhost:3100/api/health`
- Reset DB: `rm -rf data/pglite && pnpm dev`

## Core Engineering Rules

1. **Company-scoped**: Every domain entity scoped to company; enforce in routes/services.
2. **Sync contracts**: Schema change → update db, shared, server, ui layers.
3. **Control-plane invariants**: single-assignee tasks, atomic checkout, approval gates, budget hard-stop, activity logging.

## Database Change Workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. `pnpm db:generate` (compiles first, reads from `dist/schema/*.js`)
4. `pnpm -r typecheck`

## Verification

```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

## API/Auth

- Base: `/api`
- Board = full-control operator context
- Agents use bearer API keys (`agent_api_keys`), hashed at rest, company-isolated
- Endpoints: company checks, actor permissions, activity logs, consistent HTTP errors

## UI

Routes/nav aligned with API. Company context for scoped pages. Surface failures clearly.

## Definition of Done

- Matches `doc/SPEC-implementation.md`
- Typecheck/tests/build pass
- Contracts synced (db/shared/server/ui)
- Docs updated if behavior/commands changed
