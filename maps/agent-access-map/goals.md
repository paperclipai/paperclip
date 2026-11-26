# Goals and work alignment — agent access

Product map: [Goals and work alignment](../feature-map/goals.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `hierarchy`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/goals`.
- `POST /api/companies/{companyId}/goals`.
- `PATCH /api/goals/{id}`.

Agent access: `available` — REST / native call_api / CLI goal / MCP read helpers.

Policy: Same-company access; related project/task assignments have their own resource
permissions.

Evidence: `source-only` — [implementation](../../server/src/routes/goals.ts#L14) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Real REST path exists. Scenario list_goals declarations are not evidence of a
production native binding.

## `alignment`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/projects/{id}`.
- `PATCH /api/issues/{id}`.

Agent access: `available` — REST / native call_api for permitted non-lifecycle fields.

Policy: Same-company access; related project/task assignments have their own resource
permissions.

Evidence: `source-only` — [implementation](../../server/src/routes/goals.ts#L14) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Goal association is data access, separate from completing or reassigning the task.

## `navigation`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/goals/{id}`.
- `GET /api/projects/{id}`.
- `GET /api/issues/{id}`.

Agent access: `available` — REST and task/project/goal read tools; links returned as
context.

Policy: Same-company access; related project/task assignments have their own resource
permissions.

Evidence: `source-only` — [implementation](../../server/src/routes/goals.ts#L14) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Navigation renders records already exposed by APIs; no separate click-navigation
API is required.
