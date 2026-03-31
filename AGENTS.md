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
  sdk/           # Plugin SDK (definePlugin, testing, bundlers)
  playwright-mcp/ # Browser automation plugin (10 tools)
  ruflo-bridge/  # Ruflo MCP bridge plugin (9 tools)
  skills-hub/    # Agent skills plugin (12 tools)
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

## Plugin Development

### Plugin SDK Commands

```sh
# SDK typecheck and tests
pnpm --filter @paperclipai/plugin-sdk typecheck
pnpm --filter @paperclipai/plugin-sdk test

# Plugin E2E lifecycle tests (no Postgres required)
pnpm test -- plugin-e2e-lifecycle
```

### Autonomous Validation

Plugin system has automated hourly validation via cron:

```sh
# Manual validation
./scripts/validate-plugins.sh

# Install cron job (hourly validation)
sudo ./scripts/install-cron.sh

# View logs
tail -f /var/log/paperclip-plugin-validation.log

# JSON reports
ls /tmp/paperclip-plugin-validation-*.json
```

**Validation steps (7 total, ~30s):**
1. Script self-tests
2. SDK typecheck
3. SDK unit tests (131 tests)
4. E2E lifecycle tests (30 tests, no Postgres)
5. Plugin typecheck (playwright-mcp, ruflo-bridge, skills-hub)
6. Plugin build
7. Documentation validation

### Plugin Validation Checklist

1. **Discovery:** Plugin in `packages/plugins/<name>` with valid `package.json`
2. **Build:** `dist/worker.js` compiled and < 1MB
3. **Tools:** Manifest declares tools, worker implements each
4. **Docs:** README.md with usage examples
5. **Tests:** SDK unit tests + E2E lifecycle tests

See `doc/plugins/PLUGIN_SPEC.md` and `doc/plugins/PLUGIN_AUTHORING_GUIDE.md` for full spec.

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
