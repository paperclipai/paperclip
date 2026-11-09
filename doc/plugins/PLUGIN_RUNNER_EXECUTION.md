# Plugin Runner execution

Core can run `paperclip_runner` tasks in a plugin environment.
The plugin owns the execution host and its files.
Core owns run identity, selected policy, assigned tools, and the PRP journal.

## Required hooks

Set `supportsTasks: true` on the environment driver.
Declare the `environment.drivers.register` capability.
Implement these hooks:

- `onEnvironmentAcquireLease`
- `onEnvironmentTask`
- `onEnvironmentReleaseLease`
- `onEnvironmentDestroyLease`

Task execution does not require `onEnvironmentExecute` or
`onEnvironmentRealizeWorkspace`. The task API has no shell or file transfer
operation. Use a separate workflow to install and save agent files.

Core supports per-turn workspace sessions with Codex, OpenCode, and ACPX.
OpenCode and ACPX require the existing qualified provider profiles.
Workspace-free providers and warm process retention are not supported here.
The plugin owns project workspace preparation. Core does not prepare or reuse
a Core Git worktree for a task-only environment.
For plugin-backed project storage, Core uses the workspace provider contract.
The storage plugin must also provide the selected execution environment.
Its declared workspace modes and strategies remain in effect.
Core passes the pinned workspace binding with each task operation.
Core rejects configured workspace services for task-only environments.
Fresh retries that import retained files are not supported for plugin storage.
An agent-owned workspace cannot move to another agent or environment.
Core also rejects reuse of a local workspace in a task-only environment.
Keep its original owner, or use the workspace storage provider contract.

## Prepare and launch

1. Return an opaque task ID from lease acquisition as `providerLeaseId`.
2. Return the installed Runner version and SHA-256 digest from `describe`.
3. Return `launchPreparationVersion: 1` from `describe`.
4. Handle `prepare` with the [launch preparation contract](../runner-launch-preparation.md).
5. Save the result under its configuration ID.
6. Handle `submit` with that ID in `preparedLaunchId`.
7. Return an authenticated WSS endpoint from `connection`.

Preparation must not start a process. It must preserve Core's provider, model,
policy, instructions, and resource assignment identities. Resolve assigned
resources to execution-host paths. Use `bindRunnerLaunchResources` and
`createRunnerProviderLaunch` when the built-in descriptor builder is suitable.

Core checks the returned requirements digest and descriptor before it registers
PRP or submits the task. A failed check does not enable a fallback launch.
Recovery within the same run must return the exact saved configuration.

The plugin supplies executable paths and the provider workspace in the
descriptor. It owns the process environment and account installation.
For example, a persistent computer can use these locations:

```text
HOME=/home/agent
AGENT_HOME=/home/agent/.agents
CODEX_HOME=/home/agent/.codex
instructions=/home/agent/.agents/AGENTS.md
skills=/home/agent/.agents/skills/<name>/SKILL.md
```

These are execution-host locations. Core does not copy the home for each run.
The plugin must declare `projectAuthCheckVersion: 1` for all native tasks.
Core requires `check_project_auth` to allow the exact prepared configuration
before it sends credentials. The plugin must reject conflicting project or
parent authentication settings. It must keep the checked configuration fixed
until submission. See [managed account validation](PLUGIN_ENVIRONMENT_TASKS.md#managed-account-validation).

Core sends authorized project IDs, the PRP identity, launch limits, and the
bootstrap ticket through `submit`. It does not send a process command.
The plugin must submit each task at most once. A lost reply requires status
reconciliation for the same task.

## Credentials and tools

Core can transfer a selected Codex account or a direct Claude credential.
Other managed routes fail closed until they have a typed credential contract.
Do not put credentials in task metadata, journals, logs, or errors.

Assigned MCP tools run through the Core gateway over PRP.
The gateway credentials stay on Core.
The plugin must preserve the MCP binding identity in the prepared context.

Core records credential writeback authority before dispatch.
After process termination, Core saves refreshed credentials before it completes
the task. A failed save retains the task grants for cleanup.

## Stop and recovery

A terminal phase does not prove process termination.
Return `executionStopped: true` only after the task and its descendants stop.
Return `sessionStateAvailable: true` only when the suspended state remains usable.
Keep retained state when Core completes the task.
Core checks managed plugin workspaces through their storage provider before
completion, including after a restart. Core does not inspect these folders locally.
If this check fails, Core defers the run and continues recovery for other runs.
Core keeps known branch and owner error codes with the repair instructions.

The task contract exposes two checkpoint operations:

- `read_state` returns the exact Runner durable state for the supplied identity.
- `archive_state` moves a suspended Runner authority checkpoint under the supplied
  archive key. It returns the same state on retry. It keeps provider session files.

These operations do not accept paths. Core checks the active lease and retained
source task before it calls the plugin. The existing Runner transport validates
state identity and suspension before it rotates authority.

Core checks company, agent, environment, workspace, driver, and termination
receipts before it supplies `resumeFrom`. For same-run controller recovery, Core
first stops and releases the old task. A failed stop prevents replacement.
A new run prepares its current assignments. Provider compatibility checks remain
in the existing backends. Missing or incompatible retained state fails closed.

## Setup verification

Core creates a private probe lease with an expiry.
It runs the same describe, prepare, submit, and WSS/PRP path.
The probe checks provider authentication and the selected model with tools denied.
Core bounds Runner lifetime to the remaining probe time.
It then requires suspension, confirmed termination, and task cleanup.
For a new agent-owned computer, the saved-agent lifecycle runs verification
after it saves the agent. Core does not require a computer before this save.

## Verification

- [Lease and SDK RPC integration](../../server/src/__tests__/plugin-runner-task.integration.test.ts)
- [Real Runner setup and recovery](../../server/src/services/native-runtime/plugin-runner-probe.test.ts)
- [Task ownership and cancellation](../../server/src/services/native-runtime/plugin-runner-task.test.ts)
- [Credential transfer](../../server/src/services/native-runtime/plugin-runner-credentials.test.ts)

The Runner fixture uses a synthetic Codex provider and local sockets.
It does not qualify a deployed plugin, live account, or production WSS proxy.
