# Execution workspaces, services, and files

A project or task can use a managed workspace with inspectable files, Git state, services, and runtime controls. Operators can follow its lifecycle through provisioning, use, and closure.

Implementation: [workspace list](../ui/src/pages/Workspaces.tsx), [execution workspace](../ui/src/pages/ExecutionWorkspaceDetail.tsx), [project workspace](../ui/src/pages/ProjectWorkspaceDetail.tsx).

## Sub-features

- `binding`: identify the workspace actually bound to a task/run.
- `provisioning`: observe readiness and failures instead of inferring readiness from a created record.
- `services`: start/stop supported services and inspect logs and exposed endpoints.
- `files-git`: inspect workspace files and repository state used for the deliverable.
- `closure`: close/reopen or reconcile through permitted controls without losing work.

## How to get to it (user POV)

### `task-workspace`

Use the task’s workspace card or Files panel and follow its workspace link.

### `workspace-management`

Open `/workspaces`, a project workspace, or `/execution-workspaces/:workspaceId` and its Services/Configuration/Runtime logs views.

## Driving it

Preconditions: follow the [baseline](./README.md#before-driving-a-journey). Enable isolated-workspace UI where needed. Use an owned disposable repository and environment; record workspace ID and branch.

### `task-workspace`

Automated: [workspace card](../ui/src/components/IssueWorkspaceCard.test.tsx) and [task binding](../server/src/__tests__/issue-runtime-workspace-binding.test.ts) cover host/binding contracts.

Manual: Run a task that writes a small file, follow the bound workspace, and inspect the file and revision. Reload and verify links still refer to the same workspace, not another checkout or a stale run.

### `workspace-management`

Automated: [workspace detail](../ui/src/pages/ExecutionWorkspaceDetail.test.tsx) and [runtime service](../server/src/__tests__/workspace-runtime.test.ts) cover UI and runtime contracts separately.

Manual: Provision a disposable workspace, wait for readiness, start an available service, open its endpoint, and inspect a real response and logs. Stop it and verify it actually stops. Exercise close/reopen only after inspecting pending changes and active runs.

## Gotchas

- A link or running badge does not prove the service is reachable from the user’s browser.
- Workspace IDs, runtime leases, and repository paths are not interchangeable.
- Use [recovery](./recovery.md) for divergence/export repair and [CLI operations](./cli-operations.md) for local worktree tooling.
