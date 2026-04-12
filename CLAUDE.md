# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

Paperclip is an open-source orchestration platform for autonomous AI companies. It coordinates AI agents (via adapters like Claude, Codex, Gemini, OpenCode) with a human oversight board through an Express API backend, React frontend, and PostgreSQL database.

## Common Commands

```sh
pnpm install              # Install all workspace dependencies
pnpm dev                  # Start API + UI in watch mode (auto-restarts on changes)
pnpm dev:once             # Start without file watching (auto-migrates DB)
pnpm dev:stop             # Stop the managed dev runner
pnpm build                # Build all packages
pnpm typecheck            # Type-check all packages
pnpm test:run             # Run all tests (vitest)
vitest run server         # Run tests for a single workspace
pnpm db:generate          # Generate DB migrations after schema changes
pnpm db:migrate           # Apply pending migrations
pnpm test:e2e             # Run Playwright end-to-end tests
```

Tailscale/private-auth dev: `pnpm dev --tailscale-auth` (binds 0.0.0.0, authenticated/private mode).

Docker quickstart: `docker compose -f docker/docker-compose.quickstart.yml up --build`

One-command bootstrap: `pnpm paperclipai run` (auto-onboard + doctor + start).

## Monorepo Structure

pnpm workspace. Key packages:

- **`server/`** — Express 5 API backend. Entry: `server/src/index.ts` → `server/src/app.ts` (routes, middleware, plugins).
- **`ui/`** — React 19 + Vite frontend. Served by the API server (same origin) in both dev and production.
- **`cli/`** — `paperclipai` CLI for setup, configuration, and client-side control-plane commands.
- **`packages/db/`** — Drizzle ORM schema, migrations, and DB utilities. Config at `packages/db/drizzle.config.ts`.
- **`packages/shared/`** — Shared types and constants used by server, UI, and CLI.
- **`packages/adapter-utils/`** — Common adapter utilities (quota probing, execution helpers).
- **`packages/adapters/*/`** — LLM adapter packages (claude-local, codex-local, cursor-local, gemini-local, opencode-local, pi-local, droid-local, openclaw-gateway). Each can export server/ui/cli modules.
- **`packages/plugins/sdk/`** — Plugin SDK for extending Paperclip with worker-based plugins.
- **`packages/mcp-server/`** — MCP server integration.

## Architecture

### Deployment Modes

Two modes with distinct auth behavior (see `doc/DEPLOYMENT-MODES.md`):

- **`local_trusted`** — Loopback-only, no login required. Default for dev.
- **`authenticated`** — Login required. Two exposure levels:
  - `private` — For private networks (Tailscale/VPN). Uses hostname allowlist guard.
  - `public` — Internet-facing. Requires explicit `PAPERCLIP_PUBLIC_URL`.

### Auth Stack

- **Board users**: Better Auth sessions (email/password). Config in `server/src/auth/better-auth.ts`.
- **Agents**: JWT tokens (`server/src/agent-auth-jwt.ts`) or API keys (SHA-256 hashed before storage).
- **Actor middleware** (`server/src/middleware/auth.ts`): Every request gets `req.actor` with `type: "board" | "agent" | "none"`.
- **Hostname guard** (`server/src/middleware/private-hostname-guard.ts`): Validates `Host`/`X-Forwarded-Host` against allowlist in private mode.
- **Mutation guard** (`server/src/middleware/board-mutation-guard.ts`): Origin/Referer validation for write operations.

### Database

- **Dev**: Embedded PostgreSQL auto-managed at `~/.paperclip/instances/default/db`. Leave `DATABASE_URL` unset.
- **Production**: Set `DATABASE_URL` for external PostgreSQL.
- **ORM**: Drizzle. Schema in `packages/db/src/schema/`. Migrations in `packages/db/src/migrations/`.
- After schema changes: `pnpm db:generate` then restart dev server.

### Plugin System

Worker-based plugin architecture: loader → lifecycle → job scheduler → tool dispatcher. Plugin SDK at `packages/plugins/sdk/`. Plugin routes, UI static serving, and event bus wired in `server/src/app.ts`.

### Storage

Local disk (default at `~/.paperclip/instances/default/data/storage`) or S3-compatible. Configured via `pnpm paperclipai configure --section storage`.

### Secrets

Local encrypted provider by default. Master key at `~/.paperclip/instances/default/secrets/master.key`. Strict mode (`PAPERCLIP_SECRETS_STRICT_MODE=true`) requires secret references for sensitive env keys.

## Key Environment Variables

- `DATABASE_URL` — External PostgreSQL connection string (omit for embedded)
- `BETTER_AUTH_SECRET` — Session auth secret (required for authenticated mode)
- `PAPERCLIP_AGENT_JWT_SECRET` — Separate JWT signing secret (falls back to BETTER_AUTH_SECRET with warning)
- `PAPERCLIP_DEPLOYMENT_MODE` — `local_trusted` or `authenticated`
- `PAPERCLIP_DEPLOYMENT_EXPOSURE` — `private` or `public`
- `PAPERCLIP_PUBLIC_URL` — Public-facing URL for the instance
- `PAPERCLIP_ALLOWED_HOSTNAMES` — Comma-separated additional allowed hostnames
- `PAPERCLIP_HOME` / `PAPERCLIP_INSTANCE_ID` — Override data directory and instance

## Dependency Lockfile Policy

GitHub Actions owns `pnpm-lock.yaml`. Do not commit lockfile changes in PRs. CI regenerates it on master pushes.

## PR Requirements

- Use the PR template at `.github/PULL_REQUEST_TEMPLATE.md`
- Include a "Thinking Path" (top-down reasoning from project → problem → fix)
- Include "Model Used" section (provider, model ID, context window)
- All tests must pass; Greptile review must score 5/5
- Bigger changes: discuss in Discord #dev first

## Docker Deployment

Production compose: `docker/docker-compose.yml`. Requires `.env` with `BETTER_AUTH_SECRET`, `PAPERCLIP_AGENT_JWT_SECRET`, `POSTGRES_PASSWORD`, and `PAPERCLIP_PUBLIC_URL`. Tailscale template: `docker/.env.tailscale.example`.

Build: `docker compose -f docker/docker-compose.yml build`
Run: `docker compose -f docker/docker-compose.yml up -d`

The Dockerfile installs `gh` (GitHub CLI), `vercel`, `claude-code`, `codex`, and `opencode-ai` globally.
