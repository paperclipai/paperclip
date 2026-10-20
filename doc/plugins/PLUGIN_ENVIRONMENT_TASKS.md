# Environment task API

An environment driver can provide a Runner task through a worker hook.
The task API has no shell command or file transfer operation.

This API is a server and worker contract. It does not select an environment
for a native agent or connect a Runner to a run. Those integrations are separate.

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
| `connection` | `connection` | Return an authenticated WSS endpoint and its generation. |
| `status` | `status` | Report the phase and observed process termination. |
| `credentials` | `credentials` | Return the selected account after process termination. |
| `stop` | `accepted` | Stop the task and its descendants. Fence a delayed submission. |
| `complete` | `accepted` | Release task resources after Core saves required results. |

Each result must contain the task ID from the request. Core rejects a result
with a different ID or result kind. A WSS URL must have no user information,
query, or fragment. Return authentication in the secret headers.

`submit` contains the PRP version range, Runner identity, bootstrap ticket,
authorized project IDs, and optional launch limits. It can also contain a saved
task ID for session reuse and a typed Codex or Claude credential. Core does not
supply an executable command or a guest path.

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

This API defines the preparation exchange. Runner transport integration is a
separate change.

## Lease authority

Core calls `environmentRuntimeService.task` with a company ID, a saved lease ID,
and an operation. It derives the plugin and driver from the lease. A change to
the environment configuration cannot redirect cleanup to a new provider.

Before preparation or submission, Core checks the active lease, run, issue, and every project
in the company. It checks the submitting run ID separately from a retained PRP
identity. Session reuse requires the same agent, environment, workspace, and
provider. It also requires a retained source task and proof of termination.

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
