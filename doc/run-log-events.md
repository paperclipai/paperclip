# Run-Log Events

Run-log events write to the `heartbeat_run_events` table
(`packages/db/src/schema/heartbeat_run_events.ts:6-20`). They are not
Paperclip Telemetry events, and they are not OpenTelemetry exports. A run-log
event needs no operator endpoint.

## Choosing the authoritative evidence

First identify the run's adapter and runtime mode. A process-adapter run uses
`heartbeat_runs`, `heartbeat_run_events`, its persisted `context_snapshot`, and
the linked wake/retry records. An empty `native_run_results` or
`native_run_finalizations` table does not establish missing process-adapter
evidence: those tables belong to the native runner protocol.

Captured stdout and stderr are separate from the structured event rows. For a
`local_file` log, resolve `heartbeat_runs.log_ref` beneath `RUN_LOG_BASE_PATH`
when configured, otherwise beneath the instance's `data/run-logs` directory.
Do not resolve it beneath the worker scratch directory or a guessed `logs`
directory. Prefer `GET /api/heartbeat-runs/:runId/log` with `offset` and
`limitBytes`; the store owns range reads and any configured durable fallback.
A missing local file alone does not establish that the API cannot read the log.

Retry counters describe their own mechanisms, not all continuations.
`process_loss_retry_count` is incremented on the process-loss retry successor;
`continuation_attempt` tracks the liveness continuation path. Inspect
`retry_of_run_id`, `scheduled_retry_reason`, the wake linkage and the persisted
timeout or recovery carrier before interpreting a zero counter. Do not backfill
these counters from comments, elapsed time or a different retry mechanism.

Likewise, execution-workspace rows are not worker leases. An issue requests
workspace reuse with `executionWorkspacePreference: "reuse_existing"`; absent
that preference, successive runs can have distinct workspace records rooted
at the same project directory. `active` does not prove a live process owns that
directory. Consult the run's writer-resource admission receipt and current
holder, and never clean a shared directory merely because an older workspace
record is no longer linked from the issue.

### Contained process outcomes

A launcher-owned timeout can occur before the process adapter's own deadline.
Exit 124 is classified as `timed_out` only with a version-1 `run_timeout`
envelope bound to this run, reporting `status: "timed_out"`, `exitCode: 124`
and `modelStarted: true`. The adapter persists its checkpoint evidence under
`resultJson.runnerTimeout`; the existing progress, ownership, budget and
continuation-attempt gates still decide whether the same session may resume.
Neither a bare exit code nor contradictory or foreign-run evidence grants a
continuation. The configured execution deadline is unchanged.

An exit-1 `run_admission` rejection is likewise classified only from a
run-bound, version-1 envelope with `status: "rejected"`, `modelStarted: false`
and a known launcher reason code. This records the actual pre-model refusal,
such as `recovery_incident_unadmitted`, rather than a generic adapter failure.
It does not authorize admission, bypass the refusal or grant a resource-wait
retry. Reserved refusal codes 96–99 retain their existing contract.

## Native PRP Run-Log Events

The hidden native coordinator writes each validated PRP event to the bound
run's existing event stream before it acknowledges the runner. The row keeps
the PRP `eventType`, source instance, source event ID, source sequence, protocol
schema version, and a SHA-256 digest of the canonical source envelope. Its
payload is `{ "prpEvent": <canonical PRP event> }`.

The writer locks the native `heartbeat_runs` row and allocates the existing
per-run `seq` cursor. A byte-equivalent retry reuses the first row; a changed
retry or source-sequence gap is rejected. Company, issue, agent, run, session,
and runner-source bindings must match the persisted native run. Bootstrap
tickets, reconnect leases, authentication proofs, encryption keys, and raw
credential material are never written to the run log.

These records remain run-log events. They do not create an OpenTelemetry or
Paperclip Telemetry export, and legacy adapters do not use this writer.

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

## Related instrumentation

The sandbox duplex transport also writes one run-log event as one of its three
sinks. See the
[Sandbox Duplex Transport Instrumentation](observability.md#sandbox-duplex-transport-instrumentation)
section in the Observability contract.
