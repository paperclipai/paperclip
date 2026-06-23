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

If using connection pooling, disable prepared statements:

```ts
// packages/db/src/client.ts
export function createDb(url: string) {
  const sql = postgres(url, { prepare: false });
  return drizzlePg(sql, { schema });
}
```

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.

## High-Volume Log Tables: Partitioning and Retention

Three tables receive the bulk of write traffic and historically accumulated
significant bloat under heavy autovacuum pressure:

| Table | Default retention | Env override |
|-------|-------------------|--------------|
| `activity_log` | 30 days | `PAPERCLIP_ACTIVITY_LOG_RETENTION_DAYS` |
| `heartbeat_run_events` | 14 days | `PAPERCLIP_HEARTBEAT_EVENTS_RETENTION_DAYS` |
| `agent_wakeup_requests` | 14 days | `PAPERCLIP_WAKEUP_REQUESTS_RETENTION_DAYS` |

The server runs a retention sweeper hourly (configurable via
`PAPERCLIP_LOG_RETENTION_INTERVAL_MS`; disable with
`PAPERCLIP_LOG_RETENTION_ENABLED=false`).

By default the sweeper uses bounded batched `DELETE` (5 000 rows per
statement) so legacy installs cap their growth without surprise.

### Converting to monthly range partitions (recommended for busy instances)

For instances where these tables grow into millions of rows, convert them to
monthly range partitions on `created_at`. Retention then becomes a cheap
`DROP PARTITION` instead of `DELETE` + autovacuum.

1. Apply the latest migrations (`0106_log_partition_helpers` installs the
   `paperclip_ensure_log_partition` / `paperclip_drop_old_log_partitions`
   helpers).
2. During a maintenance window, run the operator cutover script:

   ```sh
   # Embedded postgres
   psql "$(paperclipai postgres connection-string)" \
     -v ON_ERROR_STOP=1 -f server/scripts/partition-log-tables.sql

   # External postgres
   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f server/scripts/partition-log-tables.sql
   ```

   Each table is converted inside one transaction. The transaction holds
   `ACCESS EXCLUSIVE` while it runs (sub-second on small tables, longer on
   multi-million-row tables — schedule accordingly). The script drops the
   `heartbeat_runs.wakeup_request_id` foreign key because PostgreSQL does not
   permit FKs to a partitioned table unless the partition key participates in
   the referenced UNIQUE constraint.
3. After cutover the retention sweeper auto-detects the partitioned layout,
   ensures the next two months of partitions exist, and drops partitions
   whose upper bound is older than the configured retention window.
