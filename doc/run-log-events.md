# Run-Log Events

Run-log events write to the `heartbeat_run_events` table
(`packages/db/src/schema/heartbeat_run_events.ts:6-20`). They are not
Paperclip Telemetry events, and they are not OpenTelemetry exports. A run-log
event needs no operator endpoint.

## Startup reuse evidence

`run.startup.reuse` uses schema `paperclip.startup-reuse.v1`. Each receipt names
one layer: `environment` (the lease), `workspace`, `runner`, `provider_process`,
or `provider_session`. Its state is `reused`, `fresh`, `unknown`, or
`not_applicable`. Reasons use a closed set: `verified_reuse`, `created`,
`replacement`, `not_found`, `expired`, `identity_mismatch`, `resume_failed`,
`configuration_changed`, `tools_changed`, `workspace_changed`, `cache_miss`,
`not_applicable`, and `evidence_missing`. No paths, identifiers, configuration
values, or exception messages enter these fields.

Provider-process receipts carry a cumulative `providerLaunchCount` for the run.
`null` means unobserved; zero requires a physical launch observer. Direct ACPX
processes count initial launches and respawns, including launches during retries.
On the remote process-session bridge, ACPX observes the host relay rather than
the sandbox provider. Provider-process reuse and launch counts stay unknown on
that transport. Native Runner session events establish session continuity, but
do not establish provider-process reuse or its launch count. Those values stay
unknown without physical evidence. The final ACPX receipt does not wait for
persistence, so a stalled diagnostic sink cannot hold the staging lease.
The existing successful `runner.process.launch` performance receipt establishes
a fresh Runner process, independently of provider-session continuity.

The Product E2E result stores `startupReuse` by run, and its dashboard displays
each layer, its reason, and the launch count. `warm` requires all applicable
layers to be reused and zero observed provider launches. `cold` requires all
applicable layers to be fresh. Some reuse with other fresh or missing evidence
is `partial_reuse`; otherwise the label is `unknown`. Fresh decisions dominate
later reuse receipts within a run. Legacy runs without receipts retain unknown
layers and a null launch count. Session IDs and follow-up turns never establish
warmth. These events stay in the local run log; they add no first-party Telemetry.

## Ordinary event persistence

Events without a native source identity or retry-exhaustion receipt use one
atomic PostgreSQL statement. The statement checks the stored run's company and
agent, allocates its next sequence, and inserts the event. An insertion failure
also rolls back the sequence allocation. The returned row uses the existing
column decoders, including the lossless payload codec. Callers still wait for
the durable write before they publish or acknowledge the event. Native-source
replay and retry-exhaustion deduplication retain their existing transaction path.

## Provider-pack preparation timing

The existing `run.performance.span` event also records `provider_pack.select`,
`provider_pack.discover`, `provider_pack.verify`, `provider_pack.verify_preinstalled`,
`provider_pack.link_preinstalled`, `provider_pack.clear_stale`, `provider_pack.upload`,
and `provider_pack.verify_uploaded`. Selection records `stateSource` as `staged`,
`preinstalled`, or `uploaded`. Its closed reason is `verified_pack_reused` or
`cached_packs_unverified`. A verification failure describes an unusable candidate;
it does not identify a particular compatibility mismatch or a failed run.
Harness startup also records `harness_state.inspect`, `harness_state.path_check`,
and `harness_state.launch_material` for remote state inspection and fresh launch
material. These events retain the existing schema and carry no paths or exception strings.
They also become native Observability spans only with an operator OTLP endpoint.

## Native PRP Run-Log Events

`auth.credentials.updated` is a runner-produced PRP event for a change to a
supported credential store, including account identity changes and later token
refreshes on the new account. The bundled transport awaits a host commit callback
before acknowledging delivery, including during warm idle and provider cleanup.
The callback writes directly to the bound run through the shared run-log writer.
Its separate credential source namespace avoids collisions with driver-normalized
source sequences and deduplicates retries using the original PRP event identity.
The original envelope is retained in `prpEvent`. Its payload contains only a
provider, an opaque binding ID, a revision, and a detection method. It contains
no credentials, account identity, file path, or credential fingerprint. The
consumer can use the event to read the updated credentials through its existing
private credential channel. This run-log event stays in the instance database.


`native.recovery.execution_reclaimed` records an atomic same-run recovery claim
that restores a released task execution binding. The claim locks the task,
coordinator, and original run in that order. It preserves the assignee and checks
current execution/checkout owners, other live work, dependencies, pause holds,
and stop/successor records before restoring the binding. Attachment authorization
keeps its existing requirement for that exact binding. Skipped retry candidates
wait 30 seconds before recheck so they cannot fill every bounded claim batch.
Undated retries sort first. A failed candidate cannot discard earlier committed
claims. Queued waiters do not block the original execution owner from recovery;
they still wait for that owner to settle before normal queue promotion.
This is local run-log data.

Fresh remote Codex model substitution emits `runner.model_fallback` on the
system stream with `warn` severity. Its payload contains `requestedModel`,
`effectiveModel`, and `codexCliVersion`. It records a preparation choice before
provider launch, not a failed turn or a retry. The same substitution appears as
a system warning in the task conversation. It remains local run-log data.

The hidden native coordinator writes each validated PRP event to the bound
run's existing event stream before it acknowledges the runner. The row keeps
the PRP `eventType`, source instance, source event ID, source sequence, protocol
schema version, and a SHA-256 digest of the canonical stored envelope. Its
payload is `{ "prpEvent": <canonical PRP event> }`.

Native API tool events omit HTTP request and response bodies from durable history.
This includes serialized provider `contentItems`, legacy HTTP receipts and
`call_api` arguments. Saved receipts retain the operation and call IDs, success
flag, HTTP status and content type when present. The body becomes
`***REDACTED***`, with `apiPayloadRedacted: true` and `apiPayloadSha256`, a SHA-256
digest of the original payload. These digests distinguish duplicate events from
changed payloads; they cannot recover omitted bodies for debugging or replay.
The model receives the original authorized response. Credential-bearing mutation
receipts use encrypted storage separately from this run log.

Checkpoints and completion records apply the same redaction. Completion retries
compare stored and expected payloads through the control-plane port's idempotent
`normalizeReplayPayload` projection, so a saved redacted result can be confirmed
without restoring API bodies. Ports without a projection compare their original
payloads. Repeated redaction preserves the original digest and detects changed
private payloads.

The native runtime passes this projection through backend recovery to the Codex
driver. Recovery compares saved semantic results and turn fingerprints with
provider history through the same representation. A private body change retains
its distinct digest and fails recovery; an unchanged body does not require
restoring its plaintext into the checkpoint.

PostgreSQL JSONB cannot represent NUL (U+0000), which can occur in command
output such as Vite virtual-module paths. The run-event payload column uses a
lossless storage codec for these events: the JSONB projection renders NUL as
the literal `\u0000`, and the reserved `$paperclipRunEventJsonV1` field contains
the original serialized JSON as a doubly escaped string. Ordinary payloads
retain their existing representation. Drizzle reads restore the exact stored
payload before replay, hash validation, redaction, or API presentation. SQL
queries can still inspect ordinary routing fields in the projection; raw SQL
readers of the whole payload must apply `decodeRunEventPayload`. The column
remains JSONB and requires no schema migration.

The writer locks the native `heartbeat_runs` row and allocates the existing
per-run `seq` cursor. A byte-equivalent retry reuses the first row; a changed
retry or source-sequence gap is rejected. Company, issue, agent, run, session,
and runner-source bindings must match the persisted native run. Bootstrap
tickets, reconnect leases, authentication proofs, encryption keys, and raw
credential material are never written to the run log.

These records remain run-log events. They do not create an OpenTelemetry or
Paperclip Telemetry export, and legacy adapters do not use this writer.

## Semantic Settlement Diagnostics and Retry Logs

Before interrupting a Codex turn, the runner durably records a
`harness.diagnostic` event with code `provider_interrupt_requested`, the stop
reason, provider turn ID, and pending tool call IDs. A harmless identical result
replay records `semantic_tool_result_duplicate` with warning severity, call ID,
operation ID, and result digest. It does not fail the task or create a user
attention request. A true conflict includes the call and operation IDs and both
result digests in its error; full arguments belong to the canonical semantic
input record, not the error message.

Incomplete close emits the bounded `native_session_settlement_incomplete`
runner diagnostic. Its evidence includes runner suspension, provider drain,
final provider state, pending call/operation/source-event IDs and input digests,
and incomplete result-delivery command IDs and statuses. If execution and
cleanup both fail, execution retains its original error identity and cleanup is
attached as `cleanupError`.

Semantic settlement also includes up to 20 content-free failure records, with
the call ID, operation ID, stage (`dispatch` or `persist_result`), and cause.
Causes distinguish an oversized command, a full command journal, known storage
errors, dispatcher rejection, and other persistence failures. Exception messages
and tool results are excluded. These diagnostics do not authorize replay of an
operation whose outcome is unknown.

Instruction writes also commit an `agent.instruction_write_attempted` activity
row and a run-scoped `instructionToolAttempts` entry before permitting the
filesystem effect. They retain the call ID, operation ID, and input digest, not
instruction text. A later transaction rollback cannot erase this attempt proof.
A missing success or definite pre-write failure receipt means the outcome is
unknown, even if the current file contains the requested text. Known validation
and stale-base failures are saved under the attempt's `failure` entry and replay
their original status, message, and details without a new write. Unknown
outcomes remain blocked until reconciled; a
committed receipt with a lost acknowledgement can replay its exact result.

The NDJSON output log appends across repeated `begin` calls for one run. Each
new handle adds an `attemptId` to its lines. If the local file is absent and a
durable S3 mirror exists, `begin` restores that prefix before appending. A
failed restore must not replace the mirror with an empty or partial attempt.
Publishing a restored prefix uses an atomic create-if-absent operation, so a
concurrent restore cannot overwrite lines another attempt has already appended.
Earlier attempts therefore remain available for incident diagnosis. Existing
records without `attemptId` remain readable.

These records use the instance run log and its configured storage. They add no
Paperclip Telemetry or OpenTelemetry export.

## Omitted Unsafe Workspace Export

`workspace_export_omitted` is an informational system event in the local run log.
Its payload is `{ "reason": "restore_unsafe_archive" }`, with `"legacy": true`
when recovering an unsafe failure from an older controller. It records that native
finalization discarded an unsafe export and continued with the accepted result.
It contains no archive names, link targets, or raw error details. It does not
create a task warning, recovery action, Telemetry event, or OpenTelemetry export.

## Native Restart Recovery Run-Log Event

Paperclip writes a `native.recovery.transition` event for every native restart
classification and for graceful restart suspension. This immutable run-log
record lets operators reconstruct recovery decisions without exporting data to
Paperclip Telemetry or OpenTelemetry.

The payload contains the restart kind, recovery request id when one exists,
runner disposition, and the controller generation and provider attempt for a
claimed recovery. Live-runner adoption also records the runner PID, process
group, and process-start fingerprint. A non-claim disposition records a bounded
reason instead. Graceful suspension records the signal and confirms that it did
not create a retry run.

The event never includes bootstrap tickets, reconnect leases, authentication
proofs, encryption keys, environment variables, provider credentials, command
arguments, or an unsanitized stderr stream. Detailed failed-attempt diagnostics
remain in the bounded `native_run_finalizations.recovery_history` ledger.

`native.remote_runner_recovery_failed` records the closed `stage` and `reason`
when remote identity verification fails, including admission failures before the
execution coordinator opens. Unavailable probes are retried within a shared
30-second deadline; identity conflicts are not retried. The event distinguishes
an unreadable identity from a confirmed missing process and contains no command
output or credentials. Saved-state read failures use `state_read_failed`; malformed
saved JSON uses `state_invalid`. It does not itself authorize replacement or cleanup.

For a prepared remote workspace interrupted before its first executor claim,
that ledger records `remote_execution_never_claimed` with a
`bootstrap_incomplete` disposition. The provider attempt remains zero during
classification; the executor increments it before starting provider work.

For a local Codex turn lost while runnerd was stopped, the canonical `turn.failed`
event retains `error.code: "provider_turn_lost_on_restore"` and
`error.recoverable: true`. It records the interrupted turn, not a final task
outcome. There is no synthesized result for that interruption. An admitted
same-session continuation emits its own `turn.submitted`, accepted turn ID, and
terminal events; only the final outcome closes the run. Reconstructed thread
history retains the original error so reconciliation and live delivery agree.

## Native Local Process Stop Evidence

The server writes `native.local_process_stopped` in the same transaction that
clears a local run's process identity, after it verifies that its PID and process
group are absent. The payload contains only those process IDs. Remote process
IDs are never checked against the control-plane host.

The server writes `native.process_start_requested` before a backend can spawn,
and `native.process_identity_recorded` when it stores a new native process
identity. Either invalidates an earlier local stop receipt, including a crash
before the new PID callback. Continuation admission accepts only the latest
server-authored event among these three types; provider
source events cannot supply stop authority. These records stay in the local run
log and do not add Telemetry or OpenTelemetry data.

## Verified Local Codex Replacement Evidence

The server writes `native.stopped_text_turn_verified` in the same transaction
that schedules a fresh successor for a stopped local Codex run. It records the
runner and provider process identities, retained-state digests, provider thread
and turn IDs, and IDs of exactly receipted task-completion calls. The server first
checks the complete turn inventory, process-stop receipt, and execution binding.
Unknown actions or changed retained state prevent this event and replacement.

The record documents why the old execution can be retired. It does not make the
old session resumable, rewrite provider files, or authorize replay on its own.
It remains in the local run log and adds no Telemetry or OpenTelemetry export.

## Sandbox Startup Run-Log Event

Paperclip writes one `run.startup.step` event to the run log for each bring-up
step. This event is a run-log record, not a first-party telemetry event. The
generated telemetry contract does not cover it, so this section is its canonical
contract.

The event payload carries only three fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `step` | string | The bring-up step name, for example `stage.sync`. |
| `durationMs` | number | The wall time of the step. A skipped step reports `0`. |
| `outcome` | string | The step outcome (`ok`, `skipped`, or `failed`). |

The event no longer carries the per-step round-trip count or the provider
duration fields. It dropped `roundTrips`, `providerExecMs`, `providerGetMs`,
`createRuntimeMs`, and `ensureSessionMs`. The startup spans in
[`doc/observability.md`](observability.md) carry that detail now. The
`sandbox.exec` child spans hold the round-trip and provider durations. The
`acp.handshake` step span holds the create-runtime and ensure-session
sub-times.

To read the detailed timing, use the startup spans. The spans need an OTLP
endpoint. A run with no endpoint keeps only the three run-log fields above.

## Run Phase Timing Run-Log Event

Paperclip writes one `run.phase.timing` event to the run log for each
run-lifecycle phase. This event is a run-log record, not a first-party telemetry
event. The generated telemetry contract does not cover it, so this section is its
canonical contract. The producer is `emitRunPhaseTiming` in
`packages/adapter-utils/src/acpx-engine/startup-timing.ts`.

The event payload carries only three fields.

| Field | Type | Meaning |
| --- | --- | --- |
| `phase` | string | The run-lifecycle phase name from the closed allowlist below. |
| `durationMs` | number | The wall time of the phase. A negative or a non-finite value clamps to `0`. |
| `outcome` | string | The phase outcome (`ok` or `failed`). |

The `phase` field is one member of a closed, low-cardinality allowlist. The
producer drops any event whose phase name is outside this allowlist, so a
free-form label never reaches the run log. The allowlist has twelve phase names.

| Phase | Meaning |
| --- | --- |
| `place_workspace` | Place the run workspace. |
| `start_transport` | Start the agent transport. |
| `create_runtime` | Create the agent runtime. |
| `ensure_session` | Ensure the agent session exists. |
| `configure_session` | Configure the agent session. |
| `prepare_turn` | Prepare the turn. |
| `turn` | Run the turn. |
| `end_session` | End the agent session. |
| `settle_reuse` | Settle the session for reuse. |
| `stop_transport` | Stop the agent transport. |
| `sync_back` | Sync the workspace back. |
| `release_staging_lease` | Release the staging lease. |

The payload never carries a command, an argument, a path, an environment value,
or a raw identifier. The event rides the `ctx.onEvent` run-event bridge and is
run-log-only. It needs no OTLP endpoint.

## Workspace Restore and Settled Run Measurements

The heartbeat controller writes these records with `eventType: "lifecycle"`,
`stream: "system"`, and `level: "info"`. The event name below is its `message`
and its payload's `phase`. They remain in the instance run log and add no
Paperclip Telemetry or OpenTelemetry export.

| Event | Payload fields besides `phase` | Meaning |
| --- | --- | --- |
| `workspace_checkpoint` | `mode`, `scannedEntries`, `changedFiles`, `payloadBytes` | Metrics for a validated sparse checkpoint, or a full restore fallback. |
| `workspace.restore` | `durationMs` | Wall time around native workspace restoration. |
| `task.run.measured` | `durationMs`, `outcome`, `durableSettlement` | Wall time through terminal owner cleanup, with the persisted terminal run status and `durableSettlement: true`. |

For `workspace_checkpoint`, `mode` is `"sparse"` or `"full"`. Sparse metrics
count snapshot entries in `scannedEntries`, regular files in the validated
downloaded payload in `changedFiles`, and their total bytes in `payloadBytes`.
Deleted entries and symlinks do not add to the regular-file count or byte total.
Full fallback reports all three counts as `null`: unavailable, not zero. A run
can emit multiple checkpoint records while restoring its repositories. These
payloads contain no paths, filenames, file contents, or credentials.

`workspace.restore` is emitted when the timed restoration exits, including an
exception. It has no outcome field and does not by itself prove restore success.
Its producer is the native workspace sync `onPhase` callback.

`task.run.measured` is emitted only after the controller observes a terminal run
with no remaining native runner ownership. Its duration starts at `startedAt`,
or `createdAt` if the run never started, and includes preparation, execution,
finalization, and cleanup. It is not model-only time; the creation-time fallback
also includes time spent queued. `outcome` is the actual terminal status, such as
`succeeded`, `failed`, or `cancelled`. Provider turn completion can precede this
settlement record. The record does not imply exactly-once emission across
controller recovery, and failure to write it is logged without changing the
already-settled outcome.

## System notices and final replies

Automatic comments with a stored `system_notice` presentation, including
workspace-ready notices, remain available as progress information. They do not
occupy the run's final reply slot. Final response selection still preserves
ordinary explicit agent comments and excludes receipt-bound generated progress.

## ACP terminal failure diagnostics

The shared ACP adapter engine preserves typed terminal session failures in the
run error, the `acpx.error` transcript record, and
`heartbeat_runs.result_json.terminalSessionFailure`. The structured diagnostic
contains the provider category, title, and details. It works when raw provider
tracing is disabled. The existing UI and CLI render the diagnostic as an error,
not as assistant output or an automatic task response.
Issue continuation summaries and session-compaction handoffs retain only the
generic failure category; provider diagnostic prose is not copied into prompts.

Both pinned ACPX patches pass complete title and detail strings to the in-memory
callback. The engine redacts configured environment values (including resolved
secrets with arbitrary variable names), launch environment values outside a
closed allowlist of public process settings, known boolean flags, and run identifiers,
connection URL passwords, the run API key, and common credential forms before
truncation. It removes control characters,
retains line breaks for JSON and stack traces, and preserves up to 4,096 title
characters and 24,576 detail characters. These bounds also keep the escaped
transcript JSON below the server's 64 KiB chunk limit. Longer fields end with an explicit
omission count and appear in `truncatedFields`. The error message includes the
same sanitized text. Ordinary run retrieval preserves the bounded structured
diagnostic even when multibyte text or other result fields exceed the result
byte budget. In that reduced response, title and details have 1 KiB and 8 KiB
byte budgets, including truncation markers. `retrievalTruncated` directs callers
to the full adapter-bounded text in the run error or transcript. Other provider
metadata and action payloads are not copied.

Recovery still uses the typed failure category and the adapter's existing
classifier. Provider warnings do not become failures, and timeouts or lost
control channels keep their authoritative failure messages. These diagnostics
stay in the instance's run records and configured run-log storage. They add no
Paperclip Telemetry or OpenTelemetry export.

## Related instrumentation

The sandbox duplex transport also writes one run-log event as one of its three
sinks. See the
[Sandbox Duplex Transport Instrumentation](observability.md#sandbox-duplex-transport-instrumentation)
section in the Observability contract.

## Execution recovery

Cancelled runs retain `resultJson.cancellation`: a closed `source` label
(`operator`, `queued_message`, `shutdown`, `provider`, `transport`,
`control_plane`, `controller_lease`, or `unknown`), whether the stop was expected,
the initiator, reason, and recording time. Recorded stop intent survives adapter
completion. `controller_lease` means the host stopped its own legacy adapter
after it lost the durable controller lease; the reason names a closed cause
(`renewal_rejected`, `renewal_deadline`, or `renewal_error`).
A lease lost during run setup (for example a rejected renewal while preparing
the workspace) settles the run `failed` with error code `controller_lease_lost`,
the same `controller_lease` cancellation evidence, and
`executionRecovery.providerWorkStarted: false`. Recovery retries it as transient
infrastructure instead of blocking on `setup_failed`. A setup-phase error after
provider dispatch began keeps `setup_failed`, so started work is never retried.
The local lifecycle event includes this evidence. Started cancellations without
an expected stop are also reported to Sentry; its cancellation diagnostics contain
only source, expectedness, initiator type, and the closed lease-loss cause, never
initiator IDs or reason text.
A lease loss also records `resultJson.controllerLeaseLoss`, including a loss
during setup that fails the run before adapter dispatch. It holds the closed
cause and the watchdog timings in milliseconds: `sinceRenewalMs` (since the
last successful renewal), `renewalPendingMs` (age of a renewal query still in
flight, or `null`), `deadlineLateMs` (how late the deadline callback ran, for
`renewal_deadline` only), and `renewalCount`. A long `renewalPendingMs` points
at a stalled database query; a long `deadlineLateMs` points at a blocked event
loop. Failure reports carry these bounded numbers and the cause label only.
Historical ambiguous cancellations stay `unknown` and do not authorize replay.

Provider tool-definition validation failures use
`provider_tool_definition_invalid` / `configuration`. Automatic retry and
continuation recovery stop until the configuration is repaired. Classification
uses raw provider diagnostics in memory before redaction; stored diagnostics
remain redacted and bounded.

Provider identity diagnostics remain in the local run log. They record the notification method, expected and received thread/turn identifiers, and the classification (root, verified descendant, stale, unrelated informational, or invalid authoritative). They omit the original provider payload and credentials. Repeated informational notices are bounded.

Ignored unrelated Codex notifications use `harness.diagnostic` with code
`codex_unrelated_information`. The payload retains only the bounded provider
method and expected/received thread and turn identifiers. Account updates, skill
changes, and unrelated thread information do not create a provider notice in
chat. Chat also omits the matching notice stored by older runners. Real provider
warnings and errors remain visible.

Recovery lifecycle events retain the original structured failure code, retry attempt, next retry time, and predecessor/successor identifiers. Durable status delivery uses an idempotency marker; delivery grants no provider authority. Failed publication is retried without repeating provider work. These records are not first-party Telemetry.

An unstarted legacy conversation retry waiting for execution cleanup retains
`resultJson.executionWait` with the issue, blocking run, and
`execution_owner_active` cause. A local lifecycle event records the wait and the
unchanged scheduled retry attempt once per blocking run. Repeated scheduler
checks update the same retry row without repeating that event. Promotion removes
this ownership-wait marker after cleanup; other execution holds retain their
existing dispatch gates.

If execution-continuation setup finds that a task no longer exists, is closed,
or its owner changed, the existing cancellation settlement records
`continuation_task_ownership_changed`. The run and wake request become cancelled
before adapter dispatch, with the run-log message
`stale execution continuation cancelled before dispatch`. Immediate recovery is
suppressed. Missing source context, authorization failures, and other setup
errors retain their failure classification. An untyped error with the same
message is also still a failure; cancellation requires the typed ownership guard.

Bounded retry exhaustion writes one lifecycle receipt per run, retry reason,
scheduled attempt, and retry limit. Repeated or concurrent recovery checks reuse
that receipt, including receipts from earlier builds, without advancing the event
sequence or publishing another live event. Attention reads select the latest
matching receipt in PostgreSQL and project only the run's issue/task identifiers
from its context, so historical duplicate receipts cannot multiply run contexts
in server memory. Existing duplicate events do not require deletion or migration.

### Workspace restore failures

Legacy adapter results can carry `workspaceRestoreFailure` with the code
`restore_permission_denied`, `restore_lock_timeout`, `restore_unsafe_archive`,
or `restore_failed`. The heartbeat records `workspace_restore_failed` and keeps
the run failed and the workspace-finalization barrier closed. Available output,
usage, session metadata, and the previous execution outcome survive settlement.
`executionBeforeRestore` retains the earlier error code, exit code, signal, and
timeout flag. The ordinary redacted error field retains an earlier error message.

The chat reports the restore phase separately from a missing final response.
A saved-plan link requires a stored document and its run-bound revision or a
matching run-bound review record. Older unclassified failures use neutral wording. Diagnostics show only
a validated relative member path, never an archive link target or host path.

An unsafe archive or an outbound confinement refusal keeps the existing execution recovery hold, including across
conversation resets. It cannot start another model turn until an operator uses
the existing recovery action to record `executionReconciliation` with
`workspaceRepairEvidence` (20–12000 characters). This evidence must describe
verified safe staging or repair for the referenced failed run. It does not grant
plan approval. Saved comments, document revisions, and confirmation IDs and
states stay unchanged. Recovery uses the existing delivery identity and links
the successor to the original failed run. Repair does not reset the automatic
retry budget. Transient failures retain the existing
bounded retry policy. Archive confinement remains required.

Sandbox restore tasks also write a `Workspace restore diagnostic` line to the
run log on failure. `phase` is `workspace` or `asset`, so a failed staged-asset
copy-back (such as credentials) can be distinguished from workspace restoration. The line
contains only an allowlisted OS/transport `errorCode` (otherwise `unknown`), an
optional numeric HTTP error status, and an optional bounded process exit code.
Up to four nested causes are inspected. Messages, URLs, filesystem paths, asset
names, credentials, and response bodies are excluded. Every failed outbound
task emits its own diagnostic; nested repository failures are logged once by
the enclosing workspace task. The original error and restore safety policy are
unchanged. These lines stay in the instance run log and its configured durable
storage, and are not new first-party telemetry events.

Native sandbox `environmentSyncOut` errors preserve allowlisted error codes and
bounded HTTP/exit statuses across worker RPC for this diagnostic line. The host
revalidates the envelope and keeps the original failure and recovery policy.
Provider messages, paths, response bodies, credentials, and arbitrary error data
are not copied into the new envelope. Older workers can still report `unknown`.

The optional `step` identifies the failed restore operation. For
`phase=workspace` and `step=git_integration`, `gitCommand` identifies one fixed
command family (`rev_parse`, `symbolic_ref`, `merge_base`, `merge_tree`,
`commit_tree`, `update_ref`, or `log`). `gitFailureKind` is `merge_conflict`,
`invalid_object`, `ref_conflict`, `permission_denied`, or `unknown`; it is a
bounded diagnostic clue, not a new recovery or retry decision. Only supported
exit/OS codes and recognized Git messages produce a specific classification.
No command arguments, stderr, filenames, repository URLs, or ref names are saved.
The same closed fields persist in `workspaceRestoreDiagnostic` and are
revalidated before projection into an enabled Sentry failure report.

## Codex resume usage snapshot

The native runner retains a bounded local `harness.diagnostic` event with code
`codex_resume_usage_snapshot`. It identifies `thread/tokenUsage/updated` as
`resume_usage_snapshot`, retains the reported thread and completed-turn IDs,
and records cumulative usage counters. It does not include provider credentials
or message content. The event establishes the accounting baseline; it is not a
new billable usage receipt or a user-facing provider warning. Other provider
identity checks remain in force.

## AI subscription contention

A fresh task execution cannot enter this wait. A run that already entered this
wait writes an informational `lifecycle` event to the local run log. Its
payload contains only `retryScheduled`, a boolean that reports
whether the scheduler created a retry.
The message distinguishes an automatic retry from work that is no longer eligible.
This pre-provider wait records `ai_connection_busy` on the cancelled run and does
not consume the provider-failure retry allowance. The event contains no credentials
and creates no Telemetry or OpenTelemetry export.

## Managed Agent File Save Receipts

The server writes `instruction_save` after managed file collection or a warm
turn checkpoint. The payload includes the save state, instruction entry path,
storage warning, and error code/message. Agent-directory receipts identify
`contract: "agent_files"` and the applied candidate hash. Legacy instruction
receipts instead identify the saved revision.

A validated warm checkpoint reports `saved` or `unchanged`, even though its
working directory remains owned by the live session. An unstable checkpoint
reports `pending_collection` until stopped collection produces a final receipt.
Successful checkpoints can include `checkpointStats`: `scannedEntries`,
`hashedBytes`, `copiedFiles`, and `copiedBytes`. These counts describe that
capture, not cumulative traffic or an atomic snapshot of background writers.
They contain no file contents. The receipt remains in the instance run log;
it adds no Paperclip Telemetry or OpenTelemetry export.

If instruction-copy release throws, `instruction_cleanup` records a warning
with payload `{ "state": "deferred" }`. The existing working-copy recovery sweep
retries cleanup. This event preserves the run outcome and does not claim a file
save; `instruction_save` remains authoritative for collection. The event contains
no raw exception, host path, file contents, or lock-owner metadata. Failure to
write the warning must not replace the provider outcome or stop lease release.

## Agent observability availability

`agent_observability.unavailable` is one warning for a preparation snapshot that
cannot apply company export settings. Its payload contains only a closed reason
and the settings revision. It carries no endpoint, credential, secret reference
or resolver error. Recording the diagnostic never contacts a destination.
