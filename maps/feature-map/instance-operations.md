---
navigation: {"section":"Oversight and operation","sectionOrder":70,"order":40}
---

# Instance operations

An operator can install and run Paperclip, diagnose the instance, configure supported deployment settings, manage its service, and produce a recoverable database backup.

Feature ID: `instance-operations`.

Implementation: [CLI entry point](../../cli/src/index.ts), [instance settings](../../ui/src/pages/InstanceExperimentalSettings.tsx), [backup command](../../cli/src/commands/db-backup.ts).

Agent access: [companion](../agent-access-map/instance-operations.md).

## Sub-features

- `install-update`: `instance-operations/install-update` — inspect install channel/version and apply supported update or rollback operations.
- `server-service`: `instance-operations/server-service` — start/stop the intended instance and inspect its service health.
- `configuration`: `instance-operations/configuration` — configure database, server binding, storage, secrets, and available experimental settings.
- `diagnostics`: `instance-operations/diagnostics` — use doctor/health output to distinguish readiness from a listening port.
- `backup`: `instance-operations/backup` — create and inspect backups and verify restore only into a separate disposable target.
- `runtime-setup`: `instance-operations/runtime-setup` — install verified Pi/Cursor runtime assets, stage pending Antigravity assets on macOS ARM64, or import a release-matched Linux Pi companion into an owned published installation.

## How to get to it (user POV)

### `operator-cli`

Use `paperclipai install`, `run`, `service`, `doctor`, `configure`, `channels`, or `update --help` for the intended operation.

### `settings-backup`

Use currently visible instance settings for experiments/access and `paperclipai db:backup --help` for one-off backup. Some legacy general-settings URLs redirect.

### `runtime-provisioning`

On an owned published server installation, use `paperclipai runtime setup pi`, `paperclipai runtime setup cursor`, `paperclipai runtime setup antigravity`, or `paperclipai runtime import-remote <companion-directory> --sha256 <trusted-companion-json-digest>`. Run as the OS user operating that installation; this is separate from source-checkout dependency installation. Antigravity setup stages a pinned patched macOS ARM64 runtime; it remains unavailable for tasks until native acceptance passes.

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

Deployment routing uses public `GET /api/ready` (or `HEAD`). It returns 200 only
after startup recovery finishes and 503 while starting, recovering, or draining.
The probe reads in-memory state without SQL or session resolution. Local
[readiness tests](../../server/src/__tests__/liveness.test.ts) establish that
boundary; hosted overlap and active-run continuity require separate qualification.

Automated: [static UI idle completion](../../server/src/__tests__/static-ui-idle.test.ts)
covers real aborted file streams, disconnects before file lookup, nested routers,
and unfinished parent/fallback writes. Mounted Express applications retain their
conservative hold. It does not qualify provider cleanup or a hosted sleep/wake cycle.

Manual: On an otherwise idle disposable instance, close a static UI download
served by the admitted application before it finishes. Repeat with a disconnect
before headers arrive. Confirm that neither leaves a permanent request hold. An
unfinished application write must still prevent sleep after its client leaves.

Automated: [historical cleanup](../../server/src/__tests__/historical-cleanup-verification.test.ts)
exercises the runtime inspection path for failed Cloud sandbox leases, including
verification leases without a run. A signed cleanup-only absence observation
can remove this blocker without changing failed outcomes or granting run
continuation. An unresolved provider resource still prevents idle sleep.
Manual: on an owned Cloud staging workspace, confirm the exact published build,
reconcile failed test allocations, then verify actual provider suspension and
normal hosted entry after wake. Local tests do not prove that hosted journey.

### `settings-backup`

Cloud startup reads nonsecret application choices from a private, versioned
PostgreSQL singleton after a bounded one-time legacy config seed. A fresh
process and different home restore the saved choices without consulting a stale
`.env` file. Invalid saved data or an unavailable database prevents startup;
saved telemetry opt-out applies before client creation. The
[database controls](../../server/src/__tests__/cloud-runtime-config.test.ts) and
[startup-order controls](../../server/src/__tests__/server-startup-feedback-export.test.ts)
cover these local boundaries. See [field ownership](../../doc/cloud-runtime-configuration.md).
These controls do not qualify a deployed Cloud rollout or durable file storage.

Automated: [experimental settings](../../ui/src/pages/InstanceExperimentalSettings.test.tsx) and [database backup routes](../../server/src/__tests__/instance-database-backups-routes.test.ts) cover their UI/API contracts.

Cloud migration: in one maintenance window, stop legacy file writers and run the
[configuration/package qualification command](../../doc/cloud-configuration-migration.md).
Inspect its database receipt, update a saved preference, then repeat against a
second owned application/image root with the first home unavailable. Use an
explicit package evidence digest for same-package comparison. Confirm stale
qualification and missing legacy files cannot clear blockers. This recipe covers
configuration/packages and does not qualify whole-server zero downtime, secret
bytes, or volume removal. [Local PostgreSQL evidence path](../../server/src/__tests__/cloud-configuration-migration-postgres.test.ts)
includes a real fixture worker; it does not establish a hosted replacement.

Managed adapters: change a visible adapter preference as an instance admin,
then use a second application process against the same disposable database to
confirm catalog and new-agent selection reflect it. Verify saved agents remain
usable. Restart with an operator adapter declaration, confirm its effective
list, and reject conflicting toggles. Remove the declaration and confirm saved
preferences return. [Database tests](../../server/src/services/adapter-settings-postgres.test.ts)
cover local persistence, concurrent writers, audit rollback, and failure responses;
[local compatibility tests](../../server/src/services/adapter-settings-local.test.ts)
cover the legacy file. No deployed walkthrough is claimed.

Manual: Change a harmless experimental setting, reload, and confirm the affected route honors it. Back up a disposable instance, inspect the reported file and metadata, and restore using the documented procedure into a second isolated target. Verify a known record after restoration.

Cloud staging: On a managed `*.staging.paperclip.app` instance, verify experiments
are visible, Cloud-enabled controls are locked on, and other experiments are
editable by a Cloud stack Admin or instance admin with changes surviving reload.
With an old stored false value and a Cloud true value, verify the effective
setting is true and an API attempt to disable it returns 403 without saving.
Repeat the enabled-feature check on production and managed stacks without a hostname.
As a stack Admin, verify a harmless experiment saves while general instance
settings and task-drain operations remain denied. Demote that user to Member
and verify the next experimental write is denied.
Production keeps its hidden controls and managed feature values. Staging retains
other Cloud restrictions. [Settings policy tests](../../server/src/__tests__/instance-settings-managed-overlay.test.ts),
[route tests](../../server/src/__tests__/instance-settings-routes.test.ts), and
[health tests](../../server/src/__tests__/health.test.ts) exercise simulated Cloud
identities and persistence; they do not establish a deployed staging walkthrough.

### `runtime-provisioning`

Automated: [Runtime commands](../../cli/src/__tests__/runtime.test.ts), [setup](../../cli/src/__tests__/runtime-setup.test.ts), [remote Pi companion](../../server/src/__tests__/remote-pi-companion.test.ts), and [Pi package provisioning](../../packages/paperclip-runner/scripts/provision-pi-package.test.mjs) cover parsing, fixtures, package identity, and integrity. They do not qualify every published installation or live provider.

Manual: Use a disposable published installation and its exact runtime release. Run setup for the intended host runtime, inspect verified version/path, and repeat to confirm the existing installation is reused. Test a corrupt, linked, or foreign installation and verify rejection preserves unrelated files. Import a matching Linux x64 Pi companion with an independently trusted manifest digest; repeat for verified_existing, then alter manifest, inventory, source/profile identity, or target files and verify failure without replacing unrelated state. Inspect cleanup/cancellation. Finally use the selected adapter/account to run a bounded task separately: installed bytes do not prove model execution.

Sources: [Runtime CLI](../../cli/src/commands/runtime.ts), [instance-config bypass](../../cli/src/index.ts), [Pi provisioning](../../packages/paperclip-runner/scripts/provision-pi.mjs), [Cursor provisioning](../../packages/paperclip-runner/scripts/provision-cursor.mjs), and [companion importer](../../server/src/services/native-runtime/remote-pi-companion.ts).

Antigravity: [provisioning](../../packages/paperclip-runner/scripts/provision-antigravity.mjs),
[closure/integrity regressions](../../packages/paperclip-runner/scripts/materialize-antigravity-distribution.test.mjs),
and [pending admission tests](../../packages/paperclip-runner/src/drivers/acpx/antigravity-models.test.ts).
Exercise public-layout setup and verify both native files and cleanup; separately
verify that configuration/API/driver/sidecar reject the pending provider. These
checks do not establish authenticated task execution.

## Gotchas

- Runtime setup operates on a published installation and verifies package assets. It is not a substitute for an account connection, environment qualification, or a useful task run.

- Source-checkout update/check commands report manual update guidance; they do
  not qualify a managed installation. Rollback restores retained CLI payloads,
  not database migrations. Service status applies to its selected service
  identity, not automatically to an owned foreground dev server.

- A successful backup write does not prove restoration works.
- Settings visibility and mutability differ for cloud-managed and self-hosted instances.
- Keep the three data paths distinct: first-party Telemetry, operator-configured OpenTelemetry, and local run logs.

### Storybook verification

#### `backup`

Capability ID: `instance-operations/backup`.

Scope: ui
Storybook: Mount shipped InstanceGeneralSettings in CompanySettings with daily/weekly/monthly retention presets, selected values, saving/error/loading and cloud-hidden controls. Backup creation and restore remain separate CLI/operator checks.
Production: PATCH /api/instance/settings/general must enforce instance settings authority and managed hidden fields, persist retention and survive reload. Separately inspect a real backup and restore a known record into a second disposable target; a successful write does not prove restoration.
Sources: Source: [InstanceGeneralSettings.tsx](../../ui/src/pages/InstanceGeneralSettings.tsx), [CompanySettings.tsx](../../ui/src/pages/CompanySettings.tsx), [instance-settings.ts](../../server/src/routes/instance-settings.ts), [db-backup.ts](../../cli/src/commands/db-backup.ts). Tests: [InstanceGeneralSettings.test.tsx](../../ui/src/pages/InstanceGeneralSettings.test.tsx), [instance-settings-routes.test.ts](../../server/src/__tests__/instance-settings-routes.test.ts), [instance-settings-managed-overlay.test.ts](../../server/src/__tests__/instance-settings-managed-overlay.test.ts), [instance-database-backups-routes.test.ts](../../server/src/__tests__/instance-database-backups-routes.test.ts)

#### `install-update`

Capability ID: `instance-operations/install-update`.

Scope: cli
Storybook: No authored story required for install, channel selection, update or rollback command execution.
Production: Use an owned managed installation: check/dry-run, installed version, retained payload rollback and failure. Source-checkout guidance is a separate case; rollback does not undo database migrations.
Sources: Source: [index.ts](../../cli/src/index.ts), [install.ts](../../cli/src/commands/install.ts), [update.ts](../../cli/src/commands/update.ts). Tests: [install-command.test.ts](../../cli/src/__tests__/install-command.test.ts), [update-command.test.ts](../../cli/src/__tests__/update-command.test.ts)

#### `diagnostics`

Capability ID: `instance-operations/diagnostics`.

Scope: cli
Storybook: No authored story required for doctor/health command results.
Production: Run doctor against an owned data directory; check readiness and nonzero failures. Instance operators can inspect `GET /api/instance/task-drain?upgradeReadiness=1` before a compatible app replacement. Verify that unknown or unsupported executions prevent readiness and that the read does not hold admission; separately prove same-run continuity through an actual upgrade. A listening port alone does not prove readiness; repair requires observing the repaired result.
Sources: Source: [doctor.ts](../../cli/src/commands/doctor.ts). Tests: [doctor.test.ts](../../cli/src/__tests__/doctor.test.ts)
