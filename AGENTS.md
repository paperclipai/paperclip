# AGENTS.md

Guidance for human and AI contributors working in this repository.

## 1. Purpose

Paperclip is a control plane for AI-agent companies.
The current implementation target is V1 and is defined in `doc/SPEC-implementation.md`.

### Fork Context

This repo (`namastexlabs/paperclip`) is a fork of `paperclipai/paperclip`.
We maintain multiuser features (permissions, auth, mentions, avatars) ahead of upstream.

Remotes:
- `origin` — `namastexlabs/paperclip` (our fork)
- `upstream` — `paperclipai/paperclip` (upstream)

PRs for upstream contribution target `upstream/master` via branches pushed to `origin`.

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

- `server/`: Express REST API and orchestration services
- `ui/`: React + Vite board UI
- `packages/db/`: Drizzle schema, migrations, DB clients
- `packages/shared/`: shared types, constants, validators, API path constants
- `doc/`: operational and product docs

## 4. Dev Setup (Auto DB)

Use embedded PGlite in dev by leaving `DATABASE_URL` unset.

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

5. Keep plan docs dated and centralized.
New plan documents belong in `doc/plans/` and should use `YYYY-MM-DD-slug.md` filenames.

## 6. Database Change Workflow

### Fork Migration Numbering

Our fork carries migrations that don't exist upstream yet. When syncing with upstream:

1. **Check upstream's latest index:** `git show upstream/master:packages/db/src/migrations/meta/_journal.json | python3 -c "import json,sys; j=json.load(sys.stdin); print(j['entries'][-1]['idx'], j['entries'][-1]['tag'])"`
2. **Our fork migrations must always come AFTER upstream's latest.** If upstream is at 0034, our migrations start at 0035.
3. **After merging upstream:** renumber our fork-only SQL files, snapshots, and journal entries. Steps:
   - Rename `NNNN_<name>.sql` to new index
   - Rename `meta/NNNN_snapshot.json` to match
   - Update `meta/_journal.json` entries (idx + tag)
   - For data-only migrations (INSERTs), copy the previous snapshot (schema unchanged)
   - For schema migrations (ALTER TABLE), add the new column to the snapshot JSON
4. **Never** leave orphan `.sql` files outside the journal — drizzle ignores them but they confuse contributors.
5. **Current fork-only migrations:**
   - `0035_owner_permission_backfill` — grants all permission keys to existing owners (data-only)
   - `0036_company_image` — adds `image` column to companies table
   - These numbers will change on next upstream sync if upstream adds migrations past 0034.

### Schema Changes

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

## 7. Verification Before Hand-off

Run this full check before claiming done:

```sh
pnpm -r typecheck
pnpm test:run
pnpm build
```

If anything cannot be run, explicitly report what was not run and why.

## 8. API and Auth Expectations

- Base path: `/api`
- Board access is treated as full-control operator context
- Agent access uses bearer API keys (`agent_api_keys`), hashed at rest
- Agent keys must not access other companies

When adding endpoints:

- apply company access checks
- enforce actor permissions (board vs agent)
- write activity log entries for mutations
- return consistent HTTP errors (`400/401/403/404/409/422/500`)

## 9. UI Expectations

- Keep routes and nav aligned with available API surface
- Use company selection context for company-scoped pages
- Surface failures clearly; do not silently ignore API errors

## 10. Definition of Done

A change is done when all are true:

1. Behavior matches `doc/SPEC-implementation.md`
2. Typecheck, tests, and build pass
3. Contracts are synced across db/shared/server/ui
4. Docs updated when behavior or commands change
