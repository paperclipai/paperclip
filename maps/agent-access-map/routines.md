# Routines, schedules, and triggers — agent access

Product map: [Routines, schedules, and triggers](../feature-map/routines.md).

Feature ID: `routines`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `definition`

Capability ID: `routines/definition`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/routines`.
- `PATCH /api/routines/{id}`.

Agent access: `available` — Agent REST / native `call_api` / CLI routine create/update;
optional installed MCP generic request.

Policy: Agents may read company routines but only create/manage routines assigned to
themselves; trigger secrets need secure handling.

Evidence: `source-only` — [implementation](../../server/src/routes/routines.ts#L99) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated production manage_routine binding; generic `call_api` provides
the permitted REST path. Creation needs a responsible user resolved from the parent
issue or company default.

## `triggers`

Capability ID: `routines/triggers`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/routines/{id}/triggers`.
- `PATCH /api/routine-triggers/{id}`.

Agent access: `available` — Owned-routine agent REST / native `call_api` / CLI trigger
commands.

Policy: Agents may read company routines but only create/manage routines assigned to
themselves; trigger secrets need secure handling.

Evidence: `source-only` — [implementation](../../server/src/routes/routines.ts#L99) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated production trigger-management binding; generic `call_api`
provides the permitted REST path. Credential replies use inline delivery and encrypted
mutation receipts rather than shared response assets.

The host-only `GET /api/instance/task-drain?idleSleepSafety=1&scheduledWake=1`
extension reports the earliest supported future routine deadline under an owned
idle hold. It requires signed Cloud control authority; company agents and tenant
admin tokens cannot use it. It does not grant routine management or execution
authority. See the [hosting protocol](../../doc/idle-sleep-safety.md#scheduled-routine-wake-protocol)
and [route authorization tests](../../server/src/__tests__/instance-settings-routes.test.ts).
These are local contract checks, not a live provider sleep/wake qualification.

## `run-now`

Capability ID: `routines/run-now`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/routines/{id}/run`.

Agent access: `partial` — Owned-routine agent REST / CLI run; native `call_api` from
an authorized active run.

Policy: Agents may read company routines but only create/manage routines assigned to
themselves; trigger secrets need secure handling.

Evidence: `source-only` — [implementation](../../server/src/routes/routines.ts#L99) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Scheduled/waiting native agents cannot independently call this operation:
native authority requires a running bound run. A separate control binding remains absent.

## `history`

Capability ID: `routines/history`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/routines/{id}/runs`.
- `GET /api/routines/{id}/revisions`.

Agent access: `available` — REST / native call_api / CLI routine.

Policy: Agents may read company routines but only create/manage routines assigned to
themselves; trigger secrets need secure handling.

Evidence: `source-only` — [implementation](../../server/src/routes/routines.ts#L99) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Runs are readable in company scope; configuration revision access checks routine
ownership for agents.

## `management`

Capability ID: `routines/management`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/routines/{id}`.

Agent access: `available` — Owned-routine agent REST / native `call_api` / CLI.

Policy: Agents may read company routines but only create/manage routines assigned to
themselves; trigger secrets need secure handling.

Evidence: `source-only` — [implementation](../../server/src/routes/routines.ts#L99) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Pause/archive mutations have a generic native REST path under routine
ownership rules. Plugin-managed routine rules remain separate.

Execution resolves referenced project skills against agent/responsible-user access,
then saves immutable version selections in the heartbeat execution context. New runs
resolve latest installed content; resumed runs retain selections and recheck access.
An unavailable explicit reference produces an actionable configuration error.
Live agent execution across an upstream update remains required acceptance evidence.
