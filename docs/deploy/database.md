---
title: Database
summary: Embedded PGlite vs Docker Postgres vs hosted
---

ValAdrien OS uses PostgreSQL via Drizzle ORM. There are three ways to run the database.

## 1. Embedded PostgreSQL (Default)

Zero config. If you don't set `DATABASE_URL`, the server starts an embedded PostgreSQL instance automatically.

```sh
pnpm dev
```

On first start, the server:

1. Creates `~/.valadrien-os/instances/default/db/` for storage
2. Ensures the `valadrien-os` database exists
3. Runs migrations automatically
4. Starts serving requests

Data persists across restarts. To reset: `rm -rf ~/.valadrien-os/instances/default/db`.

The Docker quickstart also uses embedded PostgreSQL by default.

## 2. Local PostgreSQL (Docker)

For a full PostgreSQL server locally:

```sh
docker compose up -d
```

This starts PostgreSQL 17 on `localhost:5432`. Set the connection string:

```sh
cp .env.example .env
# DATABASE_URL=postgres://valadrien_os:valadrien_os@localhost:5432/valadrien_os
```

Push the schema:

```sh
DATABASE_URL=postgres://valadrien_os:valadrien_os@localhost:5432/valadrien_os \
  npx drizzle-kit push
```

## 3. Hosted PostgreSQL (Supabase)

For production, use a hosted provider like [Supabase](https://supabase.com/).

1. Create a project at [database.new](https://database.new)
2. Copy **pooler** connection strings from Project Settings → Database → Connect
3. Set env vars on your host (Vercel, Docker, etc.)

### Vercel (reference operator stack)

Vercel serverless functions use **IPv4 only**. Do **not** set `DATABASE_URL` to the direct host `db.[ref].supabase.co` when that host has no IPv4 `A` record — you will see `getaddrinfo ENOTFOUND`.

Use Supabase **Supavisor pooler** on `aws-0-[REGION].pooler.supabase.com`:

| Variable | Pooler mode | Port |
| -------- | ----------- | ---- |
| `DATABASE_URL` | Transaction pooler | **6543** |
| `DATABASE_MIGRATION_URL` | Session pooler (when `VALADRIEN_OS_MIGRATION_AUTO_APPLY=true`) | **5432** |

Username format: `postgres.[PROJECT-REF]`.

Example:

```text
DATABASE_URL=postgresql://postgres.nzbwmlvxnzfhqaznyggw:[PASSWORD]@aws-0-us-west-2.pooler.supabase.com:6543/postgres
DATABASE_MIGRATION_URL=postgresql://postgres.nzbwmlvxnzfhqaznyggw:[PASSWORD]@aws-0-us-west-2.pooler.supabase.com:5432/postgres
```

See [troubleshooting.md](./troubleshooting.md) and [doc/DATABASE.md](../../doc/DATABASE.md).

### Other hosts (Docker, ECS, long-running Node)

Use transaction pooler (6543) for runtime and session pooler (5432) for migrations when auto-apply is enabled. Long-running servers may also use direct `db.[ref].supabase.co` **only if** the host resolves IPv4 or supports IPv6.

If using transaction pooling at runtime, disable prepared statements in the client when required (see `packages/db` client configuration).

## Switching Between Modes

| `DATABASE_URL` | Mode |
|----------------|------|
| Not set | Embedded PostgreSQL |
| `postgres://...localhost...` | Local Docker PostgreSQL |
| `postgres://...supabase.com...` | Hosted Supabase |

The Drizzle schema (`packages/db/src/schema/`) is the same regardless of mode.
