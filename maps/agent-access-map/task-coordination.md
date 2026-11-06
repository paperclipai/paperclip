# Delegation, dependencies, and signoff — agent access

Product map: [Delegation, dependencies, and
signoff](../feature-map/task-coordination.md).

Feature ID: `task-coordination`.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `delegation`

Capability ID: `task-coordination/delegation`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native create_task/reassign_task; REST / CLI / MCP.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only. Resume preview counts only current agent
assignees on todo, in-progress, and in-review tasks as wake targets. Release keeps
blocked and backlog statuses intact; existing execution gates still apply.
Reopened tasks use current eligibility rather than the pause snapshot's skipped
flag. Other active pause holds and execution reconciliation gates remain effective.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Parent/child and provenance paths exist; same-company assignment does not remove
protected task/resource policy.

MCP transport update in this change: the optional stdio package requires a
per-call `paperclipRunId` UUID for create, update, comment, and checkout tools.
It sends the UUID in the run header and does not use a startup fallback.
[The package contract](../../packages/mcp-server/README.md#per-call-run-context)
and [fake-API regressions](../../packages/mcp-server/src/run-context.test.ts)
cover transport behavior. They do not qualify live delegation or backend access.
The [watchdog scope guard](../../server/src/services/task-watchdog-scope.ts)
requires the authenticated `agent_jwt` source before widening mutation access;
API keys cannot activate a watchdog grant by selecting a run header.
[Guard tests](../../server/src/services/task-watchdog-scope.test.ts) cover this
credential boundary with a synthetic store; live authorization remains unverified.

## `dependencies`

Capability ID: `task-coordination/dependencies`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.

Agent access: `available` — Native set_dependencies for the current task; agent REST
/ native `call_api` under mutation and checkout policy.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Dedicated set_dependencies is current-task scoped. Generic `call_api`
forwards blockedByIssueIds to the REST route and retains its ownership checks.

## `signoff`

Capability ID: `task-coordination/signoff`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/issues/{id}`.
- `POST /api/issues/{id}/interactions`.

Agent access: `partial` — Native paperclip_finish/paperclip_block and assigned
resolve_review; legacy agent REST disposition.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Review policy determines final completion; formal board approval is a different
boundary.

## `tree-control`

Capability ID: `task-coordination/tree-control`.

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/issues/{id}/tree-control/preview`.
- `POST /api/issues/{id}/tree-holds`.
- `POST /api/issues/{id}/tree-holds/{holdId}/release`.

Agent access: `restricted` — Board-only task-tree APIs.

Policy: Task visibility/mutation, task-assignment and ownership policy; review audience
independent; tree controls board-only.

Evidence: `source-only` —
[implementation](../../server/src/routes/issue-tree-control.ts#L95) at the reviewed
commit above.

Verification: `not-run` — assert the documented agent denial with an owned test fixture;
verify any listed agent request/result path separately. A delegated operation needs its
own policy and access review.

Gaps: Even reads/state/preview require board. There is no agent tree-control path just
from company/task permissions.
