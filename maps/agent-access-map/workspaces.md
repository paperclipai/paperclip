# Execution workspaces, services, and files — agent access

Product map: [Execution workspaces, services, and files](../feature-map/workspaces.md).

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `binding`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{id}/heartbeat-context`.
- `GET /api/execution-workspaces/{id}`.
- `GET /api/issues/{id}/workspace` inspects the durable task binding.
- `PUT /api/issues/{id}/workspace` requests the next binding.
- `GET /api/companies/{companyId}/execution-workspaces?summary=true&selectableForTask=true`
  lists authorized task-selectable workspaces.

Agent access: `available` — Native get_task_context / REST / CLI / MCP workspace read.

The task-bound native tools `get_workspace`, `list_workspaces`, and
`select_workspace` use the ordinary authenticated APIs. Legacy agents can call
those APIs with their admitted run token. These paths do not require a project.

Policy: Company/project/workspace visibility and runtime authority; active run, trust
preset and task ownership where required.

Task workspace writes require `issue:mutate`, an active owned task/run for agents,
and current source visibility. Shared physical roots also require source-project
workspace write authority. Accepting a new pending choice advances its binding
revision; superseded retries fail while current-choice retries remain idempotent.
Binding revisions and request keys fence retries;
selection applies at the next normal admission without interrupting a live run.

Fresh standard-trust tasks with an implicit repository default can use an owned
remote clone when the shared default source fails the restricted-task workspace
guard. This does not grant access to the private local checkout or its Git metadata.
The normal admitted Git identity must already authorize the configured remote.
Creation of a fallback source is unavailable for explicit, parent/channel, reused
or low-trust selections, or branch templates without a task-derived placeholder;
an existing verified owned source remains reusable. Literal branch selections
retain the original denial without cloning or replacing their unpublished commits.
New implicit Git defaults record project-source provenance. Untyped explicit,
inherited and older ambiguous checkout bindings retain the denial; admission reads
the current company-scoped binding before considering the fallback.
Local paths, unsupported transports and credential-bearing URLs are not fallback
sources. Company/task/remote bindings, real paths, Git storage and the exact origin
are revalidated for reuse, cleanup and reopening. A failed save removes only the
owned task worktree. The [isolated-source service](../../server/src/services/isolated-remote-workspace-source.ts)
and its local regression tests establish source and lifecycle boundaries; live
agent/provider qualification remains separate.
Writable aliases must also be compatible with current and retained physical
source projects' trust boundaries. Incompatible choices are rejected before
dispatch; a projectless alias cannot bypass required sandbox containment.
Source-copy checks apply the same trust boundary before provisioning. The
authoritative sandbox or SSH selection suppresses configured and built-in
controller worktree and runtime provisioning regardless of task trust, source
write grants or board sponsorship. Genuine isolated worktrees still permit
authorized read-only source copying. Source write permission does not authorize
controller execution. Explicit, channel, inherited, foreign or nondefault isolated
source choices remain copy-only for controller provisioning even on local runs.
Their deny-only workspace marker survives metadata and binding changes; a board
reopen does not turn it into approval. Implicit trusted local defaults and explicit
SSH remote provisioning retain their existing placement; no new sandbox provision transport
is claimed. The implicit default follows task creation: configured policy pointer,
then primary source, creation time and ID. A missing or foreign configured source
does not authorize controller hooks. This precedence neither changes existing
creation validation nor rotates bindings or clears retained copy-only markers.
Closed-worktree reopening checks current task, agent, organizational and source policies without assuming a future driver. Effective low-trust reopens suppress configured and built-in host scripts. Returned checkpoints must have directory parents for every nested entry before merging, including unchanged entries; invalid output leaves retained host files intact and keeps recovery evidence.
Child creation by an admitted agent checks an explicit prospective-task context before the child is saved. The creator run must have an authoritative saved policy and a verified company/agent/parent lineage. Current parent, prospective child and physical source policies must fit that boundary. This creation path does not relax exact task/run checks for existing-task writes. The [child trust regression](../../server/src/__tests__/task-workspace-child-trust.test.ts) is automated source-level evidence, not live agent qualification.
Source review for these additions: PR #15749 and
[task workspace routes](../../server/src/routes/task-workspaces.ts),
[native authority](../../server/src/services/native-runtime/paperclip-runner-tool-authority.ts),
and [semantic transport](../../server/src/services/task-workspace-tools.ts).

Evidence: `source-only` —
[implementation](../../server/src/routes/workspace-runtime-service-authz.ts#L76) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Run/task context identifies its actual realized workspace; record existence is not
a running service.

## `provisioning`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/execution-workspaces/{id}`.
- `GET /api/execution-workspaces/{id}/workspace-operations`.
- `POST /api/issues/{id}/workspace/repositories` requests repository preparation.

Agent access: `partial` — REST / native call_api reads; task/project assignment triggers
server provisioning.

Native `prepare_repository` and admitted legacy REST callers can request a
catalog repository or validated repository URL for their current task.
Preparation occurs at normal admission; the agent cannot supply a host path or
controller identity. Current source permissions, responsible-user intersection,
trust restrictions, immutable receipts, and retained physical-root ownership are
checked before acquisition and publication. Low-trust callers cannot trigger a
new controller-side Git acquisition. Evidence remains source-only here; focused
[repository tests](../../server/src/__tests__/task-workspace-repositories-trust.test.ts)
are separate from live agent qualification.

Policy: Company/project/workspace visibility and runtime authority; active run, trust
preset and task ownership where required.

Evidence: `source-only` —
[implementation](../../server/src/routes/workspace-runtime-service-authz.ts#L76) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Observing readiness exists. Creating host commands or arbitrary provision targets
is a separate protected operation.

## `services`

Review: `baseline`.

API: `present` — representative operation IDs:

- `POST /api/execution-workspaces/{id}/runtime-services/{action}`.

Agent access: `available` — Authorized agent REST / native `call_api` / CLI runtime
service controls and existing stdio MCP controls.

Policy: Company/project/workspace visibility and runtime authority; active run, trust
preset and task ownership where required.

Evidence: `source-only` —
[implementation](../../server/src/routes/workspace-runtime-service-authz.ts#L76) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: No dedicated production control_workspace_service binding. Generic native
calls retain runtime trust and workspace/task scope checks. Optional MCP availability
must be recorded.

## `files-git`

Review: `baseline`.

API: `present` — representative operation IDs:

- `GET /api/issues/{issueId}/file-resources/content`.
- `GET /api/issues/{issueId}/file-resources/list`.

Agent access: `partial` — Authorized workspace filesystem tools; Dot workspace bridge
when enabled; board file-resource HTTP UI.

Policy: Company/project/workspace visibility and runtime authority; active run, trust
preset and task ownership where required.

Evidence: `source-only` —
[implementation](../../server/src/routes/workspace-runtime-service-authz.ts#L76) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Files panel HTTP requires board. Agents can use their admitted workspace file
tools; remote/Dot scope and Git command availability differ.

File reads also enforce retained source privacy after local copy, configuration
move/removal, reopen, and project deletion. A task assignment or repository
receipt does not grant access to private files from another physical owner.

Authorized Git-source capture also retains ownership on the actual shared Git
storage. Source checks use verified checkout identities, including company-known
owners when separate metadata has no primary-checkout registration. Removing that
checkout does not release its private committed files in surviving worktrees.

## `closure`

Review: `baseline`.

API: `present` — representative operation IDs:

- `PATCH /api/execution-workspaces/{id}`.
- `GET /api/execution-workspaces/{id}/close-readiness`.
- `POST /api/execution-workspaces/{id}/reconcile-branch`.

Agent access: `partial` — REST / native fallback for permitted update; CLI workspace;
reconcile-branch requires board.

Policy: Company/project/workspace visibility and runtime authority; active run, trust
preset and task ownership where required.

Evidence: `source-only` —
[implementation](../../server/src/routes/workspace-runtime-service-authz.ts#L76) at the
reviewed commit above.

Verification: `not-run` — exercise a listed permitted operation with actual agent
credentials/run context; inspect its result and applicable persistence/attribution.
Assert the relevant denied actor, owner, company or mode from Policy. Review the
remaining operations before qualifying the whole capability.

Gaps: Closure/readiness exists; not every workspace can be reopened, and branch
reconciliation has a board boundary.
