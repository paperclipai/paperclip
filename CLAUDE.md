# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is Paperclip

Paperclip is an open-source control plane for autonomous AI-agent companies. It orchestrates AI agents as employees within a company structure — handling task management, cost control, goal alignment, and governance. It is **not** a chatbot or workflow builder; agents run externally and report back.

## Common Commands

```sh
pnpm install              # Install dependencies
pnpm dev                  # Full dev (API + UI, watch mode) — localhost:3100
pnpm dev:once             # One-time build without file watching
pnpm build                # Build all workspaces
pnpm typecheck            # TypeScript strict check across all packages (alias: pnpm -r typecheck)
pnpm test:run             # Run all unit/integration tests (Vitest)
pnpm test:e2e             # Playwright end-to-end tests
pnpm db:generate          # Generate DB migration from schema changes
pnpm db:migrate           # Apply pending migrations
```

Run a single test file: `npx vitest run path/to/file.test.ts`

### Verification before hand-off

```sh
pnpm typecheck && pnpm test:run && pnpm build
```

## Architecture

Monorepo with pnpm workspaces. Node.js 20+ / TypeScript throughout.

### Workspace layout

- **`server/`** — Express 5 REST API, orchestration services, WebSocket real-time events
- **`ui/`** — React 19 + Vite + Tailwind CSS + Radix UI board interface
- **`cli/`** — CLI tool (`pnpm paperclipai <command>`)
- **`packages/db/`** — Drizzle ORM schema, migrations, DB client (embedded PGlite by default)
- **`packages/shared/`** — Shared types, constants, Zod validators, API path constants
- **`packages/adapters/`** — Agent adapter implementations (claude-local, codex-local, cursor-local, opencode-local, pi-local, gemini-local, droid-local, openclaw-gateway)
- **`packages/adapter-utils/`** — Shared adapter utilities
- **`packages/plugins/`** — Plugin SDK and examples
- **`doc/`** — Product specs, dev guide, DB docs. Read order: `GOAL.md` → `PRODUCT.md` → `SPEC-implementation.md` → `DEVELOPING.md` → `DATABASE.md`

### Key domain concepts

- **Company** — top-level entity with goals, org structure, budget, agents
- **Agents/Employees** — AI agents with adapter type, config, role, reporting lines
- **Issues** — hierarchical work items with atomic checkout semantics (single assignee)
- **Adapters** — pluggable agent runtimes; mutable registries allow dynamic registration
- **Approvals** — governance gates for critical actions
- **Heartbeats** — scheduled/event-triggered agent wake-ups
- **Budgets** — token spend limits with hard-stop auto-pause

### API conventions

- Base path: `/api`, all endpoints company-scoped
- Board access = full-control; agent access = bearer API keys (`agent_api_keys`), hashed at rest
- Mutations must log activity and return consistent HTTP errors (400/401/403/404/409/422/500)

## Engineering Rules

1. **Company-scoped** — every domain entity must enforce company boundaries in routes/services
2. **Synchronized contracts** — schema/API changes must update all layers: `packages/db` → `packages/shared` → `server` → `ui`
3. **Control-plane invariants** — single-assignee tasks, atomic checkout, approval gates, budget hard-stops, activity logging
4. **Strategic docs** — do not replace `doc/SPEC.md` or `doc/SPEC-implementation.md` wholesale; prefer additive updates
5. **Plan docs** — new plans go in `doc/plans/` with `YYYY-MM-DD-slug.md` naming

## Database Change Workflow

1. Edit `packages/db/src/schema/*.ts`
2. Export new tables from `packages/db/src/schema/index.ts`
3. `pnpm db:generate` (compiles `packages/db` first, then generates migration)
4. `pnpm typecheck` to validate

Note: `drizzle.config.ts` reads compiled schema from `dist/schema/*.js`.

## Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`. Do not commit it in pull requests.

## PR Requirements

Use `.github/PULL_REQUEST_TEMPLATE.md` — all sections required including **Model Used** and **Thinking Path**.
