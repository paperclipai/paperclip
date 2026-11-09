# Installation, configuration, updates, and backups — agent access

Product map: [Installation, configuration, updates, and
backups](../feature-map/instance-operations.md).

Feature ID: `instance-operations`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `install-update`

Capability ID: `instance-operations/install-update`.

Review: `baseline`.

API: `not-applicable` — No uniform company REST updater API. Treat pre-start
installation as an operator exception or design an explicit delegated operator API.

Agent access: `operator-only` — Existing CLI install/update/rollback commands.

Policy: Local machine operator and instance-administrator authority; distinct from
company-scoped agent keys.

Evidence: `source-only` — [implementation](../../cli/src/index.ts#L91) at the reviewed
commit above.

Verification: `not-run` — exercise the listed local workflow in an authorized, owned
operator environment. Verify its isolation and result; do not count local machine
authority as company-agent API access.

Gaps: No uniform company REST updater API. Treat pre-start installation as an operator
exception or design an explicit delegated operator API.

## `server-service`

Capability ID: `instance-operations/server-service`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/health`.

Agent access: `operator-only` — Existing CLI service/dev controls; health REST; owned
workspace services have separate agent APIs.

Policy: Local machine operator and instance-administrator authority; distinct from
company-scoped agent keys.

Evidence: `source-only` — [implementation](../../cli/src/index.ts#L91) at the reviewed
commit above.

Verification: `not-run` — exercise the listed local workflow in an authorized, owned
operator environment. Verify its isolation and result; do not count local machine
authority as company-agent API access.

Gaps: Instance start/stop and task workspace start/stop are different capabilities.
Local service control is not agent company authority.

## `configuration`

Capability ID: `instance-operations/configuration`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/instance/settings`.
- `PATCH /api/instance/settings`.
- `GET /api/instance/settings/experimental`.
- `PATCH /api/instance/settings/experimental`.

Agent access: `restricted` — Board/admin instance settings; CLI configure/env; local
configuration files.

Policy: Local machine operator and instance-administrator authority; distinct from
company-scoped agent keys.

Evidence: `source-only` — [implementation](../../cli/src/index.ts#L91) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Settings APIs cover parts of configuration; pre-start database/binding/storage
configuration is local operator tooling.

Cloud stack Admins may update experimental settings through the trusted Cloud
actor without receiving other instance-admin powers. This uses the current
stack role on each request; company membership alone does not grant it.
Members, Support users, agents, and ordinary self-hosted sessions remain denied.
Cloud staging exposes experimental controls to instance admins and stack Admins.
It permits saved overrides of Cloud-disabled experimental defaults. Cloud-enabled
features remain true on every managed stack, including staging, and the settings
service rejects attempts to disable them with 403 before saving.
This exception requires a managed instance
and a provisioner-supplied `*.staging.paperclip.app` primary hostname; request
headers do not establish staging. Ordinary board members and agents still cannot
mutate instance settings. Only an explicit feature allowlist is editable on staging. Cloud
owner-admin elevation and managed-sandbox execution policy remain managed, and
production policy and other Cloud floors remain.
Local [route tests](../../server/src/__tests__/instance-settings-routes.test.ts)
cover stack Admin experiment access and auditing, denial for other instance
controls and actor sources, hidden-setting restrictions, and a spoofed request hostname;
the [Cloud actor tests](../../server/src/middleware/cloud-tenant-actor.test.ts)
cover role changes and preserved instance-admin isolation;
no live Cloud or agent-credential verification is claimed.

## `diagnostics`

Capability ID: `instance-operations/diagnostics`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/health`.
- `GET /api/liveness` and `HEAD /api/liveness` — public process startup status
  and build commit only; no database readiness or workspace identity.

Liveness is anonymous and runs before actor/session resolution. Hostname and
signed-bootstrap endpoint validation still apply. It grants no instance control
authority. [Liveness tests](../../server/src/__tests__/liveness.test.ts) cover idle
drain, invalid ambient credentials, unavailable SQL, and startup recovery with
local Express fixtures; no live provider or agent access is claimed.

Agent access: `partial` — REST health plus local CLI doctor.

Policy: Local machine operator and instance-administrator authority; distinct from
company-scoped agent keys.

Evidence: `source-only` — [implementation](../../cli/src/index.ts#L91) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Health is an API; full local doctor/repair inspects host configuration and is not
equivalent to that response.

## `backup`

Capability ID: `instance-operations/backup`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/instance/database-backups`.

Agent access: `restricted` — Board/admin backup API; local CLI db:backup; restore into
an authorized separate target.

Policy: Local machine operator and instance-administrator authority; distinct from
company-scoped agent keys.

Evidence: `source-only` — [implementation](../../cli/src/index.ts#L91) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: API creation exists. Restore/lifecycle are operator workflows rather than ordinary
company agent capabilities.

## `runtime-setup`

Capability ID: `instance-operations/runtime-setup`.

Review: `baseline`.

API: `not-applicable` — these commands provision an operator-owned published package and local filesystem cache. They have no company-domain REST equivalent and deliberately bypass instance config, environment, and credential initialization.

Agent access: `operator-only` — explicit host/package provisioning through the runtime CLI, with the installed release’s verified assets. A company agent grant does not authorize another host’s installation or private operator cache.

Policy: Host setup verifies public pinned assets without model calls and requires the published server package layout/identity. Import requires a trusted manifest digest, exact installed source/profile identity, Linux x64 companion inventory/pack/ELF integrity, and a private operator-owned cache. Import performs no downloads or executable probes. A Pi companion does not enable remote Cursor or qualify credentials.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Runtime CLI](../../cli/src/commands/runtime.ts), [instance-config bypass](../../cli/src/index.ts), [Pi provisioning](../../packages/paperclip-runner/scripts/provision-pi.mjs), [Cursor provisioning](../../packages/paperclip-runner/scripts/provision-cursor.mjs), and [companion importer](../../server/src/services/native-runtime/remote-pi-companion.ts).

Verification: `not-run` — Inspect setup identity/path and repeat reuse on an owned disposable published installation. Verify a matching trusted companion import and reject altered/cross-release/linked inventory while preserving unrelated files. Check no instance credentials are loaded and no model is called. Qualify actual adapter/account task execution separately.

Gaps: Source-checkout setup, different platforms, remote Cursor, provider execution, and published-package acceptance remain separate scopes. Local fixture materialization does not establish remote model readiness.
