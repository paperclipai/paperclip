---
navigation: {"section":"Projects and execution","sectionOrder":40,"order":30}
---

# Workspaces, services, and files

A project or task can use a managed workspace with inspectable files, Git state, services, and runtime controls. Operators can follow its lifecycle through provisioning, use, and closure.

Feature ID: `workspaces`.

Implementation: [workspace list](../../ui/src/pages/Workspaces.tsx), [execution workspace](../../ui/src/pages/ExecutionWorkspaceDetail.tsx), [project workspace](../../ui/src/pages/ProjectWorkspaceDetail.tsx).

Agent access: [companion](../agent-access-map/workspaces.md).

## Sub-features

- `binding`: `workspaces/binding` — identify the workspace actually bound to a task/run.
- `provisioning`: `workspaces/provisioning` — observe readiness and failures instead of inferring readiness from a created record.
- `services`: `workspaces/services` — start/stop supported services and inspect logs and exposed endpoints.
- `files-git`: `workspaces/files-git` — inspect workspace files and repository state used for the deliverable.
- `closure`: `workspaces/closure` — close/reopen or reconcile through permitted controls without losing work.

For a historical failed export whose exact sandbox was destroyed, the task recovery
notice offers **Continue from saved sources** to an authorized board operator.
Select surviving task attachments, record lost work and external action outcomes,
then rebuild through fresh-session admission. The old failed run remains failed.
Bounded bootstrap retries retain this decision and recheck their system wake,
predecessors, saved files and current execution gates before provider startup.
Later cancelled runs require their own confirmed stop and board file repair.
Their evidence is preserved with the reconstruction and rechecked before dispatch.
Stop retains unfinished native files; startup also repairs missing historical
retention without replaying the cancelled turn.
Daytona stop-only cleanup confirms retention and accepts an already archived source.
Cancelled native file recovery can record a verified no-action outcome. Its
confirmation stays optional and resets when the source changes.
Retained sandboxes keep their existing export recovery path. Automated coverage:
[reconstruction](../../server/src/services/native-runtime/native-workspace-reconstruction.test.ts).
Live staging acceptance remains separate from these regression tests.

## How to get to it (user POV)

### `task-workspace`

Use the task’s workspace card or Files panel and follow its workspace link.

### `workspace-management`

Open `/workspaces`, a project workspace, or `/execution-workspaces/:workspaceId` and its Services/Configuration/Runtime logs views.

## Driving it with Playwright and the Paperclip CLI

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable isolated-workspace UI where needed. Use an owned disposable repository and environment; record workspace ID and branch.

### `task-workspace`

Automated: [workspace card](../../ui/src/components/IssueWorkspaceCard.test.tsx) and [task binding](../../server/src/__tests__/issue-runtime-workspace-binding.test.ts) cover host/binding contracts.

Manual: Run a task that writes a small file, follow the bound workspace, and inspect the file and revision. Reload and verify links still refer to the same workspace, not another checkout or a stale run.

For slow source preparation, configure a short PostgreSQL idle-transaction
timeout in a disposable instance. Hold preparation beyond that interval and
verify it retains its source lock, rejects competing preparation, and leaves
ordinary reads available. The [source-lock regression](../../server/src/services/isolated-remote-workspace-source-lock.test.ts)
uses real PostgreSQL; it does not prove provider startup or deployed recovery.

Create an authorized task whose selected checkout is also used by private historical
tasks and many old workspace records. Start and reuse it without a historical-source
permission failure or remote-clone fallback. Verify task-bound file browsing works,
while private historical task content and operation logs remain denied through app
APIs. Root traversal and symlink escapes must remain rejected. The OS and execution
environment own isolation between agents; Paperclip does not classify existing bytes
by the task that wrote them. Existing `workspace_source_restricted` failures remain
inspectable and recoverable, but new preparation does not produce that failure from
filesystem history. Current trust, credential, binding, and publication checks still
apply. The preparation-history benchmark supplies local service measurements, not
provider deployment qualification.

For reconstructable Git expiration, finish a disposable task tree, run the
internal lifecycle sweep after its 24-hour grace, and inspect candidate/reclaimed
bytes. Advance its upstream first; use the ordinary task/workspace reopen control
and verify the original commit, file contents, and subsequent persisted work.
Current runs, previews, recovery, unique files and shared base clones must stay.
The [expiration tests](../../server/src/__tests__/git-workspace-expiration.test.ts)
exercise real local Git and database paths, interruption and concurrent reopening;
cloud credentials and the deployed user journey require separate live evidence.

For task workspace selection, use the authorized task workspace API to choose a
task directory, project source, or existing workspace. Verify that a change
made during a run stays pending until the next normal admission. Submit another
choice using the returned revision, then retry the superseded request; it must
fail without replacing the newer pending choice. A projectless
task must retain its files across resume and reassignment. Use the repository
preparation API to add an authorized repository beneath that workspace;
repeat the request and verify that it reuses the checkout and pinned revision.
See [task binding tests](../../server/src/__tests__/task-workspace-binding.test.ts)
and [repository access tests](../../server/src/__tests__/task-workspace-repositories-trust.test.ts).

For native unfinished work, yield after preparation is staged and verify that
normal admission prepares the repository and continues the same task without
a timer or user message. A staging-only task that finishes must not wake again.
The saved continuation must disappear when the repository is ready or belongs
to another task. Source regressions cover those eligibility checks; a live
provider journey is required to qualify the complete automatic resume.

An existing projectless folder alias of a sandbox-restricted project must be
rejected for a standard local task before its adapter executes. Repeat after
relocating the configured source; retained ownership must still enforce the
boundary. This is separate from ordinary authorized file preview/download.
For a registered worktree selected for a sandbox or SSH environment, configured
and built-in provision scripts must not run on the controller during fresh
creation, reuse, or rebuild, including host runtime provisioning. Repeat with
standard trust and a protected read-only source, then with source write grants;
permissions must not change execution placement. Verify isolated source copying
and selected-environment dispatch still work. Repeat an explicit local isolated
source choice: copying remains available but controller scripts must stay absent,
including after binding or metadata changes and closed-worktree reopening. An
implicit trusted local project default remains a positive provisioning control.
Repeat with a newer configured default overriding an older primary source, then
with a newer primary overriding an older nonprimary source. Both configured and
built-in hooks must run for the implicit local default. Task creation and controller
classification share configured-default, primary, creation-time and ID precedence.
Explicit choices and saved copy-only markers still suppress hooks; changing the
default must not rotate an existing binding or clear its marker.
SSH keeps its explicit remote provision-command path; these checks
do not claim a new sandbox provision transport.
Low-trust closed-worktree reopening, including a board-comment reopen of a projectless task, must also suppress both kinds of host provision script. Returned checkpoints must reject file, symlink or missing parents before host writes, even if a nested file is marked unchanged. The retained host file and recovery evidence must survive rejection. These are automated safety contracts, not new live runtime acceptance.

An unchanged returned snapshot skips the host scan after acquiring the writer lock
and checking authority. Concurrent host edits remain untouched; changed files,
modes, symlinks and deletions still take the conflict path. The
[unchanged restore regression](../../packages/adapter-utils/src/workspace-restore-unchanged.test.ts)
checks both hooks under the lock. This is source-level coverage, not a cloud latency result.

For a child created by an admitted agent with an explicit existing workspace, verify that a matching sandbox boundary permits creation before the child has an ID. A changed child policy, unrelated parent, or forged creator run must fail. See the [child workspace trust regression](../../server/src/__tests__/task-workspace-child-trust.test.ts). This automated contract does not add live acceptance evidence.

### `workspace-management`

Automated: [workspace detail](../../ui/src/pages/ExecutionWorkspaceDetail.test.tsx) and [runtime service](../../server/src/__tests__/workspace-runtime.test.ts) cover UI and runtime contracts separately.

Manual: Provision a disposable workspace, wait for readiness, start an available service, open its endpoint, and inspect a real response and logs. Stop it and verify it actually stops. Exercise close/reopen only after inspecting pending changes and active runs.

## Gotchas

- UI visibility, default isolation policy, the local environment row, a workspace
  record, and a running service are distinct prerequisites. A fresh instance
  still needs an owned cwd/repository and runtime commands; `/workspaces` lists
  existing work. Reopening depends on lifecycle, not a generic detail action.

- A link or running badge does not prove the service is reachable from the user’s browser.
- Workspace IDs, runtime leases, and repository paths are not interchangeable.
- Terminal workspace cleanup wakes after committed task/workspace/PR changes and
  restores cooldown deadlines at startup. Empty lanes stop scanning. Display Git
  results can lag by thirty seconds. Compatible records share one advisory Git
  inspection per bounded page, while each record keeps its own delivery check.
  Destructive cleanup starts a separate Git scan even if an older scan is running.
  The [worker tests](../../server/src/__tests__/terminal-workspace-work.test.ts)
  cover quiet lanes and deadlines. The
  [service tests](../../server/src/__tests__/execution-workspaces-service.test.ts)
  cover real PostgreSQL signals and retained worktrees. These tests do not
  qualify an external wake alarm or a live provider deployment.
- Organizational project, source project, task files, personal `AGENT_HOME`, and
  provider home have separate meanings. Private source ownership remains attached
  to copied files after source configuration changes or workspace closure.
- Use [recovery](./recovery.md) for divergence/export repair and [CLI operations](./cli-operations.md) for local worktree tooling.

### Storybook verification

#### `closure`

Capability ID: `workspaces/closure`.

Scope: ui
Storybook: Close-readiness checks, pending changes/active runs, blocked/pending/error close, retry close and eligible reopening.
Production: Confirm owned workspace shutdown, preserved files/Git state and permitted lifecycle transition/reopening; Browser Use session closure is unrelated.
Sources: Source: [ExecutionWorkspaceDetail.tsx](../../ui/src/pages/ExecutionWorkspaceDetail.tsx), [ExecutionWorkspaceCloseDialog.tsx](../../ui/src/components/ExecutionWorkspaceCloseDialog.tsx), [execution-workspaces.ts](../../server/src/routes/execution-workspaces.ts). Tests: [execution-workspaces-routes.test.ts](../../server/src/__tests__/execution-workspaces-routes.test.ts), [execution-workspaces-service.test.ts](../../server/src/__tests__/execution-workspaces-service.test.ts), [execution-workspace-reopen.test.ts](../../server/src/__tests__/execution-workspace-reopen.test.ts)
