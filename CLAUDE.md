# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Read First

Before non-trivial changes, read these in order. They are the build contract — `AGENTS.md` is treated as authoritative for engineering rules:

1. `AGENTS.md` — engineering rules, fork notes, PR template requirements
2. `doc/SPEC-implementation.md` — V1 build contract (controls when conflicting with `doc/SPEC.md`)
3. `doc/DEVELOPING.md` — full dev guide (worktree CLI, secrets, dev runner, smoke tests)
4. `doc/DATABASE.md` — embedded vs hosted Postgres modes

## Common Commands

```sh
pnpm install
pnpm dev              # API + UI in watch mode (UI served by API in dev middleware mode)
pnpm dev:once         # Same, no file watching; auto-applies pending migrations
pnpm dev:list         # Inspect the managed dev runner for this repo
pnpm dev:stop         # Stop the managed dev runner

pnpm typecheck        # Recursive workspace typecheck (preflight runs workspace-link check)
pnpm test             # Cheap default — Vitest only (alias of test:run)
pnpm test:watch       # Vitest watch mode
pnpm test:e2e         # Playwright (opt-in; only when touching browser flows)
pnpm test:release-smoke

pnpm build            # Recursive workspace build

pnpm db:generate      # Generate Drizzle migration from schema
pnpm db:migrate       # Apply migrations
pnpm db:backup
```

Run a single Vitest file: `pnpm exec vitest run path/to/file.test.ts` (or `-t "name"` to filter by test name). Vitest config lives at `vitest.config.ts` and aggregates per-package suites.

Full pre-handoff verification (per `AGENTS.md` §7):

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

`pnpm dev` and `pnpm dev:once` are idempotent per repo+instance — if a runner is already alive they report it instead of double-starting. Default endpoints: API + UI at `http://localhost:3100`; quick checks `curl http://localhost:3100/api/health` and `/api/companies`.

## Worktree Awareness

This repo uses worktree-local Paperclip instances (see `doc/DEVELOPING.md` "Worktree-local Instances"). When working inside `.paperclip/worktrees/<name>/`:

- `pnpm dev` requires `.paperclip/.env` — fails fast if missing. Run `pnpm paperclipai worktree init` first.
- Each worktree gets its own embedded Postgres data dir under `~/.paperclip-worktrees/instances/<id>/` and its own free port — do not point two workers at the same DB dir.
- Seeded routines with schedule triggers are paused by default in fresh worktree DBs.

## Architecture (Big Picture)

Paperclip is a control plane for AI-agent companies — a Node.js + Express REST server + React/Vite board UI, persistence via Drizzle ORM on Postgres (embedded PGlite/embedded Postgres in dev). The model is **company-scoped**: every domain entity belongs to exactly one company and routes/services must enforce that boundary.

### Workspaces

`pnpm-workspace.yaml`:

- `server/` — Express API, auth (better-auth), orchestration services, scheduler, realtime, storage. Entry: `server/src/index.ts`. Routes in `server/src/routes/`, business logic in `server/src/services/`, adapter glue in `server/src/adapters/`.
- `ui/` — React 19 + Vite + Tailwind v4 + shadcn/ui (new-york, neutral, OKLCH). Entry: `ui/src/main.tsx`, pages in `ui/src/pages/`. Served by the API in dev via Vite middleware (same origin as API).
- `cli/` — `paperclipai` binary (`npx paperclipai onboard`, `paperclipai worktree …`, `paperclipai issue …`, etc.).
- `packages/db/` — Drizzle schema, migrations, embedded-Postgres bootstrap, backup tooling. Schema files under `src/schema/`; **`drizzle.config.ts` reads compiled `dist/schema/*.js`**, so `pnpm db:generate` compiles `packages/db` first.
- `packages/shared/` — shared types, validators (zod), API path constants, adapter type machinery.
- `packages/adapters/` — first-party agent adapters: `claude-local`, `codex-local`, `cursor-local`, `gemini-local`, `opencode-local`, `pi-local`, `openclaw-gateway`. External adapters are loaded dynamically via `~/.paperclip/adapter-plugins.json`.
- `packages/adapter-utils/` — shared adapter helpers.
- `packages/plugins/` — plugin SDK and example plugins (`sdk`, `examples/`, `create-paperclip-plugin`).
- `packages/mcp-server/` — MCP server entry (`doc/TASKS-mcp.md`).

### Core invariants (enforce in every change)

These are the control-plane guarantees that all V1 code must preserve (`AGENTS.md` §5, `doc/SPEC-implementation.md` §8):

- **Company scoping** — every business record carries `company_id`; routes/services check it; agent API keys cannot read across companies.
- **Single assignee + atomic checkout** — `issues.assignee_agent_id` is unique per active claim; `in_progress` requires an assignee and goes through `POST /issues/:id/checkout`.
- **Approval gates** — board-governed actions (hires, strategy proposals, budget changes) flow through `approvals` and cannot be bypassed by agents.
- **Budget hard-stop auto-pause** — when monthly spend hits the limit, agents auto-pause; cost ingestion and rollups happen via `cost_events`.
- **Activity logging** — every mutating action writes to `activity_log` with company scope.
- **Issue state machine** — terminal states `done | cancelled`; transitions defined in `doc/SPEC-implementation.md` §8.2 with side effects (`started_at`, `completed_at`, `cancelled_at`).

### Contract sync rule

When you change schema or API behavior, update **all** layers in the same change (`AGENTS.md` §5.2):

`packages/db/schema` → `packages/db` exports → `packages/shared` types/validators/API path constants → `server/routes` + `server/services` → `ui/api` clients + `ui/pages`.

Skipping a layer is the most common source of breakage.

### Auth and API

- Base path: `/api`.
- Two actor models: **board** (session-based, full-control across companies in deployment) and **agent** (bearer API key in `agent_api_keys`, hashed at rest, scoped to one agent + one company).
- Deployment modes: `local_trusted` (implicit board) and `authenticated` (with `private/public` exposure). See `doc/DEPLOYMENT-MODES.md`.
- Errors return consistent HTTP codes (`400/401/403/404/409/422/500`).

### Adapter system

Server adapter registry (`server/src/adapters/registry.ts`) is mutable — `registerServerAdapter` / `unregisterServerAdapter` / `requireServerAdapter`. Plugins should not hardcode adapter imports; loader is dynamic. `createServerAdapter()` must include all optional fields, especially `detectModel`. UI adapter registry (`ui/src/adapters/registry.ts`) mirrors the same pattern. Shared adapter-type validation (`packages/shared/src/adapter-type.ts`) accepts any non-empty string at the schema layer; the **server registry is the source of truth** for "is this adapter actually registered?"

### Plan documents

Repo-level plan docs go in `doc/plans/` with `YYYY-MM-DD-slug.md` filenames. Issue-level plans are managed via the Paperclip `paperclip` skill (and the issue's `plan` document), not as repo markdown.

## Pull Requests

PRs **must** use `.github/PULL_REQUEST_TEMPLATE.md`. Required sections — do not invent your own structure:

- **Thinking Path** (5–8 step blockquote, top-down from project context to this change — see `CONTRIBUTING.md` for examples)
- **What Changed**, **Verification**, **Risks**
- **Model Used** — provider, exact model ID/version, context window, capabilities. "None — human-authored" if no AI.
- **Checklist** — all items checked

CI uses Greptile; merge requires 5/5 with comments addressed (`CONTRIBUTING.md`).

`pnpm-lock.yaml` is owned by GitHub Actions on `master`. **Do not commit `pnpm-lock.yaml` in PRs** (`doc/DEVELOPING.md` "Dependency Lockfile Policy").

Feature PRs against core may be closed without coordination — discuss in Discord `#dev` first or build as a plugin (`doc/plugins/PLUGIN_SPEC.md`).

## Definition of Done

1. Behavior matches `doc/SPEC-implementation.md`.
2. Typecheck, tests, build all pass.
3. Contracts synced across `db` / `shared` / `server` / `ui`.
4. Docs updated when behavior or commands change.
5. PR template fully filled in (including Model Used).
