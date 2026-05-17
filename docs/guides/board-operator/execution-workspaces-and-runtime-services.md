---
title: Execution Workspaces And Runtime Services
summary: How project runtime configuration, execution workspaces, and issue runs fit together
---

This guide documents the intended runtime model for projects, execution workspaces, and issue runs in Paperclip.

Paperclip now presents this as a workspace-command model:

- `Services` are long-running commands that stay supervised.
- `Jobs` are one-shot commands that run once and exit.
- Raw runtime JSON is still available for advanced config, but it is no longer the primary mental model.

## Project runtime configuration

You can define how to run a project on the project workspace itself.

- Project workspace runtime config describes the services and jobs available for that project checkout.
- This is the default runtime configuration that child execution workspaces may inherit.
- Defining the config does not start anything by itself.

## Manual runtime control

Workspace commands are manually controlled from the UI.

- Project workspace services are started and stopped from the project workspace UI, and project jobs can be run on demand there.
- Execution workspace services are started and stopped from the execution workspace UI, and execution-workspace jobs can be run on demand there.
- Paperclip does not automatically start or stop these workspace services as part of issue execution.
- Paperclip also does not automatically restart workspace services on server boot.

## Execution workspace inheritance

Execution workspaces isolate code and runtime state from the project primary workspace.

- An isolated execution workspace has its own checkout path, branch, and local runtime instance.
- The runtime configuration may inherit from the linked project workspace by default.
- The execution workspace may override that runtime configuration with its own workspace-specific settings.
- The inherited configuration answers "which commands exist and how to run them", but any running service process is still specific to that execution workspace.

## Issues and execution workspaces

Issues are attached to execution workspace behavior, not to automatic runtime management.

- An issue may create a new execution workspace when you choose an isolated workspace mode.
- An issue may reuse an existing execution workspace when you choose reuse.
- Multiple issues may intentionally share one execution workspace so they can work against the same branch and running runtime services.
- Assigning or running an issue does not automatically start or stop workspace services for that workspace.
- When an issue first transitions to `done`, Paperclip now attempts an automatic execution-workspace closeout if the issue is still linked to one.
- Automatic issue-completion closeout only archives disposable isolated workspaces when the close-readiness checks are already satisfied and the workspace is clean and merged.
- Shared project-primary sessions are archived without deleting the underlying project checkout, and Paperclip skips the automatic closeout while other linked issues are still open.

## Execution workspace lifecycle

Execution workspaces are durable by default, but Paperclip now has a safe automatic closeout path on issue completion.

- The UI can still archive an execution workspace manually.
- Marking an issue `done` triggers a server-side closeout attempt for its linked execution workspace.
- Automatic closeout reuses the same cleanup logic as manual archival, including runtime shutdown, teardown commands, cleanup commands, and artifact removal when allowed.
- If automatic closeout is unsafe, Paperclip leaves the issue `done`, keeps the workspace available, and returns an explicit blocked or failed closeout result instead of deleting anything implicitly.
- Closing an execution workspace stops its runtime services and cleans up its workspace artifacts when allowed.
- Shared workspaces that point at the project primary checkout are treated more conservatively during cleanup than disposable isolated workspaces.

## Resolved workspace logic during heartbeat runs

Heartbeat still resolves a workspace for the run, but that is about code location and session continuity, not runtime-service control.

1. Heartbeat resolves a base workspace for the run.
2. Paperclip realizes the effective execution workspace, including creating or reusing a worktree when needed.
3. Paperclip persists execution-workspace metadata such as paths, refs, and provisioning settings.
4. Heartbeat passes the resolved code workspace to the agent run.
5. Workspace runtime services remain manual UI-managed controls rather than automatic heartbeat-managed services.

## Current implementation guarantees

With the current implementation:

- Project workspace command config is the fallback for execution workspace UI controls.
- Execution workspace runtime overrides are stored on the execution workspace.
- Heartbeat runs do not auto-start workspace services.
- Server startup does not auto-restart workspace services.
