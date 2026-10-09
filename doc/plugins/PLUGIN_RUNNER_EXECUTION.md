# Plugin-provided Runner execution

Plugins provide Runner execution through environment drivers. The plugin prepares
the task's project and repository storage, starts Runner, and provides its Paperclip
Runner Protocol (PRP) connection. The plugin owns resource preparation and task
lifecycle. Declare `supportsTasks: true` on the driver and
implement `onEnvironmentTask`. The worker advertises `environmentTask` during
initialization. Both declarations must be present. The existing
`environment.drivers.register` capability applies.

The server-only `environmentRuntime.task({companyId, leaseId, operation})` method
loads the persisted lease and its run. It resolves the exact plugin recorded at
acquisition. It supplies the agent and issue context and validates requested
projects against the company. The persisted lease determines the plugin and
execution identity. An environment edit cannot redirect an existing task to a
replacement provider. The caller must
already authorize access to the company.

Submit includes `projectIds`, the projects whose storage the task needs. The host
checks that every ID belongs to the task's company and passes the validated list
to the plugin. The plugin resolves those projects into provider-specific storage
and mount inputs. The plugin prepares project and repository volumes before
starting Runner; PRP carries the subsequent Runner session.

This contract supplies execution capabilities. It does not select a provider for
heartbeat runs, stage runtime assets, or replace native Runner startup. Consumers
must integrate those steps before enabling task execution. Readiness checks remain
separate. No browser endpoint or automatic provider selection is added.

## Lifetime and operations

Acquire the environment lease before submitting a task. The provider lease ID is
the task's durable attempt ID. Save it before a remote call. Do not use a persistent
machine ID as this task ID. Multiple attempts can use the same underlying resource. Provider task IDs are
opaque strings; each provider owns its addressing constraints.

- `submit`: supplies a unique list of up to 64 project UUIDs, Runner identity,
  harness, the client's supported PRP version range (`runner.protocolMin` and `runner.protocolMax`, inclusive), and a transient
  bootstrap ticket. The Runner run and lease IDs must match the persisted host records. Only a running run with an active,
  unexpired lease can submit.
- `status`: returns the phase and optional exit code. Optional `executionStopped`
  is live provider evidence that the complete task process tree has stopped.
- `connection`: returns a private authenticated WebSocket endpoint for a running
  task. The tenant connects to this provider endpoint. Transport credentials remain
  on the server. PRP authentication still binds
  the Runner to its authorized run.
- `complete`: releases task grants according to the provider's policy. It does not
  imply that the process or its descendants stopped.
- `stop`: requests cancellation of the task. An accepted request is not a process
  termination receipt. Reconcile status before treating execution as stopped.

Submit the task, wait until it is running, then request `connection` and connect
to its WSS endpoint with the returned headers. The provider must select a Runner
whose supported PRP range overlaps the client's range. The client uses that same
range during the PRP handshake, which negotiates the highest shared version and
verifies Runner identity and artifacts before execution.

Submission, completion and stop return `accepted`. Acceptance does not imply
readiness or success. Status and connection return distinct typed results. Every
result echoes the task ID and is checked by both the worker SDK and the host.

## Retry and credentials

A timeout may follow successful submission. Retain the same task ID and launch
configuration, inspect status, and retry the exact request when needed. Never
allocate a second attempt merely because the response was lost. Providers must
reject conflicting reuse and deduplicate identical submissions, including after a
terminal outcome. A new execution attempt requires a new lease and task ID.

Do not store bootstrap tickets, connection headers, or provider credentials in
lease metadata, plugin state, run profiles, logs, or browser responses. The host
sanitizes worker errors. Treat a connection result as credential-bearing material.
An endpoint is transport access, not a replacement for the Runner protocol's
identity and artifact verification.

Providers own resource-specific credential lookup, mounts, task status, and cleanup.
Task lease cleanup must never destroy a longer-lived resource as an implicit
fallback. Unsupported operations and unavailable providers fail closed.

Cleanup operations (`status`, `complete`, `stop`) remain available when an
environment or run has been deleted. The corresponding `environmentId`, `runId`,
and `agentId` can be null. Providers must use their persisted lease binding for
cleanup; they must not need a current project or environment configuration.
Submission and connection require the environment and running run to still exist.
Cleanup receives an empty `projectIds` list and uses the persisted task binding.
