---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

Paperclip uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.paperclip/instances/default/db/` for storage
2. Ensures the `paperclip` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.paperclip/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip
```

Push the schema:

```sh
DATABASE_URL=postgres://paperclip:paperclip@localhost:5432/paperclip \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy the connection string from Project Settings > Database
3. Set `DATABASE_URL` in your `.env`

Use the **direct connection** (port 5432) for migrations and the **pooled connection** (port 6543) for the application.

If your transaction-mode pooler does not support protocol-level named prepared statements, disable them via the environment:

```sh
DATABASE_PREPARED_STATEMENTS=false
```

For a direct connection or a pooler that supports named prepared statements,
`DATABASE_PREPARED_STATEMENTS=true` also prepares parameterized ORM queries and
queries inside transactions and reserved or dedicated connections. Check the
provider's configuration before you enable it. Preparation caches statement
metadata, not query results. Unset preserves the existing ORM behavior and the
driver default for tagged SQL. Explicit per-query options still apply.
Each database client prepares at most 1,000 distinct statements and skips
statements longer than 8 KB. If a prepared statement fails because the pooler's copy is
stale after a schema change or was lost, Paperclip stops preparing that
statement and retries it once unprepared.

Related optional client tuning: `DATABASE_POOL_MAX`, `DATABASE_IDLE_TIMEOUT_SECONDS`, `DATABASE_CONNECT_TIMEOUT_SECONDS`, `DATABASE_MAX_LIFETIME_SECONDS`, `DATABASE_APPLICATION_NAME`. Driver defaults apply when unset, except that idle pooled connections close after 60 seconds (`DATABASE_IDLE_TIMEOUT_SECONDS=0` keeps them open) and the server's main pool reports `application_name=paperclip:<boot id>` (other pools use names that start with `paperclip`). See [Connection pool settings](#connection-pool-settings).

## Connection Pool Settings

The server opens one postgres.js pool for its own queries (and a second one when `DATABASE_MIGRATION_URL` points at a different connection). Every setting is optional:

| Variable | Default | Effect |
|----------|---------|--------|
| `DATABASE_POOL_MAX` | `10` (driver) | Maximum pooled connections. |
| `DATABASE_IDLE_TIMEOUT_SECONDS` | `60` | Close a pooled connection after this much idle time. `0` keeps idle connections open forever (the driver default). |
| `DATABASE_CONNECT_TIMEOUT_SECONDS` | `30` (driver) | Give up on a connection attempt after this long. |
| `DATABASE_MAX_LIFETIME_SECONDS` | 30–60 min, randomized (driver) | Recycle a pooled connection once it is this old. |
| `DATABASE_APPLICATION_NAME` | `paperclip:<boot id>` (server main pool) | Value of `application_name` in `pg_stat_activity`. The boot id tells the sessions of each server process apart after a restart. Find Paperclip's backends with `SELECT * FROM pg_stat_activity WHERE application_name LIKE 'paperclip%';` |
| `DATABASE_DEDICATED_CONNECTION_MAX` | `24` | Dedicated lock connections in use at once per process before new callers wait. Nested callers do not wait. |
| `DATABASE_DEDICATED_CONNECTION_WAIT_MS` | `30000` | After this wait, a queued caller gets a dedicated connection over the limit. |
| `DATABASE_PREPARED_STATEMENTS` | Unset | `true` opts parameterized ORM queries into preparation. `false` disables preparation. Use `false` when the pooler does not support named statements. Unset preserves existing behavior. |

The server ends its pools during shutdown (SIGINT/SIGTERM) and when startup fails after the pool was opened, so a restarting server does not leave idle backends behind. Size `max_connections` on the PostgreSQL side for at least `DATABASE_POOL_MAX` per server process plus your other clients. Each server process also opens private pools and dedicated lock connections. With the defaults, one process can open up to 73 connections: `DATABASE_POOL_MAX` (10), 9 in private pools (lease renewal, checkpoints, file storage), 2 notification listeners, and up to 52 dedicated lock connections (`application_name=paperclip-workspace-finalization-lock`). `DATABASE_DEDICATED_CONNECTION_MAX` (default 24) bounds the dedicated connections in use; the worst case is twice that value plus 4 idle. Count all of these per process when you size `max_connections`, or lower `DATABASE_DEDICATED_CONNECTION_MAX` to fit.

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.

## Backups

`paperclipai db:backup` takes a one-off logical dump using the current config.

A database dump is never a complete deployment backup on its own — the secrets
master key and every run log live outside the database. What a backup covers, and
how to restore one, is in [Backup And Restore](/deploy/backup-restore).
