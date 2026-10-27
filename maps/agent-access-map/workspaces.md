# Execution workspaces, services, and files — agent access

Product map: [Execution workspaces, services, and files](../feature-map/workspaces.md).

Feature ID: `workspaces`.

Lost-source reconstruction adds the board-only
`POST /api/issues/{id}/recovery-actions/reconstruct-workspace` action. It requires
`runtime:manage` and ordinary task visibility. Agents cannot authorize it. The
result is a durable fresh-session admission request, subject to current execution
gates. It grants no additional tool access, budget, work window or permission to
repeat completed actions. Attachments must belong to the same task and company.
The original failed run and lost-export evidence remain unchanged.
Later native run-only cancellations can coexist only with confirmed lease stops,
board file-only repair and an external-action outcome of `not_performed`.
Their immutable evidence is checked again at dispatch. Historical cancellation
retention runs internally and grants no new agent operation or authority.

Review date: 2026-10-12. Source commit: `58e16dbddfc9c8d0cf60867f9d9847f0feda055b`.
Native REST transport reconciled in this change; see the
[shared transport contract](README.md#native-rest-transport).

This is a source-reviewed baseline of representative operations and known gaps.
Each capability needs operation-level review before its entire scope can be
qualified. No live agent execution is claimed. Follow the [map contract](../README.md)
for format, permission checks, evidence and maintenance.

## `binding`

Capability ID: `workspaces/binding`.

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

Ordinary input may reuse the exact currently bound private task directory after
an explicitly fresh retry. Preparation rechecks company, source task, current
binding and canonical path; missing directories, symlinks and foreign roots are
rejected. This preserves files without granting new access or replaying the
previous turn. An explicitly fresh retry still creates a clean sibling.

Task workspace writes require `issue:mutate`, an active owned task/run for agents,
and current source visibility. Shared physical roots also require source-project
workspace write authority. Accepting a new pending choice advances its binding
revision; superseded retries fail while current-choice retries remain idempotent.
Binding revisions and request keys fence retries;
selection applies at the next normal admission without interrupting a live run.

Admission checks current task/run authority and the persisted selected configuration.
It does not inventory physical aliases or authorize historical sources/readers.
Explicit workspace-record selection and full workspace metadata disclosure retain
app-record privacy. Existing isolated remote-source receipts remain restorable;
new preparation does not create a remote fallback due to historical file ownership.
Historical `workspace_source_restricted` failures retain existing recovery support.
An authorized board recovery through `POST /api/issues/{id}/recovery-actions/resolve`
can schedule a server-owned `recovery` selection for the latest restricted-source
failure only when its saved evidence proves provider work never started. The
selection requires task mutation and configured-source access and applies at normal
admission. It keeps task environment settings and never reads or deletes the denied
checkout. Pause, budget, approval, interaction, dependency, and ownership gates
remain effective. Repeated resolution of the same action does not enqueue another
run. Agents cannot mint recovery provenance through the workspace selection API;
they can observe the existing recovery action and request board recovery.
Local paths, unsupported transports and credential-bearing URLs are not fallback
sources. Company/task/remote bindings, real paths, Git storage and the exact origin
are revalidated for reuse, cleanup and reopening. A failed save removes only the
owned task worktree. The [isolated-source service](../../server/src/services/isolated-remote-workspace-source.ts)
and its local regression tests establish source and lifecycle boundaries; live
agent/provider qualification remains separate.
Reconstructable Git expiration adds no agent endpoint or permission. It records
company/workspace/repository identity and an exact commit before removing owned
cache files. Existing task/workspace reopening retains current company, source,
and trust checks. Missing upstream access returns a retryable error; it does not
choose a newer commit or grant access to another company's source. Shared project
bases and unresolved recovery remain protected. Local lifecycle evidence is in
[expiration tests](../../server/src/__tests__/git-workspace-expiration.test.ts).

Only directly selected configuration policies participate in current execution trust.
Physical aliases and historical source projects do not contribute filesystem policy.
The
authoritative sandbox or SSH selection suppresses configured and built-in
controller worktree and runtime provisioning regardless of task trust, app configuration
write grants or board sponsorship. Genuine isolated worktrees still permit
authorized read-only source copying. Configuration write permission does not authorize
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

Skipping the host scan for a fully unchanged returned snapshot grants no new
access. The merge still holds its canonical writer lock and runs both authority
and publication hooks. Denials still propagate, and checkpoint/archive validation
is unchanged. [Regression coverage](../../packages/adapter-utils/src/workspace-restore-unchanged.test.ts)
is source-level evidence only.
Child creation by an admitted agent checks an explicit prospective-task context before the child is saved. The creator run must have an authoritative saved policy and a verified company/agent/parent lineage. Current parent, prospective child and selected source configuration policies must fit that boundary. This creation path does not relax exact task/run checks for existing-task writes. The [child trust regression](../../server/src/__tests__/task-workspace-child-trust.test.ts) is automated source-level evidence, not live agent qualification.
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

Capability ID: `workspaces/provisioning`.

Source preparation keeps its dedicated lock connection active during work on
other connections. It preserves company/source exclusion and existing admission
authority; it adds no agent API or permission. The
[source-lock regression](../../server/src/services/isolated-remote-workspace-source-lock.test.ts)
covers PostgreSQL idle timeout, competing preparation, ordinary pool availability,
and failure cleanup. Deployed agent recovery requires separate live evidence.

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
controller identity. Current selected-configuration permissions, responsible-user authority, trust
restrictions, immutable receipts, and concrete binding/path integrity are checked
before acquisition and publication. Low-trust callers cannot trigger a
new controller-side Git acquisition. Evidence remains source-only here; focused
[repository tests](../../server/src/__tests__/task-workspace-repositories-trust.test.ts)
are separate from live agent qualification.

An admitted native standard task can read a same-agent completion continuation
for its own pending repository in its current workspace. An explicit yield may
use that saved continuation; explicit completion remains completion. Existing
status decisions and wake admission retain Stop and authorization gates. The
[workspace API regression](../../server/src/__tests__/task-workspace-api.test.ts)
and [driver regression](../../packages/paperclip-runner/src/drivers/completion-continuation.test.ts)
cover this contract; live qualification remains separate.

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

Capability ID: `workspaces/services`.

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

Capability ID: `workspaces/files-git`.

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

Task-bound file reads authorize the current task, company, and concrete binding;
selected project roots require selected configuration access. Historical task,
reader, physical-root, and directory acquisition classifications have no effect.
Root containment and symlink escape checks remain, and attachments, task records,
workspace metadata, and operation logs retain their app-data privacy.

## `closure`

Capability ID: `workspaces/closure`.

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
