# Installation, configuration, updates, and backups — agent access

Product map: [Installation, configuration, updates, and
backups](../feature-map/instance-operations.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `install-update`

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

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/instance/settings`.
- `PATCH /api/instance/settings`.

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

## `diagnostics`

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
