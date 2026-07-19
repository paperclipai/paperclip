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

## Exact-branch adoption

Exact-branch adoption is the record-only path for telling Paperclip about an already-existing local git worktree. It is intended for operator workflows where the branch and checkout already exist outside Paperclip, but the control plane should track them as an execution workspace and optionally bind an issue to reuse that workspace.

Adoption is deliberately conservative:

- Authenticated non-viewer board users may adopt inside companies where they have active membership. Agent callers must be standard-trust same-company principals with an explicit `execution_workspaces:adopt` permission scoped to the target project.
- The request must name the project, project workspace, source issue, absolute cwd, full branch ref, expected head SHA, expected upstream, and workspace name.
- Paperclip inspects git with argv-based `git -C <cwd> ...` calls. It does not create branches, checkout refs, clean files, remove worktrees, push, pull, or otherwise mutate git during adoption.
- The worktree must be clean, on the exact requested `refs/heads/*` branch, at the exact requested commit, tracking the exact requested upstream, and from the expected repository.
- The same branch cannot already be attached to another local worktree, and the same cwd or branch cannot already be claimed by another active execution workspace.

When adoption succeeds, Paperclip writes one execution workspace, one `workspace_adopt` operation, and activity entries in the same database transaction. If a bind issue is supplied, that issue is updated in the same transaction to `reuse_existing` and points at the adopted workspace. If the database transaction fails, the issue binding, workspace record, workspace operation, and activity entries all roll back together.

The immutable adoption fingerprint is derived from the company, project, project workspace, source issue, canonical cwd, repo root, normalized repo URL, full branch ref, head SHA, and upstream. Retrying the same adoption returns the existing workspace without creating a second operation. Retrying the same exact worktree with a different issue binding is rejected as a workspace conflict.

## Adoption rollback

Rollback is also record-only. It restores the bound issue to the execution workspace binding that existed before adoption, archives the adopted workspace record with `cleanupReason: adoption_rollback`, and writes an activity entry.

Rollback does not:

- run cleanup commands
- stop or start runtime services
- remove local directories
- remove git worktrees
- delete or checkout branches
- push, pull, or mutate git

Use archive/close when you intend Paperclip to perform the normal execution-workspace cleanup flow. Use adoption rollback when the adoption record or issue binding was wrong and the local filesystem/git checkout should remain untouched.

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
