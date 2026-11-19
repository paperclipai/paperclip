# Database

How to run Paperclip against PostgreSQL, change the schema, and write migrations.

This file holds database setup and the rules that apply to every schema change.
It is not a record of individual tables or features. The schema in
`packages/db/src/schema/` and its tests describe those. Put a note about one
feature's tables in that feature's doc, or leave it in the PR description.

## 1. Embedded PostgreSQL — zero config

If you don't set `DATABASE_URL`, the server automatically starts an embedded PostgreSQL instance and manages a local data directory.

```sh
pnpm dev
```

That's it. On first start the server:

1. Creates a `~/.paperclip/instances/default/db/` directory for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically for empty databases
4. Starts serving requests

Data persists across restarts in `~/.paperclip/instances/default/db/`. To reset local dev data, delete that directory.

If you need to apply pending migrations manually, run:

```sh
pnpm db:migrate
```

When `DATABASE_URL` is unset, this command targets the current embedded PostgreSQL instance for your active Paperclip config/instance.

This mode is ideal for local development and one-command installs.

Docker note: the Docker quickstart image also uses embedded PostgreSQL by default. Persist `/paperclip` to keep DB state across container restarts (see `doc/DOCKER.md`).

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally, use the included Docker Compose setup:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Then set the connection string:

```sh
cp .env.example .env
# .env already contains:
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Run migrations:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  pnpm db:migrate
```

Start the server:

```sh
pnpm dev
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted PostgreSQL provider. [Supabase](https://supabase.com/) is a good option with a free tier.

### Setup

1. Create a project at [database.new](https://database.new)
2. Go to **Project Settings > Database > Connection string**
3. Copy the URI and replace the password placeholder with your database password

### Connection string

Supabase offers two connection modes:

**Direct connection** (port 5432) — use for migrations and one-off scripts:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

**Connection pooling via Supavisor** (port 6543) — use for the application:

```
postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
```

### Configure

For the application runtime, use a direct PostgreSQL connection unless the database client has explicit prepared-statement configuration for your pooling mode:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If you later run the app with a pooled runtime URL, set `DATABASE_MIGRATION_URL` to the direct connection URL. Paperclip uses it for startup schema checks/migrations and plugin namespace migrations, while the app continues to use `DATABASE_URL` for runtime queries:

```sh
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@aws-0-[REGION].pooler.supabase.com:5432/postgres
```

If your transaction-mode pooler does not support protocol-level named prepared statements, set `DATABASE_PREPARED_STATEMENTS=false`. If your pooler supports them, you can opt in with `DATABASE_PREPARED_STATEMENTS=true`. Check your provider's pooler configuration before you enable this setting. Keep `DATABASE_MIGRATION_URL` on a direct connection. Do not edit database client source files as part of deployment setup.

### Push the schema

```sh
# Use the direct connection (port 5432) for schema changes
DATABASE_URL=postgres://postgres.[PROJECT-REF]:[PASSWORD]@...5432/postgres \
  pnpm db:migrate
```

### Free tier limits

- 500 MB database storage
- 200 concurrent connections
- Projects pause after 1 week of inactivity

See [Supabase pricing](https://supabase.com/pricing) for current details.

## Client tuning (optional)

All of these are optional; when unset, the driver defaults apply and behavior is unchanged — typical self-hosted setups need none of them:

```sh
DATABASE_PREPARED_STATEMENTS=false   # use false when the pooler does not support named prepared statements
DATABASE_POOL_MAX=25                 # connection pool size; default: 10
DATABASE_IDLE_TIMEOUT_SECONDS=60     # close idle pooled connections; default: 60 (0 = keep open)
DATABASE_CONNECT_TIMEOUT_SECONDS=10  # default: 30
DATABASE_MAX_LIFETIME_SECONDS=1800   # recycle a pooled connection after this long; default: 30-60 min (random)
DATABASE_APPLICATION_NAME=paperclip  # application_name in pg_stat_activity; default for the server's main pool: paperclip:<boot id>
```

The server names its main pool `paperclip:<boot id>`, so after a restart the
sessions of each server process can be told apart in `pg_stat_activity`. When a
run's event, process identity, or event-write operation stays unfinished for
30 seconds, the server logs one warning per stalled run ("runner event intake
stalled"). The warning lists the pending operations of each run, the pool size,
the database sessions per application name and state, and the sessions that
wait for a lock or hold one (`pg_blocking_pids`, query text without literals,
cut to 160 characters). It also logs the event-loop lag. A second line
("runner event intake stall cleared") records when the operation finished. The
check runs only while an operation is pending, and it reads `pg_stat_activity`
only when it reports a stall.

`withDedicatedDbConnection` gives an action exclusive use of one session outside
the main pool (application name `paperclip-workspace-finalization-lock`). Each
`createDb` owner keeps released single-connection clients idle for reuse: always
up to `DEDICATED_CONNECTION_IDLE_MAX` (4), and more while idle plus in-use
clients stay within `DATABASE_DEDICATED_CONNECTION_MAX`, so a recurring burst
reuses the sessions the previous burst opened instead of reconnecting. They
follow the same idle timeout and max lifetime as the main pool, so a retained
client closes its session after `DATABASE_IDLE_TIMEOUT_SECONDS` without use. At most `DATABASE_DEDICATED_CONNECTION_MAX`
(default 24) dedicated clients are in use at once per owner. A caller that
finds the limit reached waits in a first-in, first-out queue. A caller that
already holds a dedicated client, or runs inside an open transaction of the
same process, is admitted at once, because its wait could deadlock with the
holder that it blocks. A caller that holds another bounded resource that a
holder can need passes `{ admitWithoutWaiting: true }` for the same reason; the
skill package store does this while it holds one of its package I/O permits
(at most 2 storage and 2 response permits). Such callers can take the in-use
count above the limit.
A caller that waits longer than `DATABASE_DEDICATED_CONNECTION_WAIT_MS`
(default 30000) is admitted over the limit, so a lock cycle that the database
cannot see ends in a delay, not a hang. A connection whose action throws is
closed, never reused. Actions must keep
session state transaction-scoped (`pg_advisory_xact_lock`,
`set_config(..., true)`). Like the main pool, a retained session sees an
`ALTER DATABASE` or `ALTER ROLE ... SET` change only after it reconnects; a test
that changes such a setting calls `closeDedicatedDbConnections` first. Shutdown
and ending the owner client close the idle set.

Connections per server process, at most (`databaseConnectionBudget` in
`packages/db/src/client.ts` computes this, and a test keeps it equal to the
pool settings):

| Source | Connections |
| --- | --- |
| Main pool | `DATABASE_POOL_MAX` (driver default 10) |
| Private pools: controller lease 2, legacy controller lease 1, controller-instance lease 1, runner checkpoint 3, file storage 2 | 9 |
| Notification listeners: plugin lifecycle 1, deployment notifications 1 | 2 |
| Dedicated clients: 2 x `DATABASE_DEDICATED_CONNECTION_MAX` in use (one nested client per holder) + 4 idle | 52 with the default limit |
| Total with defaults | 73 |

A separate `DATABASE_MIGRATION_URL` adds a second owner with its own pools.
Admission over the limit after the wait bound can exceed this total.

An explicit `DATABASE_PREPARED_STATEMENTS=true` enables named prepared statements
for parameterized ORM queries, transactions, reserved connections, and dedicated
clients. Postgres.js manages the statement cache. This does not cache query
results. Bound values and returned data stay fresh. Explicit per-query options
still apply, including `prepare: false` and simple-protocol execution. With the
setting unset, ORM queries keep their existing unprepared behavior and tagged
SQL uses the driver default. With `false`, preparation stays disabled.

With `true`, a database client and its private pools prepare at most 1,000
distinct SQL texts, and never a text longer than 8 KB; other texts run
unprepared. A transaction-mode pooler
(PgBouncer 1.22 or later, Neon `-pooler` hosts) shares prepared statements by
SQL text across clients, so after a migration changes a column type, the
pooler's statement for an affected text keeps failing with `cached plan must
not change result type` for every client and every process. When a statement
fails with that error, `prepared statement does not exist` (26000), or a
duplicate statement name (42P05), the client stops preparing that text for the
rest of the process and retries once without preparation. A pooled statement
is retried on its own. When the failed statement is the first one that the
transaction ran (after `SET TRANSACTION` only), the client rolls back, begins
again with the same options, repeats the `SET TRANSACTION` statements, and runs
the statement unprepared on the same connection. The transaction callback does
not run again and receives the result. A later statement in a transaction, or a
statement in a savepoint, is not retried, so that transaction or savepoint fails
once for each affected text in each process. `preparedStatementStats(db)`
reports the prepared texts and the unprepared, demoted, retried, and restarted
counts.

## Switching between modes

The database mode is controlled by `DATABASE_URL`:

| `DATABASE_URL` | Mode |
|---|---|
| Not set | Embedded PostgreSQL (`~/.paperclip/instances/default/db/`) |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

Your Drizzle schema (`packages/db/src/schema/`) stays the same regardless of mode.

## Schema change workflow

When you change the data model:

1. Edit `packages/db/src/schema/*.ts`.
2. Export each new table from `packages/db/src/schema/index.ts`.
3. Generate the migration from the repository root:

   ```sh
   pnpm db:generate
   ```

4. Validate that everything compiles:

   ```sh
   pnpm -r typecheck
   ```

`pnpm db:generate` compiles `packages/db` first, because
`packages/db/drizzle.config.ts` reads the compiled schema from `dist/schema/*.js`.
Then update every layer that the change affects: `packages/shared` types and
validators, `server` routes and services, and `ui` API clients and pages.

### Migration compatibility with the running release

Paperclip Cloud starts a new release while the previous one is still serving
against the same database. Every migration is therefore classified by
`packages/db/src/migration-compatibility.ts` as one of:

| Class | Meaning | Examples |
| --- | --- | --- |
| `online_compatible` | The previous release keeps working and no lock is held for long. A deployer applies it without a pause. | `CREATE TABLE` and anything on a table created in the same migration, `CREATE INDEX CONCURRENTLY`, `ADD COLUMN` that is nullable or has a constant default, `ADD CONSTRAINT ... NOT VALID`, `CREATE TYPE`, `ALTER TYPE ... ADD VALUE` |
| `requires_staging` | The previous release breaks or its writes are rejected. Ship it in two releases: expand first, contract later. | `DROP TABLE`/`DROP COLUMN`, renames, `ALTER COLUMN ... TYPE`, `SET NOT NULL`, `DROP DEFAULT`, a `NOT NULL` column without a default, a validated `CHECK`, a `UNIQUE` constraint or unique index on an existing table, `TRUNCATE`, `DELETE` |
| `unknown` | The classifier cannot prove either. This includes every statement it does not recognize and every lock or duration hazard (reason codes starting with `lock_hazard_`). | plain `CREATE INDEX` on an existing table, a validated foreign key on an existing table, `VALIDATE CONSTRAINT`, `UPDATE` backfills, procedural `DO` blocks, `CREATE OR REPLACE FUNCTION`, triggers on existing tables, `DROP INDEX`, `DROP CONSTRAINT` |

A migration takes the worst class of its statements. Lock and duration hazards
are `unknown`, not compatible with a warning.

A table counts as created in the migration when the statement is a plain
`CREATE TABLE`, or a `CREATE TABLE IF NOT EXISTS` for a table that no earlier
migration created. `IF NOT EXISTS` on a table from an earlier migration proves
nothing, so later statements on that table are judged as changes to an existing
table.

`drizzle-kit` emits validated foreign keys and plain indexes. For an existing
table, edit the generated SQL: append `NOT VALID` to the foreign key, and use
`CREATE INDEX CONCURRENTLY IF NOT EXISTS`.

PostgreSQL rejects `CONCURRENTLY` inside a transaction, and the migrator runs
each migration file in one transaction. A migration that uses `CONCURRENTLY`
must therefore be listed in `MIGRATIONS_WITH_TOP_LEVEL_STATEMENTS` in
`packages/db/src/client.ts`, and every statement in it must be idempotent,
because a failed run starts again from the first statement. The pull-request
guard fails a new `CONCURRENTLY` migration that is not in that list.

**The rule for a new migration.** A pull request fails when a migration it adds
is `unknown`. Rewrite the migration, split it into expand and contract
migrations, or, when you have verified the migration yourself, state the class
in the first lines of the migration file:

```sql
-- paperclip:migration-compat online_compatible: <why the previous release keeps working and no lock is held long>
```

Use `requires_staging` in place of `online_compatible` when the previous
release cannot run against the migration. The justification is mandatory. The
override is read only from the migration file, so it is reviewed with the SQL
and travels with it. A contract migration (for example the `DROP COLUMN` that
follows an expand release) always classifies as `requires_staging`; mark it
`online_compatible` this way once no running release uses the column.
`requires_staging` does not fail the pull request yet; it prints a notice.

Check a migration locally:

```sh
cd packages/db
pnpm exec tsx scripts/migration-compatibility.ts src/migrations/0468_busy_wendell_rand.sql
pnpm exec tsx scripts/migration-compatibility.ts            # distribution over all migrations
pnpm exec tsx scripts/migration-compatibility.ts --check    # the pull-request guard
```

The guard runs in `check:migrations` (so in the `@paperclipai/db` typecheck and
build) against the merge base with `origin/master`, and in the pull-request
policy job through `.github/scripts/check-pr-migration-order.mjs`. Migrations
that were already on `master` when the classifier shipped are not annotated.

Deployers read the result from the cloud migrator manifest
(`cloud-migrators/v1/<sha>/manifest.json`, built by
`scripts/cloud-migrator-artifacts.mjs`). Its `migrationCompatibility.migrations`
array lists every packed migration in journal order with `idx`, `tag`,
`sqlSha256` (the hash the migrator records in the migration history),
`compatibility`, `classified` (the classifier's verdict before an override),
`override`, `overrideJustification`, and `reasons`.

## Migration authoring checklist

Older embedded databases can use `SQL_ASCII`. Test encoding-sensitive SQL on
both `SQL_ASCII` and UTF-8 databases.

The 0126 issue comment attribution backfill showed the failure mode this checklist is meant to prevent: each batch looked for the next rows with an unindexed predicate, so PostgreSQL repeatedly scanned the same table and the migration became O(n²) as the table grew.

When authoring migrations or one-time backfills:

- Create the supporting index for the batch predicate before the backfill loop runs.
- Bound batches by an indexed key, such as an id range or keyset pagination cursor. Do not use `OFFSET` pagination or a query shape that re-scans already-visited rows each batch.
- Avoid unbounded full-table `UPDATE` or `DELETE` statements. Add a selective predicate and process rows in bounded batches when table size can be large.
- Use `CREATE INDEX CONCURRENTLY` for large existing tables when the migration can run outside a transaction and must avoid long write locks.
- Split schema changes, index creation, and data backfill into separate phases so each step has clear locking and rollback behavior.
- Treat the `check:migrations` CI gate as the enforcement backstop for these rules. If it flags a migration, rewrite the migration or add a suppression comment with the indexed predicate, batch bound, and reason the remaining scan is safe.

## Migration snapshots

`drizzle-kit generate` diffs `packages/db/src/schema/` against the newest snapshot in `packages/db/src/migrations/meta/`. That snapshot must describe the schema that every migration produces when they run in order. A snapshot that drifts from the schema makes the *next* migration wrong, because `generate` folds the drift into it. The drift can add a column that an earlier migration already created, which makes that migration fail on a fresh database. It can also drop a column that the schema still uses.

- Create every migration with `pnpm --filter @paperclipai/db generate`. Do not hand-write a snapshot.
- Do not hand-edit a snapshot to resolve a merge conflict. Renumber your migration and run `generate` again, as `packages/db/.gitattributes` describes.
- The repo keeps only the newest 5 snapshots. `generate` runs `prune:snapshots` afterwards to delete older ones. Drizzle only reads the newest snapshot, and each snapshot is a full copy of the schema (over 1 MB each). Older snapshots are still in git history.
- `packages/db/src/migration-snapshot-drift.test.ts` is the enforcement backstop. It repeats the diff that `generate` performs and fails when the newest snapshot no longer matches `packages/db/src/schema/`.

## Connection loss and retries

The database client does not replay arbitrary statements after a disconnect.
PostgreSQL may have committed a statement before the connection loses its
response. The postgres.js message `write CONNECTION_CLOSED` does not prove
that the statement was never sent: the driver also uses it when an in-flight
query loses its connection. SQL text cannot establish replay safety either;
a `SELECT` can call a function with side effects.

The affected operation fails and a new operation can reconnect through the
pool. Callers may retry only when the complete operation is idempotent or has
a durable receipt that prevents duplicate effects. Some transient statement
failures therefore reach the caller instead of being retried automatically.

When a database connection closes, its transaction fails. Paperclip does not
replay that transaction. New requests can use a fresh connection from the pool.
Queries from the failed transaction must keep failing, even after the pool
reconnects.

## Transaction-aware delivery work signals

Durable delivery queues, including plugin resource lifecycle events, use process-local work signals to avoid empty
polling. Register work **before** writing a queue row, on that row's transaction:

```ts
await db.transaction(async tx => {
  await signalDatabaseWork(tx, "queue-topic");
  await tx.insert(existingQueueTable).values(row);
});
```

`createDb` instruments transaction callbacks and nested savepoints. Subscribers
receive intent immediately and settlement only after the outer transaction
finishes. Caller-owned transactions therefore need no extra post-commit wrapper.
Dedicated clients from `withDedicatedDbConnection` share the owner's signal
scope. No schema changes, triggers, dedicated listener connection, or periodic
queries are installed by this API.

The first registered write in a transaction fetches `pg_current_xact_id()`.
Awaiting registration is required: a failure at that point must prevent the
queue write. Unrelated transactions add no queries. If the transaction rejects,
the coordinator probes `pg_xact_status(xid)` through the root pool before scanning
the queue. An in-progress transaction remains unresolved even when the queue
currently looks empty. Committed/aborted results permit reconciliation; NULL
means PostgreSQL has discarded an old, no-longer-active transaction's outcome.
The existing durable queue supplies the work in either case. Probe failures
retain the idle hold and schedule another attempt. Work signals never replay
queries or convert a failed database operation into success.

This uses PostgreSQL's transaction-information functions (this path requires
PostgreSQL 14+; embedded PostgreSQL uses 18). See the
[PostgreSQL transaction information documentation](https://www.postgresql.org/docs/18/functions-info.html#FUNCTIONS-PG-SNAPSHOT).
The process-local intent survives coordinator replacement, but not process exit.
Startup scans recover committed queue rows. Independent DB clients, other
processes, late transactions from an old process, and database failover need an
explicit ownership/wake protocol; these signals are not cross-process messaging.
Use the same root client for in-process writers. New queue insertion paths must
register before writing, or they can remain unseen until the next startup or
another notification. Tests should verify both the producer and its outer
transaction boundary.

## Plugin database namespaces

The plugin runtime tracks plugin-owned database namespaces and migrations in `plugin_database_namespaces` and `plugin_migrations`. Hosted deployments that separate runtime and migration connections should set `DATABASE_MIGRATION_URL`; plugin namespace migration work uses the migration connection when present.

## Backups

Paperclip supports automatic and manual logical database backups. These dumps include
non-system database schemas such as `public`, the Drizzle migration journal, and
plugin-owned database schemas. See `doc/database-backups.md` for the current
`paperclipai db:backup` / `pnpm db:backup` commands and backup retention
configuration.

Database backups do not include non-database instance files such as local-disk
uploads, workspace files, or the local encrypted secrets master key. Back those paths
up separately when you need full instance disaster recovery.

## More documentation

| Area | Doc |
| --- | --- |
| Automatic backups and restore | [database-backups.md](database-backups.md) |
| Response-size diagnostics, the postgres.js patch, transaction memory | [database-client-internals.md](database-client-internals.md) |
| Remote workspace snapshot storage | [workspace-storage.md](workspace-storage.md#experimental-remote-workspace-snapshots) |
| Execution admission tables | [server/src/modules/README.md](../server/src/modules/README.md#execution-admission-accounting) |
