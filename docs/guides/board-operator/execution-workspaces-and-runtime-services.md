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

## Runtime control: manual and heartbeat-driven

Workspace commands can be controlled manually from the UI, and heartbeat runs also start services automatically.

- Project workspace services are started and stopped from the project workspace UI, and project jobs can be run on demand there.
- Execution workspace services are started and stopped from the execution workspace UI, and execution-workspace jobs can be run on demand there.
- Heartbeat runs also auto-start the workspace's runtime services at the beginning of an issue run. `ensureRuntimeServicesForRun` (`server/src/services/workspace-runtime.ts`, called from `server/src/services/heartbeat.ts`) starts each service whose desired state resolves to `running` — which is the default when no explicit per-service desired state is set. A running service that matches an existing reuse key is reused rather than restarted.
- You can opt a service out of that auto-start by setting its desired state to `stopped`/`manual` in the runtime config; those services stay UI-controlled.
- Paperclip does not automatically restart workspace services on server boot — services only come back up when the next run (or a manual start) brings them up.

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
- Running an issue auto-starts the workspace's `running`-desired runtime services for the duration of the run (see "Runtime control" above); it does not stop them when the run ends unless they are ephemeral and no other run holds a lease.

## Execution workspace lifecycle

Execution workspaces are durable until a human closes them.

- The UI can archive an execution workspace.
- Closing an execution workspace stops its runtime services and cleans up its workspace artifacts when allowed.
- Shared workspaces that point at the project primary checkout are treated more conservatively during cleanup than disposable isolated workspaces.

## Resolved workspace logic during heartbeat runs

Heartbeat resolves a workspace for the run (code location and session continuity) and also brings up that workspace's runtime services.

1. Heartbeat resolves a base workspace for the run.
2. Paperclip realizes the effective execution workspace, including creating or reusing a worktree when needed.
3. Paperclip persists execution-workspace metadata such as paths, refs, and provisioning settings.
4. Heartbeat passes the resolved code workspace to the agent run.
5. Heartbeat calls `ensureRuntimeServicesForRun` to start the workspace's `running`-desired runtime services, running the lazy runtime provision command first if one is configured and has not yet run (see "Lazy runtime provisioning" below).

## Lazy runtime provisioning

Some workspaces need heavy one-time setup — seeding a database, warming caches — before their runtime services can start. That work can be deferred to the first runtime-service start instead of running eagerly during workspace preparation.

- Configure a **runtime provision command** on the project's workspace strategy (Project properties → execution workspace), or override it per execution workspace on the workspace's Configuration tab.
- When set, workspace preparation stays lean and the command runs exactly once, immediately before the first runtime-service start for that workspace. Leaving it empty keeps the legacy eager path (all setup during workspace provisioning).
- The command's outcome is recorded as a `workspace_runtime_provision` operation on the execution workspace and surfaced on the workspace detail page:
  - **Deferred** — configured but not yet run (no runtime service has started yet).
  - **Provisioned at &lt;time&gt;** — the command completed successfully.
  - **Provisioning failed** — the command failed; the workspace detail links to the runtime logs for the failing operation.
- While the command runs, the runtime service shows a **Provisioning…** state before it transitions to starting/running.

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
- Heartbeat runs auto-start the workspace's `running`-desired runtime services (via `ensureRuntimeServicesForRun`); services set to `stopped`/`manual` stay UI-controlled.
- A configured runtime provision command runs once, lazily, before the first runtime-service start.
- Server startup does not auto-restart workspace services.
