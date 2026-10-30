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
`onEnvironmentRealizeWorkspace`. The task API has no shell command or file installation
operation. Use a separate workflow to install agent files. Providers that
advertise `workspaceFileReadVersion: 1` can return task output files through the
bounded `read_file` operation for attachments and deliverables.

Core supports per-turn workspace sessions with Codex, OpenCode, and ACPX.
OpenCode and ACPX require the existing qualified provider profiles.
Workspace-free providers are not supported here. Drivers opt into warm retention through `warmTaskVersion: 1`. Core prefers warm execution for new task runs on capable drivers, including ACPX; existing provider admission still determines which harnesses the driver supports.
The plugin owns project workspace preparation. Core does not prepare or reuse
a Core Git worktree for a task-only environment.
Selecting a plain task directory does not add redundant default configuration.
Retaining that directory does not itself change the run configuration.
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
Core requires an allowed `check_project_auth` result, or a prepared result with
`projectAuthCheckAtSubmit: true`. The latter delegates the check to the trusted
plugin's submit handler before credential installation or task start. The plugin
must reject conflicting project or parent authentication settings. It must keep
the checked configuration fixed until submission. See
[launch authentication validation](PLUGIN_ENVIRONMENT_TASKS.md#launch-authentication-validation).

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

For controller replacement, Core restores its encrypted PRP journal from Postgres
and reuses the original active task lease. The task owner checks running status
and exact Runner identity, then reacquires the connection. It does not call
`prepare`, `submit`, or `stop`. The running artifact remains pinned even if
`describe` reports a newer installed version. Launch preparation files on the
old controller are not required to adopt an already running task.
The five-minute outage contract and its prerequisites are described in the
[continuity recipe](../testing-native-remote-continuity.md#replacing-the-main-server).

Core checks company, agent, environment, workspace, driver, and termination
receipts before it supplies `resumeFrom`. Historical controller recovery without
the durable journal first stops and releases the old task. A failed stop prevents replacement.
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

## Workspace completion and maintenance

A storage provider can declare `workspaceProvider.finalizationVersion: 1`.
Core then sends `workspaceOperation` with `operation.kind: "finalize"`, the retained
binding, lifecycle generation, and originating `runId` and `agentId`. The operation
must verify workspace identity and make the run's retained writes durable before
returning `{ kind: "finalized", headSha, branchName }`. Git workspaces must still
report the assigned branch. Non-Git workspaces return null Git fields.

Completion permits dirty, untracked, ignored, and unpublished work. It does not
prove remote recoverability or authorize deletion. The provider chooses how to
meet this contract; Core does not prescribe a VM, filesystem, or Git layout.
Core gives completion a 30-second deadline. An unavailable execution host or an
unconfirmed durability barrier must fail retryably, never return success.
Recovery receives the original run and agent context.

The existing agent-independent `inspect` and `remove` operations continue to
protect storage maintenance. Providers that do not declare finalization version 1
retain the inspection-based completion path. No stored binding migration is required.

## Warm task retention

A driver declares `warmTaskVersion: 1`, implements `onEnvironmentResumeLease`,
and returns `warmTaskVersion: 1` from `describe` only when its execution host
supports authorized run attachment. Newly hired agents targeting such a driver
are configured for warm execution. Existing agents keep their explicit policy;
plugin runs without an explicit policy prefer warm execution. There is no
provider-specific warm gate or additional setting. Existing runs retain their
admitted lifecycle policy during restart recovery. The existing
`runnerIdleTimeoutMs` controls bounded retention. Fresh warm admission requires
a Core-managed credential identity before lease acquisition. Plugin-owned installed
accounts continue per-turn until such an identity is available; the saved warm
preference does not bypass account ownership checks. Drivers without warm
capability and setup probes remain ephemeral.

Plugin task execution uses the public, run-scoped GitHub credential broker
when the provider advertises its versioned contract. Warm preparation updates
the command capability before admitting the new run. Restart recovery retains
the original run binding; new work must not reactivate an older capability.
Project authorization is still checked for each new run.

A Launcher task owns one Runner process, independently of Core heartbeat runs.
Successful warm run completion retains the task and its mounts. The reuse
policy is saved with the selected native runtime, independently of workspace
copy-back records. Recovery uses that policy when no workspace-sync record exists,
so it does not stop a Runner that foreground completion retains. Failed and
cancelled runs still stop instead of staying warm. The reuse
fingerprint includes the authorized project set; changing it retires the previous
task before checkpoint recovery. Adoption and each warm handoff require a current,
configuration-bound project-auth check against the exact retained mount scope. Core atomically
hands its retained provider identity to one new run lease, revalidates current
project authentication, prepares the new run's resources, and uses PRP
`run.attach`. Preparation includes the exact `priorIdentity` and stable
`accountIdentity`. The provider journals that transition idempotently before
allowing the new authority. The original ingress address remains unchanged.
Runner accepts `connection: { mode: "external" }` on warm attachment to preserve
the process owner's listener and TLS settings while rotating the run identity.

Core permits connection refresh for the saved successful run while its warm task
lease is retained, unexpired, and not retiring or stopped. PRP authentication
still applies. A superseded lease cannot acquire a connection. Retention does
not authorize preparation or submission of new work through the completed lease.

Idle retirement suspends and stops Runner, saves its exact checkpoint, writes
credentials through the durable lease handoff, then completes the provider task.
Core permits read-only suspension proof for the exact saved identity of a
successful warm run after its reuse lease is retained or superseded. This does
not authorize new work or file access through that lease.
Temporary credential homes are not needed after the originating run ends.
Termination receipts cover all run leases that owned the retired physical task.
A stopped task gets a new provider task ID for checkpoint resumption. Inspection
precedes in-memory session selection so a replacement cannot inherit the stopped
session. Core saves the fresh provider expiry and forwards and enforces any
caller-imposed deadline. A missing
or unreachable computer never authorizes a replacement. Controller recovery can
adopt a verified surviving idle process through its authenticated PRP connection;
ambiguous transitions remain fenced by the existing durable recovery checks.

Changes to account, credential generation, workspace, runtime or process policy
retire the old owner before recovery. A new authority epoch archives the stopped
checkpoint under its stable archive key and preserves provider session files.
Warm status monitoring relies on PRP after startup and does not poll an idle
Launcher. ACPX uses this task-provider contract; other execution transports retain
their provider-specific lifecycle policies.

### Operation-time GitHub credentials

A task provider can advertise `githubCredentialBrokerVersion: 1` in its
`describe` result. Core then supplies an optional `githubBroker: { url, token }`
in each `prepare` operation. This is a runtime capability, not a GitHub token.
No controller path, executable, script, or command implementation is part of
this contract. Plugin authors own how their command environment uses it.

At the start of each authenticated operation, send `POST` with body `{}` to
`<url without trailing /api>/runtime-tools/github/credentials`, with
`Authorization: Bearer <token>`. The response is either
`{ status: "available", env: { ... } }` or
`{ status: "unavailable", reason: "..." }`. Core rechecks the live run, accepted
instruction identity, grants, and trust policy on each request. Use the returned
environment only in the command and its descendants. Never retain raw GitHub
credentials in plugin state, launch descriptors, logs, or files.

A warm task must replace its broker capability before admitting the next run's
commands. An absent broker clears the old capability and allows anonymous/local
operations only. Isolate ambient host credentials and Git/GitHub configuration;
an unavailable broker must never select a host account. Capture once per
operation so steering does not split a command's Git descendants across people.
The runtime capability may be staged privately for command-time access; it must
not enter the returned launch descriptor or entity records. Core's managed
launchers are an optional reference implementation. Compatible native helpers,
credential helpers, or command proxies can implement the same semantics.

Deploy the updated Core and plugin together. A configured
GitHub connection on an older task provider returns an explicit upgrade error.
Unconfigured providers continue ordinary work without authenticated GitHub access.

Managed GitHub command providers must retain the qualified provider executable
and arguments. Supply helper discovery through the task environment instead of
wrapping that executable. Claude ACPX preserves explicit `BASH_ENV`, `ZDOTDIR`,
`GH_CONFIG_DIR`, and `PAPERCLIP_GITHUB_LAUNCHER_DIR` selectors across the sidecar
boundary. It does not forward GitHub tokens or broker capabilities to the provider.
The helper reads the current task capability at invocation, including after warm
reuse. These selectors must come from the trusted environment owner.
Reference helpers mark only their child operation and reject re-entry before resolving
another executable or capturing credentials. A PATH shim that calls a helper's
absolute path fails with `launcher_recursion_rejected` (exit 126), preventing
recursive process growth. Offline Git fixtures must resolve the native binary
outside managed helper paths and exclude runtime shell startup hooks.


The pure launch factory exports `RUNNER_GITHUB_LAUNCHER_VERSION = 1` for this
contract. A provider must check it as well as the host broker schema and its
Launcher capability before advertising managed GitHub commands. The installed
Runner must match the factory's source revision.

The helper projection is marked by the controller-owned
`PAPERCLIP_GITHUB_LAUNCHER_DIR`. Task overrides cannot supply that marker or the
shell selectors. Run preparation strips stored bindings before secret resolution,
and configured task-environment projections reject the shell selectors too.
