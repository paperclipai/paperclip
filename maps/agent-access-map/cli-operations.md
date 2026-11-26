# CLI, API clients, and local worktrees — agent access

Product map: [CLI, API clients, and local worktrees](../feature-map/cli-operations.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `context`

Review: `baseline`.

API: `not-applicable` — Local CLI configuration has no matching domain REST resource;
explicitly classify local operator configuration.

Agent access: `operator-only` — CLI context/profile options and issued agent
environment.

Policy: CLI preserves the selected bearer identity and run header; installing a CLI does
not grant board rights.

Evidence: `source-only` — [implementation](../../cli/src/commands/client/common.ts#L49)
at the reviewed commit above.

Verification: `not-run` — exercise the listed local workflow in an authorized, owned
operator environment. Verify its isolation and result; do not count local machine
authority as company-agent API access.

Gaps: Local CLI configuration has no matching domain REST resource; explicitly classify
local operator configuration.

## `domain-commands`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/agents/me`.
- `GET /api/companies/{companyId}/issues`.

Agent access: `available` — CLI client commands with agent bearer; REST and native
tools.

Policy: CLI preserves the selected bearer identity and run header; installing a CLI does
not grant board rights.

Evidence: `source-only` — [implementation](../../cli/src/commands/client/common.ts#L49)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Each command reuses API authorization; a command listed in help is not necessarily
allowed to this agent.

## `outputs`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PUT /api/issues/{id}/documents/{key}`.
- `POST /api/issues/{id}/work-products`.

Agent access: `available` — CLI issue/asset/skill commands; REST; native
document/deliverable tools.

Policy: CLI preserves the selected bearer identity and run header; installing a CLI does
not grant board rights.

Evidence: `source-only` — [implementation](../../cli/src/commands/client/common.ts#L49)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Binary transfers, document versions and work-product registration need distinct
assertions.

## `run-controls`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/heartbeat-runs/{runId}`.
- `POST /api/agents/{id}/heartbeat/invoke`.

Agent access: `partial` — CLI run/agent commands; read API; board-only
invocation/control routes.

Policy: CLI preserves the selected bearer identity and run header; installing a CLI does
not grant board rights.

Evidence: `source-only` — [implementation](../../cli/src/commands/client/common.ts#L49)
at the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Agent credentials can read eligible runs. Operator invocation/cancellation must
not be counted as ordinary agent access.

## `worktree-instances`

Review: `baseline`.

API: `not-applicable` — Local checkout and pre-start provisioning use local tools, not
company REST authorization. No new runtime is needed.

Agent access: `operator-only` — CLI worktree/test-drive/dev service commands on an
authorized owned checkout.

Policy: CLI preserves the selected bearer identity and run header; installing a CLI does
not grant board rights.

Evidence: `source-only` — [implementation](../../cli/src/commands/client/common.ts#L49)
at the reviewed commit above.

Verification: `not-run` — exercise the listed local workflow in an authorized, owned
operator environment. Verify its isolation and result; do not count local machine
authority as company-agent API access.

Gaps: Local checkout and pre-start provisioning use local tools, not company REST
authorization. No new runtime is needed.
