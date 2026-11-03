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

Historical Cloud sandbox cleanup remains server-owned. Cleanup-only absence
reads authenticate the tenant host with its server capability; they expose no
new board or agent endpoint. Their signed scope cannot authorize task recovery.
[Runtime and idle-gate regressions](../../server/src/__tests__/historical-cleanup-verification.test.ts)
cover reconciliation, while [receipt checks](../../server/src/services/sandbox-absence-proof.test.ts)
cover signature, identity, freshness and separation from recovery authority.
These checks do not establish a deployed sleep/wake result.

## `configuration`

Capability ID: `instance-operations/configuration`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/instance/settings`.
- `PATCH /api/instance/settings`.
- `GET /api/instance/settings/experimental`.
- `PATCH /api/instance/settings/experimental`.
- `GET /api/adapters`.
- `GET /api/adapters/{type}`.
- `PATCH /api/adapters/{type}`.

Agent access: `restricted` — Board/admin instance settings; CLI configure/env; local
configuration files.

Policy: Local machine operator and instance-administrator authority; distinct from
company-scoped agent keys.

Evidence: `source-only` — [implementation](../../cli/src/index.ts#L91) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Cloud runtime configuration uses a separate private PostgreSQL singleton and
adds no public read or mutation endpoint. Existing instance settings APIs do not
expose it. Bootstrap database credentials and trust keys remain in the supplied
environment; the strict saved allowlist excludes API keys and connection URLs.
Internal configuration updates require a matching revision and transaction lock.
[Database controls](../../server/src/__tests__/cloud-runtime-config.test.ts) cover
seed/restart, credential exclusion, conflicts and rollback. These are local
controls, not agent authorization or deployed Cloud qualification.

Gaps: Settings APIs cover parts of configuration; pre-start database/binding/storage
configuration is local operator tooling.

Adapter toggles require instance-admin authority and remain blocked when
`instance.adapters` is hidden. Ordinary board members can read the catalog;
agent keys cannot toggle adapters. Managed Cloud preferences are stored in a
private database singleton. The operator adapter declaration sets the effective
list and rejects conflicting toggles. [PostgreSQL regression coverage](../../server/src/services/adapter-settings-postgres.test.ts)
exercises persistence, concurrent writers, admission freshness, activity audit,
and failed writes; [authorization tests](../../server/src/__tests__/adapter-routes-authz.test.ts)
cover admin and hidden-setting gates. These are local tests, not deployed proof.

Cloud configuration migration and package qualification are operator commands,
not agent-accessible REST capabilities. They require the managed environment and
database operator access. The [command](../../server/src/qualify-cloud-configuration.ts)
composes transaction-safe owner seeds and writes a private receipt. Every
qualification rereads current revisions and image package evidence; a completed
historical receipt grants no deployment or execution authority. [PostgreSQL coverage](../../server/src/__tests__/cloud-configuration-migration-postgres.test.ts)
uses independent clients, lost-home reconstruction, a real replacement fixture
worker, rollback/retry, and durable blockers. [Reader coverage](../../server/src/__tests__/cloud-configuration-readers.test.ts)
checks bounded sources and pnpm-style link integrity. These are local fixtures;
see the [scope and operator procedure](../../doc/cloud-configuration-migration.md).

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
- `GET /api/instance/task-drain?upgradeReadiness=1` — instance-admin or signed
  Cloud control only. Returns aggregate restart eligibility, never checkpoint
  contents, task identities or credentials. Company members and agent keys are
  denied. The explicit request performs bounded read-only SQL; ordinary drain
  status remains an in-memory read. [Route coverage](../../server/src/__tests__/instance-settings-routes.test.ts)
  and [PostgreSQL coverage](../../server/src/services/heartbeat/upgrade-readiness.test.ts)
  establish this local boundary; hosted active-run continuity requires separate proof.
- `GET /api/ready` and `HEAD /api/ready` — public deployment readiness only;
  200 after recovery, 503 while starting, recovering, or draining. No SQL,
  session resolution, company identity, or control authority.
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

Antigravity addition (2026-10-28): `paperclipai runtime setup antigravity` stages
the verified official and patched two-executable closures on macOS ARM64. The
operator-only authority above is unchanged. The native profile remains pending
at API, driver, sidecar and Rust admission; a company grant cannot enable it.
Google AI API-key binding is distinct from Workspace OAuth. Evidence remains
`source-only` for agent access: [setup](../../cli/src/commands/runtime.ts),
[provisioner](../../packages/paperclip-runner/scripts/provision-antigravity.mjs),
and [gate regressions](../../packages/paperclip-runner/src/drivers/acpx/antigravity-models.test.ts).
Credential-free public-layout provisioning and controlled native tests do not
qualify a company agent task or authenticated connection/revocation.
