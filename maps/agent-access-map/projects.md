# Projects and repositories — agent access

Product map: [Projects and repositories](../feature-map/projects.md).

Feature ID: `projects`.

Review date: 2026-10-12. Source commit: `f981fa3cc10cb8663a87dec60345fbff46d54d0a`.

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `lifecycle`

Capability ID: `projects/lifecycle`.

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

Capability ID: `projects/task-context`.

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

Capability ID: `projects/repositories`.

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

Capability ID: `projects/defaults`.

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

## `privacy`

Capability ID: `projects/privacy`.

Review: `baseline`.

API: `present` — POST /api/companies/{companyId}/projects; PATCH /api/projects/{id}; GET and POST /api/projects/{id}/access-members; DELETE /api/projects/{id}/access-members/{memberId}. Creation and authorized updates accept visibility; use stable UUID paths for evidence.

Agent access: `partial` — authorized agent REST or admitted native `call_api` can create a private project, and eligible project/member reads retain their normal API paths. Existing project visibility and audience mutations require board authority; no dedicated agent audience-management tool is established.

Policy: Company access and project:read apply; inaccessible projects return not found. Listing members requires project read, unlike task-grant listing. Visibility/member mutations require a board privacy/personal owner, active company owner/admin, instance admin, or local implicit board. The server derives the creation owner from the board person or agent’s onBehalfOfUserId. Targets must be company agents or active company users; the owner cannot be removed. Agent access intersects agent and responsible-user access. Opening a project does not publish its protected tasks.

Evidence: `source-only` — reviewed at `9ef434fe79c57d976b8b03b14c5242db270b8320`. [Project properties](../../ui/src/components/ProjectProperties.tsx), [access members](../../ui/src/components/ProjectAccessMembers.tsx), [project routes](../../server/src/routes/projects.ts), and [authorization](../../server/src/services/authorization.ts).

Verification: `not-run` — Verify allowed creation and reads as the actual operator/agent, then compare project and task access after adding/removing a person. Reject ordinary members’ audience changes, agent member/visibility mutations, foreign-company targets, and owner removal. After opening the project, inspect protected tasks and independent direct grants rather than inferring task publication from project discovery.

Gaps: The dedicated create_project tool does not advertise a visibility field; explicit private selection uses REST or admitted call_api. Private-project creation through each client, inherited task audiences, and responsible-user combinations need separate live evidence. The map does not infer filesystem isolation from these app-record permissions.

Project configuration responses also expose effective workspace storage through
`workspaceProvider`, separate from the stored execution policy. Existing project
read/update permissions apply. Omitted provider IDs inherit; null explicitly selects
Core/local. [Offline API coverage](../../server/src/__tests__/project-workspace-provider.integration.test.ts)
checks overrides and cross-company denial; live agent credential verification remains unqualified.
