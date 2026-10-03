# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Paperclip

Paperclip is an open-source control plane for AI-agent companies. It manages autonomous AI teams with org charts, task management, cost tracking, and governance. The current target is V1, defined in `doc/SPEC-implementation.md`.

## Before Making Changes

Read in this order:
1. `doc/GOAL.md` — vision and purpose
2. `doc/PRODUCT.md` — product requirements
3. `doc/SPEC-implementation.md` — concrete V1 build contract
4. `doc/DEVELOPING.md` — full dev guide
5. `doc/DATABASE.md` — database setup options

## Prerequisites

- Node.js 20+
- pnpm 9.15+

## Development

```sh
pnpm install
pnpm dev           # API + UI at http://localhost:3100 (watch mode)
pnpm dev:once      # Same, without file watching
pnpm dev:server    # Server only
```

No external database needed — embedded PostgreSQL auto-starts when `DATABASE_URL` is unset, persisting at `~/.paperclip/instances/default/db`.

Reset dev DB:
```sh
rm -rf ~/.paperclip/instances/default/db && pnpm dev
```

Health checks:
```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

## Testing & Verification

```sh
pnpm -r typecheck       # TypeScript validation across all packages
pnpm test:run           # Run all Vitest tests
pnpm build              # Build all packages
pnpm test:e2e           # Playwright E2E tests
```

Run a single test file:
```sh
pnpm vitest run path/to/test.ts
```

**Run all three before claiming done:**
```sh
pnpm -r typecheck && pnpm test:run && pnpm build
```

## Monorepo Structure

```
server/              # Express REST API, routes, services, middleware, adapters
ui/                  # React 19 + Vite SPA dashboard
packages/db/         # Drizzle schema, migrations, DB clients
packages/shared/     # Shared types, Zod validators, API path constants
packages/adapters/   # claude-local, codex-local, cursor-local, etc.
cli/                 # Standalone CLI (esbuild binary)
doc/                 # Specs, product docs, deployment guides
tests/e2e/           # Playwright tests
skills/              # Reusable agent skills
```

## Database Change Workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. `pnpm db:generate` — generates migration (compiles `packages/db` first)
4. `pnpm -r typecheck` — validate

## Core Engineering Rules

1. **Company-scoped**: Every domain entity must be scoped to a company; enforce company boundaries in routes and services.

2. **Synchronized contracts**: When changing schema or API behavior, update all layers:
   - `packages/db` schema and exports
   - `packages/shared` types/constants/validators
   - `server` routes/services
   - `ui` API clients and pages

3. **Control-plane invariants**:
   - Single-assignee task model
   - Atomic issue checkout semantics
   - Approval gates for governed actions
   - Budget hard-stop auto-pause behavior
   - Activity logging for all mutating actions

4. **Additive doc updates**: Do not replace `doc/SPEC.md` or `doc/SPEC-implementation.md` wholesale; prefer additive changes.

## API & Auth

- Base path: `/api`
- Board access = full operator context
- Agent access = bearer API keys (`agent_api_keys`), hashed at rest, company-scoped
- New endpoints must: apply company access checks, enforce board vs. agent permissions, write activity log for mutations, return consistent HTTP errors (`400/401/403/404/409/422/500`)

## Lockfile Policy

Do **not** commit `pnpm-lock.yaml` in PRs — GitHub Actions owns it. CI validates resolution on manifest changes; pushes to `master` regenerate and commit it.

## UI

- React 19 + Tailwind CSS v4 + shadcn/ui (new-york style)
- Design guide: `.claude/skills/design-guide/`
- Routes and nav must stay aligned with available API surface
- Use company selection context for company-scoped pages; surface API errors visibly

## Definition of Done

1. Behavior matches `doc/SPEC-implementation.md`
2. `pnpm -r typecheck && pnpm test:run && pnpm build` all pass
3. Contracts synced across db/shared/server/ui
4. Docs updated when behavior or commands change
