# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Paperclip is an orchestration control plane for autonomous AI agents. It coordinates teams of AI agents (Claude Code, Codex, Cursor, OpenClaw, etc.) to work on software projects, with company/org structure, heartbeat scheduling, cost tracking, board governance, and skill injection.

## Commands

```sh
# Install dependencies
pnpm install

# Development (API + UI on http://localhost:3100)
pnpm dev           # with file watching (auto-restart on changes)
pnpm dev:once      # without file watching

# Build
pnpm build         # build all packages
pnpm typecheck     # TypeScript type-check only

# Testing
pnpm test          # watch mode
pnpm test:run      # run once (CI)
pnpm test:e2e      # Playwright E2E tests

# Run a single test file
pnpm test:run server/src/__tests__/project-shortname-resolution.test.ts

# Database
pnpm db:generate   # generate new migration from schema changes
pnpm db:migrate    # apply pending migrations
pnpm db:backup     # manual backup
```

## Dependency Lockfile Policy

**Do not commit `pnpm-lock.yaml` in pull requests.** GitHub Actions owns the lockfile — it regenerates and commits it on pushes to `master`.

## Monorepo Structure

```
packages/
  shared/          # @paperclipai/shared — all TypeScript types, Zod validators, constants
  db/              # @paperclipai/db — Drizzle ORM schema, migrations, DB client
  adapter-utils/   # @paperclipai/adapter-utils — shared execution utilities for adapters
  adapters/
    claude-local/  # Claude Code agent adapter
    codex-local/   # Codex agent adapter
    cursor-local/  # Cursor agent adapter
    opencode-local/
    pi-local/
    openclaw-gateway/
server/            # Express API server
ui/                # React frontend (Vite + Tailwind)
cli/               # paperclipai CLI
skills/            # Agent skill markdown documents
tests/             # Playwright E2E tests
```

## Architecture

### Data Flow

The UI and CLI communicate with the Express server via `/api/*` REST endpoints and a WebSocket for live events. The server uses Drizzle ORM against PostgreSQL (embedded locally, external via `DATABASE_URL`). Adapters are loaded by the server to execute agent runs.

### Key Layers

**`packages/shared`** — Source of truth for types and validation. All types consumed by server, UI, and adapters live here. Add new types/validators here before using them elsewhere.

**`packages/db`** — Drizzle schema definitions in `src/schema/`, SQL migration files in `src/migrations/`. When changing schema: edit schema files → `pnpm db:generate` → commit the new SQL migration file.

**`server/src/`**:
- `routes/` — Express route handlers (thin, delegate to services)
- `services/` — Business logic (companies, agents, projects, issues, heartbeat, costs, etc.)
- `app.ts` — Express app factory
- `index.ts` — Server startup and initialization

**`ui/src/`** — React 19 with TanStack Query for data fetching, React Router for navigation, Tailwind CSS for styling.

**Adapters** — Each adapter under `packages/adapters/<name>/` exports four entry points: `.` (main), `./server`, `./ui`, `./cli`. The critical one is `src/server/execute.ts`, which implements the execution interface for running agents. All adapters depend on `@paperclipai/adapter-utils`.

### Multi-Company Isolation

The entire data model is scoped by `company_id`. Routes and services enforce company boundaries. Agents belong to companies, as do projects, issues, approvals, costs, etc.

### Heartbeat Model

Agents don't run continuously — they wake on a schedule, check for work (assigned issues, approvals needed, etc.), execute, and report back. The `server/src/services/heartbeat.ts` service drives this loop.

### Skill Injection

Before an agent run, the server injects skill documents (from `skills/`) into the agent's context so it knows how to call the Paperclip API. The `paperclip` skill is always injected and gives agents access to the control plane.

## Local Dev Notes

- **No external database needed.** Embedded PostgreSQL auto-initializes at `~/.paperclip/instances/default/db`.
- Reset local DB: `rm -rf ~/.paperclip/instances/default/db` then `pnpm dev`.
- Health check: `curl http://localhost:3100/api/health`
- When developing from multiple git worktrees, use `pnpm paperclipai worktree:make <name>` to create an isolated instance — never point two servers at the same embedded DB directory.

## Testing Conventions

- Test files live in `src/__tests__/*.test.ts` within each package/app.
- Uses Vitest (not Jest). Config in root `vitest.config.ts` with per-package project configs.
- Integration tests hit real logic — avoid mocking internal services unless necessary.
