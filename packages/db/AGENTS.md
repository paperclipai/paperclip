# AGENTS.md — @paperclipai/db

Database layer for Paperclip. Drizzle ORM on top of PostgreSQL with support for both external Postgres and an in-process embedded Postgres instance.

## Commands

```bash
pnpm run typecheck          # check-migration-numbering + tsc --noEmit
pnpm run build              # check-migration-numbering + tsc + cp migrations to dist
pnpm run generate           # generate a new migration (see CRITICAL note below)
pnpm run migrate            # run pending migrations against the configured DB
pnpm run seed               # seed demo data (requires DATABASE_URL)
pnpm test                   # run vitest tests (requires embedded-postgres support)
```

**CRITICAL — `generate` requires a compiled dist first.**
`drizzle.config.ts` reads from `./dist/schema/*.js`, not from source. Always run `tsc` (or `pnpm build`) before `pnpm run generate`, otherwise drizzle-kit will see an empty or stale schema.

## Migration Rules

`check-migration-numbering.ts` runs as a pre-flight before build, typecheck, and generate. It will hard-fail if any of these are violated:

1. Every SQL file must start with a 4-digit sequential number prefix (e.g. `0058_...`).
2. No duplicate numbers — even across differently-named files.
3. The `src/migrations/meta/_journal.json` must list **exactly the same files in the same order** as the `.sql` files on disk.

When adding a migration:
- The file name must be the next sequential number (currently `0058_...`).
- drizzle-kit's `generate` updates `_journal.json` automatically, so don't hand-edit it unless you also manually create the SQL file.
- Snapshot files in `src/migrations/meta/` may have gaps — that's normal and fine.

## Database Connection Resolution

`resolveDatabaseTarget()` in `src/runtime-config.ts` resolves the DB in this priority order:

1. `DATABASE_URL` environment variable
2. `DATABASE_URL` in the `.env` file located next to the resolved config file
3. `database.connectionString` in `config.json` when `database.mode === "postgres"`
4. Embedded Postgres fallback (default port `54329`, data dir `~/.paperclip/instances/default/db`)

Config file is located by:
- `PAPERCLIP_CONFIG` env var (explicit path)
- Walking up ancestor directories looking for `.paperclip/config.json`
- `~/.paperclip/instances/{PAPERCLIP_INSTANCE_ID}/config.json` (default instance: `default`)

Embedded Postgres credentials are always `paperclip:paperclip`, database name `paperclip`.

## Schema Conventions

- One file per table under `src/schema/`, exported from `src/schema/index.ts`, then re-exported from `src/index.ts`.
- All PKs are UUIDs (`uuid().primaryKey().defaultRandom()`).
- Timestamps use `{ withTimezone: true }` and default to `now()`.
- JSONB columns use `.$type<T>()` to attach a TypeScript type.
- Every table with meaningful query patterns has explicit `index()` declarations in the table's second argument. Composite indexes name convention: `{table}_{col1}_{col2}_idx`.
- Conditional/partial unique indexes are used for business-logic uniqueness (e.g. `issues_open_routine_execution_uq` only applies to active statuses).
- Text enum columns are typed with `.$type<"value1" | "value2">()` — there are no Postgres enum types in this schema.
- Self-referencing FKs use the `(): AnyPgColumn => table.id` lambda form.

## Custom Migration Runner

The package does **not** simply call drizzle-kit's migrator. `src/client.ts` contains a hand-rolled migration engine that handles:

- **Idempotent replay**: each migration statement is checked against `information_schema` (tables, columns, indexes, constraints) before applying, so a partially-applied migration can be retried safely.
- **History reconciliation** (`reconcilePendingMigrationHistory`): if a migration's DDL is already present but the journal row is missing, it inserts the missing row rather than replaying destructive SQL.
- **Journal format compatibility**: works with both `hash`-only and `name`+`hash` column layouts in `drizzle.__drizzle_migrations`, supporting databases migrated from older drizzle versions.

The migrator only uses drizzle-kit's built-in `migratePg` for the very first migration run on a completely empty database. After that it drives migrations itself.

## Testing

Tests use a real embedded Postgres instance spun up per test (`startEmbeddedPostgresTestDatabase`). The suite auto-detects support and skips gracefully if the host can't run embedded-postgres (ARM Macs, some CI environments).

Test timeouts are explicitly set to `20_000` ms to accommodate embedded-postgres startup time.

Pattern used throughout `client.test.ts`:
```ts
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
```

Cleanup is registered in an `afterEach` array and called after each test, so each test gets a fresh database.

## Backup System

`src/backup-lib.ts` implements a custom SQL dump (not pg_dump). Key details:

- Output format: `{prefix}-YYYYMMDD-HHMMSS.sql.gz` (gzip-compressed custom SQL)
- Statements separated by a UUID-tagged breakpoint marker (not `;`), allowing reliable streaming restore
- Tiered retention pruning: daily → weekly → monthly, configured via `BackupRetentionPolicy`
- `nullifyColumns` option can redact sensitive column data in the backup
- Restore uses `SET LOCAL session_replication_role = replica` to bypass FK checks during bulk INSERT replay

## Module System

The package is pure ESM (`"type": "module"`). All internal imports use `.js` extensions even when importing `.ts` source files — this is required for ESM compatibility and must be maintained when adding new imports.

## Public API (`src/index.ts`)

Key exports:
- `createDb(url)` → drizzle instance with full schema
- `inspectMigrations(url)` / `applyPendingMigrations(url)` / `reconcilePendingMigrationHistory(url)` — migration inspection and execution
- `ensurePostgresDatabase(url, name)` — idempotent DB creation
- `startEmbeddedPostgresTestDatabase(prefix)` — for tests that need a real DB
- `runDatabaseBackup` / `runDatabaseRestore` — backup utilities
- All schema tables via `export * from "./schema/index.js"`

## Domain Model Overview

The schema models a multi-tenant AI agent platform:

- **Companies** → top-level tenant, has budget tracking and issue prefix
- **Agents** → AI workers belonging to a company, report-to hierarchy, adapter config, budget
- **Projects / Goals** → organize work; issues belong to a project and optionally a goal
- **Issues** → core work unit; tracks status, assignee (agent or user), execution run, origin (manual/routine/etc.), request depth for sub-issues
- **Heartbeat runs** → execution tracking for agents; issues reference these for checkout and execution
- **Routines / Routine triggers / Routine runs** → scheduled/webhook-triggered recurring tasks
- **Plugins** → extensibility system with manifest JSON, per-company settings and state
- **Auth** (Better Auth pattern) → `user`, `session`, `account`, `verification` tables in `auth.ts`
- **Workspaces** → project workspaces and execution workspaces for agent task environments
- **Budget incidents / Cost events / Finance events** → cost tracking and enforcement
