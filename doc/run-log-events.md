# Run-Log Events

Run-log events write to the `heartbeat_run_events` table
(`packages/db/src/schema/heartbeat_run_events.ts:6-20`). They are not
Paperclip Telemetry events, and they are not OpenTelemetry exports. A run-log
event needs no operator endpoint.

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
