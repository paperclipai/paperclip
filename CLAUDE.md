# CLAUDE.md — Paperclip (Lacy's Fork)

Fork of [paperclipai/paperclip](https://github.com/paperclipai/paperclip).
Origin: `lacymorrow/paperclip`. Upstream: `paperclipai/paperclip`.

## What This Is

Paperclip is a control plane for AI-agent companies. Express REST API + React/Vite UI + Drizzle/PostgreSQL.

## Quick Start

```sh
pnpm install
pnpm dev          # API + UI on http://localhost:3100
```

Embedded PGlite is used in dev when `DATABASE_URL` is unset. Reset with `rm -rf data/pglite && pnpm dev`.

## Dev Commands

| Command | What |
|---------|------|
| `pnpm dev` | Start API + UI (watch mode) |
| `pnpm dev:server` | Server only |
| `pnpm dev:ui` | UI only |
| `pnpm build` | Build all packages |
| `pnpm typecheck` | Typecheck all packages |
| `pnpm test` | Run vitest suite |
| `pnpm test:e2e` | Playwright e2e (opt-in) |
| `pnpm db:generate` | Generate Drizzle migration |
| `pnpm db:migrate` | Run migrations |

## Repo Map

```
server/          Express REST API + orchestration
ui/              React + Vite board UI
packages/db/     Drizzle schema, migrations
packages/shared/ Shared types, constants, validators
packages/adapters/       Agent adapter implementations
packages/adapter-utils/  Shared adapter utilities
packages/plugins/        Plugin system
packages/mcp-server/     MCP server package
cli/             CLI tool
doc/             Product and operational docs
```

## Package Manager

pnpm (v9.15.4). Do not use npm or yarn.

## Key Conventions

- pnpm workspace monorepo (see `pnpm-workspace.yaml`)
- TypeScript throughout, ESM (`"type": "module"`)
- Drizzle ORM with PostgreSQL
- All domain entities scoped to a company
- If you change schema/API, update all layers: db -> shared -> server -> ui
- Conventional commits: `feat:`, `fix:`, `chore:`, `docs:`
- PR descriptions must follow `.github/PULL_REQUEST_TEMPLATE.md`

## No Database Migrations (Critical)

**This fork MUST NOT add, modify, or delete any database migration or schema files.** This includes:
- `packages/db/src/migrations/` (SQL files, snapshots)
- `packages/db/src/schema/` (Drizzle schema definitions)
- `packages/db/drizzle.config.ts`
- Running `pnpm db:generate` or `pnpm db:migrate`

We track upstream `paperclipai/paperclip` and only accept front-end and back-end fixes that are compatible with future upstream merges. Database divergence makes upstream syncs painful or impossible. CI enforces this via `scripts/check-no-db-migrations.mjs`.

## Verification

Default check (fast):
```sh
pnpm test
```

Full check before PR hand-off:
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

## Upstream Sync

```sh
git fetch upstream
git merge upstream/master
```

## Instance

Local Paperclip instance runs on `localhost:3100` with embedded Postgres on port 54329.

## Deeper Docs

Read `AGENTS.md` for full engineering rules. Read `doc/` for product specs and operational docs.
