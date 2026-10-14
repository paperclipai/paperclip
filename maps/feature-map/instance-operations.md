---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":40}
---

# Instance operations

An operator can install and run Paperclip, diagnose the instance, configure supported deployment settings, manage its service, and produce a recoverable database backup.

Implementation: [CLI entry point](../../cli/src/index.ts), [instance settings](../../ui/src/pages/InstanceExperimentalSettings.tsx), [backup command](../../cli/src/commands/db-backup.ts).

Agent access: [companion](../agent-access-map/instance-operations.md).

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

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Use a disposable data directory/service identity. Do not update, restart, or restore over an unrelated live instance as a documentation test.

### `operator-cli`

Automated: [doctor](../../cli/src/__tests__/doctor.test.ts), [update command](../../cli/src/__tests__/update-command.test.ts), and [service manager](../../cli/src/__tests__/service-manager.test.ts) cover command contracts.

Manual: Inspect the selected installation/channel and configuration, start the isolated instance, confirm health and browser access, then stop that instance. For update changes, use the dry-run/check path first and verify installed version and rollback state on an owned disposable installation.

Routine HTTP monitoring may use `GET /api/liveness` (or `HEAD`). It returns only
process startup status and the public build commit without SQL or authentication.
It remains reachable during an idle drain. Use `/api/health` for explicit database
readiness, signed bootstrap, and authorized diagnostics; liveness does not
establish database health or claim a workspace.

### `settings-backup`

Automated: [experimental settings](../../ui/src/pages/InstanceExperimentalSettings.test.tsx) and [database backup routes](../../server/src/__tests__/instance-database-backups-routes.test.ts) cover their UI/API contracts.

Manual: Change a harmless experimental setting, reload, and confirm the affected route honors it. Back up a disposable instance, inspect the reported file and metadata, and restore using the documented procedure into a second isolated target. Verify a known record after restoration.

## Gotchas

- Source-checkout update/check commands report manual update guidance; they do
  not qualify a managed installation. Rollback restores retained CLI payloads,
  not database migrations. Service status applies to its selected service
  identity, not automatically to an owned foreground dev server.

- A successful backup write does not prove restoration works.
- Settings visibility and mutability differ for cloud-managed and self-hosted instances.
- Keep the three data paths distinct: first-party Telemetry, operator-configured OpenTelemetry, and local run logs.

### Storybook verification

#### `backup`

Scope: ui
Storybook: Mount shipped InstanceGeneralSettings in CompanySettings with daily/weekly/monthly retention presets, selected values, saving/error/loading and cloud-hidden controls. Backup creation and restore remain separate CLI/operator checks.
Production: PATCH /api/instance/settings/general must enforce instance settings authority and managed hidden fields, persist retention and survive reload. Separately inspect a real backup and restore a known record into a second disposable target; a successful write does not prove restoration.
Sources: Source: [InstanceGeneralSettings.tsx](../../ui/src/pages/InstanceGeneralSettings.tsx), [CompanySettings.tsx](../../ui/src/pages/CompanySettings.tsx), [instance-settings.ts](../../server/src/routes/instance-settings.ts), [db-backup.ts](../../cli/src/commands/db-backup.ts). Tests: [InstanceGeneralSettings.test.tsx](../../ui/src/pages/InstanceGeneralSettings.test.tsx), [instance-settings-routes.test.ts](../../server/src/__tests__/instance-settings-routes.test.ts), [instance-settings-managed-overlay.test.ts](../../server/src/__tests__/instance-settings-managed-overlay.test.ts), [instance-database-backups-routes.test.ts](../../server/src/__tests__/instance-database-backups-routes.test.ts)

#### `install-update`

Scope: cli
Storybook: No authored story required for install, channel selection, update or rollback command execution.
Production: Use an owned managed installation: check/dry-run, installed version, retained payload rollback and failure. Source-checkout guidance is a separate case; rollback does not undo database migrations.
Sources: Source: [index.ts](../../cli/src/index.ts), [install.ts](../../cli/src/commands/install.ts), [update.ts](../../cli/src/commands/update.ts). Tests: [install-command.test.ts](../../cli/src/__tests__/install-command.test.ts), [update-command.test.ts](../../cli/src/__tests__/update-command.test.ts)

#### `diagnostics`

Scope: cli
Storybook: No authored story required for doctor/health command results.
Production: Run doctor against an owned data directory; check readiness and nonzero failures. A listening port alone does not prove readiness; repair requires observing the repaired result.
Sources: Source: [doctor.ts](../../cli/src/commands/doctor.ts). Tests: [doctor.test.ts](../../cli/src/__tests__/doctor.test.ts)
