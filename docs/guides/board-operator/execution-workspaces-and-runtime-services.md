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

## Execution workspace lifecycle

Execution workspaces are durable until a human closes them.

- The UI can archive an execution workspace.
- Closing an execution workspace stops its runtime services and cleans up its workspace artifacts when allowed.
- Shared workspaces that point at the project primary checkout are treated more conservatively during cleanup than disposable isolated workspaces.

### Archived-workspace lockout (POLA-5646)

**Root cause**: When an execution workspace was un-archived (status changed from `archived` or `cleanup_failed` back to `active`/`idle`), the `closedAt` timestamp was not cleared. The `isClosedIsolatedExecutionWorkspace` guard (in `packages/shared/src/execution-workspace-guards.ts`) considers a workspace closed when either the status is `archived`/`cleanup_failed` **or** `closedAt` is non-null. A reactivated workspace with a stale `closedAt` therefore remained blocked, preventing checkout for any issue linked to that workspace.

**Fix**: The `PATCH /api/execution-workspaces/:id` route now clears `closedAt`, `cleanupReason`, and `cleanupEligibleAt` to `null` when the requested status transition is away from `archived`/`cleanup_failed` and the existing `closedAt` is set.

**Prevention guidance**:
- When adding new closure-related fields to execution workspaces, ensure all fields are cleared on re-activation to avoid ghost-locks.
- The `isClosedIsolatedExecutionWorkspace` guard and the PATCH route lifecycle logic are coupled -- changes to either must be reviewed together.
- Test re-activation paths explicitly: archive a workspace, un-archive it, and verify checkout succeeds for a linked issue.

## Resolved workspace logic during heartbeat runs

Heartbeat still resolves a workspace for the run, but that is about code location and session continuity, not runtime-service control.

1. Heartbeat resolves a base workspace for the run.
2. Paperclip realizes the effective execution workspace, including creating or reusing a worktree when needed.
3. Paperclip persists execution-workspace metadata such as paths, refs, and provisioning settings.
4. Heartbeat passes the resolved code workspace to the agent run.
5. Workspace runtime services remain manual UI-managed controls rather than automatic heartbeat-managed services.

## Cross-run persistence (no-remote-git contract)

Code state moves between runs through the local execution-workspace cwd alone — not through a git remote.

- Each run's prepare step bundles the local worktree to the run's remote dir over ssh, with no `git remote` configured.
- The adapter's restore step at the end of the run writes any new remote commits back into the local worktree directly.
- Adapters must never `git push` from runtime code, and must never assume a remote exists.
- A failed restore is a run-level error and records `workspace_finalize=failed` on the execution workspace, which gates dependent issue wakes until the next successful finalize.

The invariant is enforced by the "no-remote-git contract" case in `packages/adapter-utils/src/ssh-fixture.test.ts`, which asserts a remote-only commit reaches the local worktree with no remote configured at any point.

## Current implementation guarantees

With the current implementation:

- Project workspace command config is the fallback for execution workspace UI controls.
- Execution workspace runtime overrides are stored on the execution workspace.
- Heartbeat runs do not auto-start workspace services.
- Server startup does not auto-restart workspace services.
