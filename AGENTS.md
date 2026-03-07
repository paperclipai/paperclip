# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

## 2. Read This First

Before making changes, read in this order:

1. `doc/GOAL.md`
2. `doc/PRODUCT.md`
3. `doc/SPEC-implementation.md`
4. `doc/DEVELOPING.md`
5. `doc/DATABASE.md`

`doc/SPEC.md` is long-horizon product context.
`doc/SPEC-implementation.md` is the concrete V1 build contract.

## 3. Repo Map

```
cli/                  paperclipai CLI (onboard, auth, configure)
server/               Hono API + orchestration services + adapters registry
ui/                   React + Vite dashboard
packages/
  db/                 Drizzle ORM schema, migrations, PGlite + Postgres clients
  shared/             Shared types, API path constants, validators (used by all packages)
  adapter-utils/      Shared adapter utilities
  adapters/
    claude-local/     Claude Code (spawns claude CLI)
    codex-local/      OpenAI Codex (spawns codex CLI)
    cursor-local/     Cursor (spawns cursor CLI)
    openclaw/         OpenClaw (SSE or webhook transport)
    opencode-local/   OpenCode (spawns opencode CLI)
    pi-local/         Pi (spawns pi CLI)
skills/               Runtime markdown skill files injected into agent context
doc/                  Internal dev docs (SPEC, GOAL, PRODUCT, DATABASE, DEVELOPING)
docs/                 Public API reference (Mintlify)
```

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset. See `.env.example` for all
available environment variables.

```sh
pnpm install
pnpm dev
```

This starts:

- API: `http://localhost:3100`
- UI: `http://localhost:3100` (served by API server in dev middleware mode)

Quick checks:

```sh
curl http://localhost:3100/api/health
curl http://localhost:3100/api/companies
```

Reset local dev DB:

```sh
rm -rf data/pglite
pnpm dev
```

## 5. Core Engineering Rules

1. Keep changes company-scoped.
Every domain entity should be scoped to a company and company boundaries must be enforced in routes/services.

2. Keep contracts synchronized.
If you change schema/API behavior, update all impacted layers:
- `packages/db` schema and exports
- `packages/shared` types/constants/validators
- `server` routes/services
- `ui` API clients and pages

3. Preserve control-plane invariants.
- Single-assignee task model
- Atomic issue checkout semantics
- Approval gates for governed actions
- Budget hard-stop auto-pause behavior
- Activity logging for mutating actions

4. Do not replace strategic docs wholesale unless asked.
Prefer additive updates. Keep `doc/SPEC.md` and `doc/SPEC-implementation.md` aligned.

## 6. Database Change Workflow

When changing data model:

1. Edit `packages/db/src/schema/*.ts`
2. Ensure new tables are exported from `packages/db/src/schema/index.ts`
3. Generate migration:

```sh
pnpm db:generate
```

4. Validate compile:

```sh
pnpm -r typecheck
```

Notes:
- `packages/db/drizzle.config.ts` reads compiled schema from `dist/schema/*.js`
- `pnpm db:generate` compiles `packages/db` first

## 7. How Adapters Work

Each adapter lives in `packages/adapters/<name>/` and has three entry points:

- `src/index.ts` — shared metadata: `type`, `label`, `models`, `agentConfigurationDoc`
- `src/server/` — server-side execution logic (`execute`, `testEnvironment`, `sessionCodec`)
- `src/ui/` — UI-side configuration components

Adapters are registered in `server/src/adapters/registry.ts`. The registry maps adapter
type strings (e.g. `claude_local`) to their `ServerAdapterModule` implementations.

Required exports from each adapter root (`src/index.ts`):
- `type` — unique string identifier (e.g. `"claude_local"`)
- `label` — human-readable name
- `models` — static model list (may be empty if `listModels` is used instead)
- `agentConfigurationDoc` — markdown string documenting all config fields

### Adding a New Adapter

1. Create `packages/adapters/<name>/` following the structure of an existing adapter
2. Implement `src/index.ts` (type, label, models, agentConfigurationDoc)
3. Implement `src/server/execute.ts`, `src/server/test.ts`, `src/server/parse.ts`
4. Implement `src/server/index.ts` (export execute, testEnvironment, sessionCodec)
5. Implement `src/ui/index.ts` for the config form component
6. Add to `server/src/adapters/registry.ts`
7. Add the package as a dependency in `server/package.json` and `cli/package.json`
8. Add COPY for `package.json` in Dockerfile deps stage
9. Write a `README.md` for the adapter package

## 8. Skill Injection

The `skills/` directory contains markdown files that are injected into agent context at
runtime. Skills teach agents how to interact with Paperclip (e.g. how to call the API,
how to format heartbeat responses). No model retraining is needed — skills are loaded
fresh on every agent run.

Some adapters also auto-inject skills into agent-specific skill directories at startup
(e.g. `~/.cursor/skills`, `~/.codex/skills`) so the agent CLI can discover them natively.

## 9. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
docker build .
```

If anything cannot be run, explicitly report what was not run and why.

## 10. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 11. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 12. Common Gotchas

- **Company scoping**: every query must filter by `companyId`. Missing this leaks data across companies.
- **PGlite vs Postgres**: leave `DATABASE_URL` unset for embedded PGlite (dev). Set it for external Postgres (production/Docker). Do not assume one or the other.
- **Non-root Docker user**: the container runs as `paperclip` (uid determined at build). Scripts that `exec` inside the container with `-u root` are intentional (for chown); agent work runs as `paperclip`.
- **pnpm workspace**: all internal packages use `workspace:*`. Do not use relative paths in imports — use the package name.

## 13. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, build, and `docker build .` pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
