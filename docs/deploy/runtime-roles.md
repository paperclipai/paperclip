# Paperclip runtime roles

Paperclip runtime hosts must declare exactly one role before they run:

- `primary`
- `api-only`
- `scheduler-only`
- `staged`

Default application behavior remains `primary` when `PAPERCLIP_RUNTIME_ROLE` is unset, so existing local and production installs keep their current behavior. Deployment policy is stricter:

> No host may run against the production Paperclip database unless `PAPERCLIP_RUNTIME_ROLE` is explicit, logged at startup, visible in `/api/health`, and validated by `scripts/ops/paperclip-runtime-role-preflight.sh`.

## Roles

`primary` is the full runtime. It can serve API/UI, run heartbeat and routine scheduling, run startup recovery, start plugin jobs and plugin workers, auto-install bundled plugins, run startup reconciliation/backfills, flush feedback exports, schedule database backups, and apply migrations according to the existing migration env flags.

`api-only` serves API/UI without work-producing background systems. It disables heartbeat scheduling, routine scheduling, startup recovery, startup reconciliation, plugin job scheduling, plugin workers, bundled plugin auto-install, feedback export flushing, scheduled database backups, and migration apply.

`staged` is the safest secondary-host validation mode. It has the same background disablement as `api-only` and is intended for loopback or private staged checks before cutover. Use this for `paperclipapi` while it is pointed at the production database but not yet the active runtime.

`scheduler-only` allows scheduler and worker systems, but keeps primary-only startup reconciliation/backfills, database backup scheduling, feedback export flushing, and migration apply disabled. It is for a future split-host topology and should remain privately reachable until the API exposure model is deliberately reviewed.

## Secondary host example

For a staged secondary host such as `paperclipapi`:

```sh
PAPERCLIP_RUNTIME_ROLE=staged
HOST=127.0.0.1
PORT=3100
PAPERCLIP_MIGRATION_PROMPT=never
PAPERCLIP_MIGRATION_AUTO_APPLY=false
PAPERCLIP_DB_BACKUP_ENABLED=false
PAPERCLIP_TELEMETRY_DISABLED=1
PAPERCLIP_OPEN_ON_LISTEN=false
```

The staged host must stay out of DNS, Vercel, public routing, Tailscale ACL routing, and production traffic until cutover is approved.

## Health contract

`GET /api/health` includes:

- `runtime.runtimeRole`
- `runtime.heartbeatSchedulerEnabled`
- `runtime.routineSchedulerEnabled`
- `runtime.pluginSchedulerEnabled`
- `runtime.pluginWorkersEnabled`
- `runtime.pluginAutoInstallEnabled`
- `runtime.databaseBackupSchedulerEnabled`
- `runtime.startupRecoveryEnabled`
- `runtime.startupReconciliationEnabled`
- `runtime.migrationMode`
- `buildCommit` when available

These fields contain no secrets or raw env values.

## Preflight

Run preflight after the service is listening and before routing traffic:

```sh
PAPERCLIP_RUNTIME_ROLE=staged \
  scripts/ops/paperclip-runtime-role-preflight.sh \
  --url http://127.0.0.1:3100 \
  --production-db-host 100.87.125.126
```

For `api-only` and `staged`, preflight fails if any scheduler, plugin worker, plugin auto-install, startup recovery/reconciliation, backup scheduler, or migration apply path is enabled.

## Active-active warning

Do not run two `primary` hosts against the same production database. Paperclip still needs durable scheduler ownership, distributed leases, and queue-claiming metrics before active-active can be safe.

During cutover, exactly one host may own work-producing systems. Keep the old primary available for rollback, but do not let it and the new primary both run as producers.

## Rollback

If a secondary host reports an unexpected role or enabled producer:

```sh
systemctl stop paperclipapi.service
systemctl is-enabled paperclipapi.service
journalctl -u paperclipapi.service -n 200 --no-pager
```

Keep the unit disabled at boot during staging:

```sh
systemctl disable paperclipapi.service
```

Then revert routing to the known-good primary if a cutover had already begun.
