# Projects and repositories — agent access

Product map: [Projects and repositories](../feature-map/projects.md).

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `lifecycle`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/companies/{companyId}/projects`.
- `PATCH /api/projects/{id}`.
- `DELETE /api/projects/{id}`.

Agent access: `available` — Native create_project/list_projects; REST / CLI / MCP.

Policy: Company/project visibility, protected configuration/runtime policies; some
repository/privacy management requires board.

Evidence: `source-only` — [implementation](../../server/src/routes/projects.ts#L278) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Actual data operations exist; project discovery and private-resource permissions
still apply.

## `task-context`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/issues`.
- `POST /api/companies/{companyId}/issues`.

Agent access: `available` — Native create_task/search_tasks; REST / CLI / MCP.

Policy: Company/project visibility, protected configuration/runtime policies; some
repository/privacy management requires board.

Evidence: `source-only` — [implementation](../../server/src/routes/projects.ts#L278) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Use explicit project context; task creation, assignment, and execution remain
separate checks.

## `repositories`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/companies/{companyId}/project-repositories`.
- `PUT /api/projects/{id}/repositories`.

Agent access: `partial` — Native list_project_repositories/create_project for initial
selection; board-only replacement API.

Policy: Company/project visibility, protected configuration/runtime policies; some
repository/privacy management requires board.

Evidence: `source-only` — [implementation](../../server/src/routes/projects.ts#L278) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Authorized initial selection works. Replacement of repositories on an existing
project hard-requires board and needs a delegation decision.

## `defaults`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/projects/{id}`.
- `GET /api/projects/{id}/workspaces`.

Agent access: `partial` — REST / native call_api for permitted fields; CLI
project/workspace.

Policy: Company/project visibility, protected configuration/runtime policies; some
repository/privacy management requires board.

Evidence: `source-only` — [implementation](../../server/src/routes/projects.ts#L278) at
the reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Description/goal/target selection exist; host workspace command mutation is denied
to agents and budget policy is board-managed.

Repository attachment also writes a durable skill import binding in its transaction.
Agent-created bindings derive their refresh person from authenticated responsible-user
context. Project selection does not grant runtime credentials or override private
project skill access. Verify automatic import and denial with the actual agent identity.

Workspace creation, update and deletion require project:write_workspace through
the shared authorization evaluator in addition to project read access. Repository
attachment does not bypass skill-import policy for its background discovery.
