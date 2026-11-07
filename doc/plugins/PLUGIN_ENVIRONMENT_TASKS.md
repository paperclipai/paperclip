# Environment task API

An environment driver can provide a Runner task through a worker hook.
The task API has no shell command. Its optional file-read operation is scoped
to the active task workspace.

This API is a server and worker contract. The [native execution integration](PLUGIN_RUNNER_EXECUTION.md)
connects a task-capable environment to a Runner run.

## Declare the hook

Set `supportsTasks: true` on the environment driver in the plugin manifest.
Implement `onEnvironmentTask` with the SDK types:

```ts
import type {
  PluginEnvironmentTaskParams,
  PluginEnvironmentTaskResult,
} from "@paperclipai/plugin-sdk";

type TaskHook = (
  params: PluginEnvironmentTaskParams,
) => Promise<PluginEnvironmentTaskResult>;
```

Core requires the `environment.drivers.register` capability, a ready plugin,
the manifest declaration, and the worker's `environmentTask` method.
The SDK validates each operation and its result before it returns the result.
See [the schemas](../../packages/plugins/sdk/src/environment-tasks.ts) for all fields.

## Operations

| Operation | Result | Required behavior |
| --- | --- | --- |
| `describe` | `description` | Return the installed Runner version and SHA-256 digest. |
| `prepare` | `prepared` | Prepare the provider configuration for the exact Core requirements. Do not start a process. |
| `submit` | `accepted` | Start the same opaque task at most once. Use the structured launch inputs. |
| `copilot_metadata` | `copilot_metadata` | Verify a Copilot account and model on a private setup lease. Send no prompt. |
| `connection` | `connection` | Return an authenticated WSS endpoint and its generation. |
| `status` | `status` | Report the phase and observed process termination. |
| `check_project_auth` | `project_auth` | Validate the prepared project configuration before managed credential transfer. |
| `read_file` | `file` | Read one bounded, task-scoped file from the active task. |
| `read_state` | `state` | Read the exact retained Runner checkpoint. |
| `archive_state` | `state` | Archive suspended authority with an idempotent archive key. Keep provider session files. |
| `credentials` | `credentials` | Return the selected account after process termination. |
| `stop` | `accepted` | Stop the task and its descendants. Fence a delayed submission. |
| `complete` | `accepted` | Release task resources after Core saves required results. |
| `release` | `released` | End active use of an exact, settled Runner session. Requires `releaseResumeVersion: 1`. |
| `resume` | `resume` | Request the same logical session with a fresh bootstrap ticket. Requires `releaseResumeVersion: 1`. |

For a refused `submit` with `resumeFrom`, a driver can throw an error with
`status: 409`, `code: "SESSION_STATE_UNAVAILABLE"`, and `reason` set to
`"unresolved_operation"` or `"source_state_unverified"`. The SDK worker and
Core preserve only these closed diagnostic fields. They replace the provider
message and omit provider identities and text. Read the validated RPC envelope
with `readEnvironmentTaskErrorDiagnostic`.

This diagnostic does not authorize a retry, replacement, cleanup or state
change. Other task failures keep the existing generic error. An older SDK
does not carry this diagnostic. Operation and call identities, when needed,
must come from Core's own retained records.

Each result must contain the task ID from the request. Core rejects a result
with a different ID or result kind. A WSS URL must have no user information,
query, or fragment. Return authentication in the secret headers.

`submit` contains the PRP version range, Runner identity, bootstrap ticket,
authorized project IDs, and optional launch limits. It can also contain a saved
task ID for session reuse and a typed Codex or Claude credential. Core does not
supply an executable command or a guest path.

## Release and resume

`release` ends Core's active use of an exact, settled Runner session. Core calls
it only after the turn, required events, journal writes, tool results and turn
cleanup have settled. The provider verifies the six-field `identity` and refuses
stale, busy or unsettled requests. `released` does not cancel work or replace
`stop`, `complete`, `archive_state` or the allocation's `environmentReleaseLease`.
Hosts should retain reusable resources when capacity allows, but can reclaim
them under retention and capacity policy. Release guarantees neither retention
nor physical termination. The same contract applies to Codex and ACPX, with no
same-process-ID guarantee.

`resume` requests that same logical session using the source `identity` and a
fresh `bootstrapTicket`. Both operations retain the outer request's authorized
company, environment, task, lease and run scope. Resume requires an authenticated
current claimant run and lease; reject a null `runId`. Verify the source, account,
workspace and current authority before installing the ticket or reserving reuse.
The ticket is bounded transient authentication input, as on submission. Never
copy its bytes into status, metadata, logs, results or durable replay records.

The `resume` result has a closed `outcome`:

- `resumed`: the same logical session is exclusively reserved for this claimant,
  atomically against eviction and competing claims. Core obtains `connection`,
  authenticates with the fresh ticket and performs ordinary `run.attach` with its
  new identity. No new turn is permitted before attachment succeeds.
- `unavailable`: the host knows reuse is impossible, for example after eviction.
  Core may select ordinary recovery, preserving its authorization, credential,
  workspace and stop checks. This is not proof of physical termination.

Source mismatches, authentication failures, conflicting claimants, transport
failures and ambiguous claims remain errors. They must not become `unavailable`,
authorize replacement, or silently create a new logical session.

One release episode is allowed per exact source identity; ordinary `run.attach`
rotates authority before a later release. Release retries replay the original
result without releasing a resumed owner again. Resume retries with the same
source, claimant and ticket reconcile the same claim and original outcome.
Changed claimants or tickets conflict. A lost reply requires reconciliation,
not a replacement ticket or an assumption of eviction. Preserve replay fencing
after reclamation so delayed requests cannot change a newer owner.

Advertise `releaseResumeVersion: 1` from `describe` only when both operations are
implemented. Core must check it before use. Absence keeps the existing lifecycle;
warm or source recovery capabilities do not imply support. Older strict Core
schemas reject this description field, so coordinate advertisement with a
compatible Core version.

Core uses this pair only for explicitly supported warm tasks with a selected
account. It releases after the turn's required events, tool results, journal
writes and cleanup have settled. It keeps the exact session busy until the host
confirms release and Core records that source. Existing tasks without the
capability retain their ordinary warm lifecycle.

Before release, Core stops connection pings and reconnect work while keeping the
existing receive/ACK path open. A confirmed release closes the route and stops
its idle polling. An ambiguous release stays with the original run for bounded
reconciliation. It cannot pass to a new run's task scope. Cancellation or an
expired reconciliation budget uses ordinary host stop and physical cleanup;
it does not change an already completed business result.

Resume first checks the new run's account, credential revision and project
scope. It uses one fresh transient ticket, preserving that exact ticket through
ambiguous replies. Core authenticates the source before warm readiness, provider
preparation and ordinary `run.attach`; no new turn can pass that handover.
Generic RPC errors do not prove refusal or permit a new ticket, reconnect or
turn replay. A known `unavailable` result still requires ordinary physical
cleanup. Transparent cold fallback remains a separate qualification requirement.

A normal Core cache timeout detaches only Core's quiet local owner. The host
keeps its retained resources under its own retention policy. Core's existing
completed-session record stores only the confirmed source, physical task and a
digest of the selected account, credential revision and workspace scope. The
transport returns the exact source after the host's release receipt; Core does
not infer it from a local checkpoint marker, which may still name an older run.
An invalid source receipt or failed proof write keeps cleanup under the same
owner until physical retirement finishes. Later
cache adoption validates that Core-authored proof before claiming or
reconnecting. A stale or missing proof never licenses a claim. A changed
selection remains blocked until guarded retirement/recovery; it does not imply
that a cold launch is safe. Confirmed claim or physical cleanup clears only the
matching proof. Raw tickets are never stored in this record.

These Core paths do not advertise the capability or opt ordinary tasks into a
private host channel. Existing durable lease and plugin-worker idle checks still
apply; retaining a released Runner does not by itself make a tenant safe to sleep.
Provider recovery, bounded host retention and deployment qualification are still
required before activation. Recovery from a Core crash
between claim and source authentication is not qualified by this integration.

## Error codes

Core does not read the text of a task error. To report a failure that Core can
act on, throw `PluginEnvironmentTaskError` with a code from
`ENVIRONMENT_TASK_ERROR_CODES`. The SDK sends only the code as structured RPC
error data.

| Code | When to use it | Core behavior |
| --- | --- | --- |
| `runner_revision_mismatch` | The installed Runner does not match the revision that the plugin launches. Throw it from `describe` or `submit` before you prepare or start a task. | A run that has not started provider work is retried for up to 10 minutes. Agent verification checks again every minute. The task is not blocked during this wait. |

```ts
import { PluginEnvironmentTaskError } from "@paperclipai/plugin-sdk";

if (installed.revision !== expectedRevision) {
  throw new PluginEnvironmentTaskError("runner_revision_mismatch");
}
```

Any other error stays an ordinary setup failure. The source refusal diagnostic above is separate: it uses its own envelope and does not authorize a retry.

## Launch preparation

A provider can return `launchPreparationVersion: 1` from `describe`.
Core can then send the `prepare` operation before `submit`.

The requirements contain the provider, model, policy, run identity, instructions,
and runtime context. They do not contain provider credentials or executable
choices. Resource paths identify source locations. The plugin must resolve them
for its execution environment.

The result contains a configuration ID, requirements digest, and provider
descriptor. The schema is `paperclip.runner.launch-requirements.v1`.
The digest is SHA-256 over the requirements JSON. Sort object keys in lexical
order at every level. Keep array order. Omit absent optional fields.
The execution owner must preserve Core policy and resource assignments.

Preparation must be idempotent for the task and requirements. The plugin owns
configuration storage and cleanup. A late preparation result must not authorize
execution after cancellation. The `submit` operation can reference the saved
configuration with `preparedLaunchId`.

Recovery can supply the prior prepared result. Recovery within the same run
must use the same configuration. A different run supplies its current
requirements. A saved task ID in `resumeFrom` requires the same retained-session
authority as submission.

Core requires preparation version 1 for native plugin execution. It validates
and saves the result before it submits its configuration ID.

### Stopped source reconciliation

A plugin’s `describe` response advertises `codexSourceRecoveryVersion: 1` for
Codex App Server and `acpxSourceRecoveryVersion: 1` for ACPX. It can advertise
either, both, or neither. Each field means the host can verify and restore a
stopped source for that provider without starting another turn. Core requires
the field for the selected provider and verifies the run’s eligibility.

Core admission recognizes native Codex and qualified Claude through ACPX. ACPX
Codex is a different provider and cannot use either attestation. Claude admission
checks both saved and current profiles against Runner’s qualified catalog;
decodable historical profiles do not authorize recovery. Preparation, submission
and attachment retain that provider binding. Runner’s launch factory normalizes
Claude’s model, mode, permissions, effort and runtime content before Core compares
them with the saved source or current owner. Core revalidates the claim and
profiles after worker replies. This admission does not activate executor recovery.
It grants no replacement authority or exception to deterministic recovery refusals.

The authenticated request belongs to
the current run while `prepare` and `submit` carry the predecessor Runner identity.
Core derives this relationship from its saved source-consumer claim; a mismatched
run ID alone never grants recovery. Both operations must name the same `resumeFrom`, exact source Runner identity, and current
`accountIdentity`. The request and lease still belong to the current run.
Preparation must save this source binding with its new configuration. Submission
must verify the same binding before it starts the source process.

Core requires the source run to have a committed successful result, an encrypted
PRP journal, confirmed physical termination, and no other source consumer. Core
claims the source under the current native controller lease. This does not change
the source run's status or result. A stale source controller cannot write its
journal after this claim. Workspace export and settlement holds still apply.
After source submission, the same current owner can prepare its attachment with
the exact source as `priorIdentity`. This does not grant ordinary warm reuse.

The provider must verify the original account, workspace, runtime, and source
ownership before launch. The provider must reject saved active goals, pending tools, ambiguous starts, and
uncertain work before launch. Runner verifies that a saved idle provider remains
idle when restored.
Until the existing authenticated `run.attach` operation changes authority, the
Core retains semantic inputs and sends no fresh predecessor business commands
while the restored source reconciles its journal and known cleanup. Ordinary suspended recovery and live attachment keep their existing
checks. Providers that omit the capability do not support predecessor recovery.

## Launch authentication validation

Declare `projectAuthCheckVersion: 1` in `describe` for each native task launch.
Core calls `check_project_auth` after preparation and before credential transfer.
The request names the configuration ID, provider, and authorized project IDs.
It contains no credential.

A trusted provider can instead return `projectAuthCheckAtSubmit: true` in its
`prepared` result. Core then skips the separate check. This flag delegates the
check to submission; it does not claim that preparation checked authentication.
The provider must validate the effective configuration and current project grants
inside `submit`, before it installs credentials on the execution host or starts
the task. It must reject conflicts and changed preparation before those effects.
Core pins the configuration, provider, and project set on the lease and checks
them again at dispatch. A new preparation invalidates that scope. Providers that
omit the flag keep the separate check. The flag requires a Core version that
supports it; older strict result schemas reject it.

The plugin must check the effective configuration for that prepared launch.
Reject project settings, parent settings, helper commands, or environment routing
that can replace the selected account or redirect its credential.
Keep the checked configuration fixed until submission. If the configuration can
change, reject submission and require new preparation and validation.

Return `project_auth` with the same configuration ID and provider.
Set `allowed: true` only after the checks pass.
Core saves this result on the task lease. Core requires the exact configuration,
provider, and project set before each submission.
A new preparation or check removes the prior validation. A failed check does not
authorize credential transfer. The dispatch update also checks that validation
has not changed while Core waited for database work.

## Retained checkpoint operations

`read_state` supplies the exact durable identity and an optional `resumeFrom`.
`archive_state` supplies the prior identity, a 24-character lowercase hexadecimal
archive key, and `resumeFrom`. Both return `state` with the task ID and Runner
state object. They do not accept a filesystem path.

Core authorizes retained sources with the same checks as preparation and launch.
The plugin must read only that task's state. Archive must require process
termination and exact suspended identity. It must return the same archived state
on retry. It must keep the provider session files. Return an error when the state
is absent or its identity differs. Do not return credentials or environment values.

## Lease authority

Core calls `environmentRuntimeService.task` with a company ID, a saved lease ID,
and an operation. It derives the plugin and driver from the lease. A change to
the environment configuration cannot redirect cleanup to a new provider.

Before preparation or submission, Core checks the active lease, run, issue, and every project
in the company. It checks the submitting run ID separately from a retained PRP
identity. Session reuse requires the same agent, environment, workspace, and
provider. Checkpoint resumption also requires a retained source task and proof of termination.
Opt-in Codex warm reuse instead hands off the same retained process through an
atomic lease transition and an exact, authorized `priorIdentity` preparation.

An internal setup probe can use a private, time-limited lease without a run row.
Core checks the saved probe identity, rejects project mounts, and limits the
Runner lifetime to the remaining probe time.

## Failure and cleanup

A failed submission reply does not prove that the task failed to start.
Core saves the dispatch marker before it calls the worker. Retry against the
same task ID. Do not allocate another task to resolve an uncertain reply.

An accepted stop does not prove termination. Set `executionStopped: true`
only after the Runner and all descendants have stopped. A terminal phase alone
does not permit Core to release execution authority.

Core binds each Runner owner to the physical task ID returned by its description.
An old owner cannot follow a changed lease to stop or complete its replacement.
Late stopped-state, retained-session and credential-handoff writes must still
match that same physical task. A new owner can clean up the replacement.

Core fences new submissions when cleanup starts. It stops the saved task,
checks termination, saves credential results, and completes the task before it
releases or destroys the environment lease. An uncertain result leaves a saved
lease for the cleanup sweep. Cleanup can use that lease after the environment
or run row is deleted.

## Credential writeback

Account selection and credential revision have separate identities. Keep the
selected account fixed for the task. A credential result of `null` means that
cancellation prevented task admission. It must not mean that an export failed.

Core saves the account grant, secret reference, and session epoch on the lease.
It saves no credential bytes or temporary path in lease metadata. After process
termination, it can recover a Codex refresh even if Core restarted. It uses the
existing account comparison and secret service. A revoked grant, replaced
account, or changed session epoch discards the old refresh.

Keep file synchronization and backup outside this API. The provider must retain
recoverable credential state until task completion succeeds.

## Native environment test

The agent environment test can use a task-capable plugin environment. Core
creates a short-lived probe lease with a private run and session identity.
The probe has no project mounts or task tools. It prepares the launch, checks
authentication routing, and verifies the Runner and provider hello exchange.
A passing result requires confirmed cleanup. This test does not enable
heartbeat dispatch to plugin environments.

## Copilot account test

`copilot_metadata` accepts the selected token and an optional model ID. Core
permits it only on an active private setup lease. The provider must use the
verified Copilot metadata client. It must send no prompt and use no project
workspace or tool server. Return the metadata and `executionStopped: true` only
after the probe and its descendants stop. A lost reply keeps the task available
for `stop`, `status`, and `complete`. Core checks the profile and model before
it accepts the account. Do not store the token in task metadata or logs.

A native hello probe requires a managed AI connection and an isolated Runner home.
Without them, the probe fails the `ai_connection_required` check before Core
acquires a lease or calls a task operation. See
[Managed AI connection required](PLUGIN_RUNNER_EXECUTION.md#managed-ai-connection-required).
Only Core can supply the selected account identity and local credential home.

## Fresh attempts

A workspace provider opts in with `workspaceProvider.freshWorkspaceVersion: 1`.
A task environment also declares `environmentDrivers[].freshWorkspaceVersion: 1`
and returns `freshWorkspaceVersion: 1` from `describe`.

Core supplies a server-authorized `fresh` intent on workspace preparation and on
launch-related task calls. `attemptId` is stable across interrupted preparation.
`previousWorkspaceId` identifies retained storage; it is not permission to change
or remove it. The provider prepares a new working directory from the authorized
source and base. It may share repository objects or other immutable storage.
Core does not require a particular Git or filesystem layout.

`recoverySnapshots` contains verified, Core-staged archive and manifest files.
Each file descriptor contains a trusted host path, SHA-256, and byte size. These
paths are host-authored transfer sources, never user-supplied paths or URLs.
Providers verify the bytes and safely materialize each snapshot separately at
`.paperclip-recovered/<operationId>` beneath the new working directory. Preserve
file links safely and include provenance. Never overlay recovered files onto the
clean working tree or overwrite an earlier attachment. Core includes those
relative attachment paths in the new attempt's continuation context.

A provider reconciles the same attempt and workspace identity after an ambiguous
reply. It must not replace the failed workspace or allocate another workspace
when preparation is repeated. Providers without this version remain unavailable
for fresh attempts; ordinary preparation and reuse retain their existing contract.

Core keeps transfer files while preparation is uncertain. Confirmed task completion
and provider workspace removal release these disposable copies. The descriptors
remain stable: a later preparation downloads the same verified files again.


## Task workspace files

Core uses `read_file` for `call_api` file uploads and `register_deliverable`
when a plugin owns execution and advertises `workspaceFileReadVersion: 1` in
`describe`. The request includes the submitted Runner identity,
validated project IDs, a canonical relative or absolute path, and a byte limit (at most 10 MiB).
The provider resolves paths within locations granted to the active task. Relative
paths resolve from its prepared workspace. Absolute paths can select another
granted location such as agent home, but never a supervisor path or another
agent's files. Core does not prescribe provider filesystem layout.

The provider must reject inactive tasks, path escapes, symlinks, hard links,
non-regular files, protected credentials, oversized files, and files that change
while being read. Return canonical base64, byte size, and a SHA-256 digest in a
`file` result for the same task. Core validates the result and rechecks authority
before publishing it. Deliverables additionally verify the caller's expected
size and digest. Providers without this operation fail closed; Core never falls
back to reading remote paths on the server. Existing artifact uploads are unchanged.
