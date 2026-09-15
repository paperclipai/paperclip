# Control-plane backup invariant: `postgresql-client` major == embedded PostgreSQL major

Status: accepted · Owner: CTO · Refs: SIN-70814 (critical outage), SIN-70818 (parent), SIN-70819 (board alert adapter), SIN-70820 (this preflight)

## Context

The control-plane runs an **embedded PostgreSQL** (`embedded-postgres@^18.1.0-beta.16`,
`packages/db/package.json` + `server/package.json`). The automatic database backup
shells out to the host's `pg_dump` (`packages/db/src/backup-lib.ts`, resolved via
`process.env.PAPERCLIP_PG_DUMP_PATH || "pg_dump"`).

`pg_dump` **refuses to dump a server whose major is newer than the client**
(`server version mismatch: pg_dump is version 16.x, server is version 18.x`). So the
moment the embedded major is bumped without also bumping the host `postgresql-client`,
the automatic backup dies — and, historically, dies **silently** (the scheduler
swallowed the error). This has now happened three times:

- SIN-65200 → SIN-70116 → **SIN-70814** (backup dead for 9 days, 2026-08-30 → 2026-09-08).

## Decision (the invariant — AC1)

> The host `postgresql-client` **major** MUST equal the embedded PostgreSQL **major**.

Every change to the embedded Postgres version MUST, in the **same change**:

1. Bump the host `postgresql-client` to the matching major, and
2. Verify `pg_dump --version` against the running server major
   (`<dataDir>/PG_VERSION`, where `dataDir` defaults to
   `~/.paperclip/instances/default/data`).

This invariant is enforced automatically at runtime by the preflight below, and is
part of the review checklist for any embedded-Postgres bump.

## Automated preflight (AC2)

`server/src/services/pgclient-version-preflight.ts` (wired in `server/src/index.ts`,
embedded mode only) resolves both authoritative version sources and compares their
majors:

- **Server major** — first line of `<dataDir>/PG_VERSION`.
- **Client major** — `pg_dump --version` of the resolved binary
  (`PAPERCLIP_PG_DUMP_PATH || "pg_dump"`).

The comparison is a pure, table-tested function (`comparePgMajor`); the preflight only
orchestrates the IO. It runs **once at boot** and then on the backup-health cadence
(`PAPERCLIP_DB_BACKUP_HEALTH_CHECK_INTERVAL_MINUTES`, default 60 min).

On divergence — or when `pg_dump` is missing (`ENOENT`) — it pushes a **LOUD**,
idempotent signal through the SIN-70819 board adapter (a board issue plus a structured
log), deduped by the stable fingerprint `control-plane-pgclient-major-mismatch`. When
the majors line up again, the open alert is resolved automatically.

It is deliberately **not** a boot hard-stop: the control-plane still comes up (only the
backup is at risk), so the preflight is read-only + alert. Rollback is trivial (revert
the change; no migration).

**Least privilege / OWASP A09:** only versions and the resolved binary path are ever
logged or written to the board. No connection string is touched.

## Recovery without root (AC3)

The engineer/agent cannot `apt install` without root. Paliative until the host's
`postgresql-client-18` is installed via apt:

```bash
# 1. Fetch the noble (Ubuntu 24.04) postgresql-client-18 .deb from apt.postgresql.org,
#    then unpack it into a user-writable prefix (no dpkg -i / no root):
mkdir -p "$HOME/pgclient18"
dpkg -x postgresql-client-18_*_amd64.deb "$HOME/pgclient18"

# 2. Point the backup at the unpacked pg_dump. Clear LD_LIBRARY_PATH so the binary's
#    own RPATH/loader wins (a stale LD_LIBRARY_PATH breaks the unpacked libs):
export PAPERCLIP_PG_DUMP_PATH="$HOME/pgclient18/usr/lib/postgresql/18/bin/pg_dump"
env -u LD_LIBRARY_PATH "$PAPERCLIP_PG_DUMP_PATH" --version   # expect: pg_dump (PostgreSQL) 18.x

# 3. Restart the control-plane so the preflight re-runs and the backup uses the v18 client.
```

The durable fix is to install `postgresql-client-18` via apt on the host and drop the
`PAPERCLIP_PG_DUMP_PATH` override; the preflight then confirms `ok` and resolves the
board alert.
