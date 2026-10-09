# Installation, configuration, updates, and backups

An operator can install and run Paperclip, diagnose the instance, configure supported deployment settings, manage its service, and produce a recoverable database backup.

Implementation: [CLI entry point](../cli/src/index.ts), [instance settings](../ui/src/pages/InstanceExperimentalSettings.tsx), [backup command](../cli/src/commands/db-backup.ts).

## Sub-features

- `install-update`: inspect install channel/version and apply supported update or rollback operations.
- `server-service`: start/stop the intended instance and inspect its service health.
- `configuration`: configure database, server binding, storage, secrets, and available experimental settings.
- `diagnostics`: use doctor/health output to distinguish readiness from a listening port.
- `backup`: create and inspect backups and verify restore only into a separate disposable target.

## How to get to it (user POV)

### `operator-cli`

Use `paperclipai install`, `run`, `service`, `doctor`, `configure`, `channels`, or `update --help` for the intended operation.

### `settings-backup`

Use currently visible instance settings for experiments/access and `paperclipai db:backup --help` for one-off backup. Some legacy general-settings URLs redirect.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable data directory/service identity. Do not update, restart, or restore over an unrelated live instance as a documentation test.

### `operator-cli`

Automated: [doctor](../cli/src/__tests__/doctor.test.ts), [update command](../cli/src/__tests__/update-command.test.ts), and [service manager](../cli/src/__tests__/service-manager.test.ts) cover command contracts.

Manual: Inspect the selected installation/channel and configuration, start the isolated instance, confirm health and browser access, then stop that instance. For update changes, use the dry-run/check path first and verify installed version and rollback state on an owned disposable installation.

### `settings-backup`

Automated: [experimental settings](../ui/src/pages/InstanceExperimentalSettings.test.tsx) and [database backup routes](../server/src/__tests__/instance-database-backups-routes.test.ts) cover their UI/API contracts.

Manual: Change a harmless experimental setting, reload, and confirm the affected route honors it. Back up a disposable instance, inspect the reported file and metadata, and restore using the documented procedure into a second isolated target. Verify a known record after restoration.

## Gotchas

- A successful backup write does not prove restoration works.
- Settings visibility and mutability differ for cloud-managed and self-hosted instances.
- Keep the three data paths distinct: first-party Telemetry, operator-configured OpenTelemetry, and local run logs.
