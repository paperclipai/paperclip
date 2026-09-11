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

## ACP Permission Handoff Observer Run-Log Events

Paperclip writes four run-log event types for the ACP permission handoff. The
producer is `createAcpPermissionObserver` in
`packages/adapter-utils/src/acpx-engine/permission-observer.ts`. These events
are run-log records, not first-party telemetry events. The generated
telemetry contract does not cover them, so this section is their canonical
contract.

The observer is observation-only. It never answers, approves, or denies a
permission request. It only records receipt and settlement, so an operator
can tell a stalled handoff from a normal wait. An internal error in the
observer resolves the hook to `undefined`, the same as a normal observation;
the observer never blocks or changes the permission decision.

Each field passes through a closed enumeration or a bounded scalar. The
event never carries the raw ACP frame, the tool input, or another free-form
payload. A session ID and a tool-call ID are capped at 200 characters each
before they enter the payload.

### `acpx.permission_observed`

Paperclip writes this event when the engine receives a permission request.

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | string | The session ID, capped at 200 characters. |
| `toolCallId` | string | The tool-call ID, capped at 200 characters. |
| `method` | string | The ACP method name, from a closed allowlist (`session/request_permission` or `unknown`). |
| `toolKind` | string | The inferred tool kind, from a closed allowlist (`read`, `edit`, `delete`, `move`, `search`, `execute`, `think`, `fetch`, `switch_mode`, `other`, or `unknown`). |
| `stage` | string | Always `requested` for this event. |
| `permissionMode` | string | The run's effective permission mode, from a closed allowlist (`approve-all`, `approve-reads`, `deny-all`, or `unknown`). |
| `transport` | string | The run's execution transport, from a closed allowlist (`local`, `ssh`, `sandbox`, or `unknown`). |

### `acpx.permission_settled`

Paperclip writes this event when a tracked tool call reaches a terminal
status (`completed` or `failed`).

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | string | The session ID, capped at 200 characters. |
| `toolCallId` | string | The tool-call ID, capped at 200 characters. |
| `outcome` | string | The terminal outcome (`completed` or `failed`). |
| `ageMs` | number | The time from receipt to settlement, in milliseconds, clamped to a maximum of 24 hours. |

### `acpx.permission_unsettled`

Paperclip writes one of these events for each permission request still open
when the run finalizes. This is the signal that a handoff stalled.

| Field | Type | Meaning |
| --- | --- | --- |
| `sessionId` | string | The session ID, capped at 200 characters. |
| `toolCallId` | string | The tool-call ID, capped at 200 characters. |
| `stage` | string | The last known tool-call stage, from a closed allowlist (`requested`, `pending`, `in_progress`, `completed`, `failed`, or `unknown`). |
| `ageMs` | number | The time from receipt to run finalization, in milliseconds, clamped to a maximum of 24 hours. |

### `acpx.permission_observer_truncated`

Paperclip writes this event once per run, only when the observer suppressed
an entry or an event. It carries no session ID, no tool-call ID, and no other
agent-controlled value.

| Field | Type | Meaning |
| --- | --- | --- |
| `suppressedLedgerEntries` | number | The count of open permission requests the observer could not track because the ledger was full. |
| `suppressedObservedEvents` | number | The count of `acpx.permission_observed` events the observer dropped because that event's own budget was full. |
| `suppressedSettledEvents` | number | The count of `acpx.permission_settled` events the observer dropped because that event's own budget was full. |
| `suppressedUnsettledEvents` | number | The count of `acpx.permission_unsettled` events the observer dropped because that event's own budget was full. |

### Bounded output

The agent process is untrusted, so it picks how many permission requests it
sends. The observer bounds its own memory and log volume against that input
instead of trusting a limit the agent could exceed.

The observer tracks open requests in a ledger capped at 256 entries. It also
gives each event type its own emission budget of 256 events for the run. The
four budgets are separate: `acpx.permission_settled` fires once per tool call
the agent completes, so a normal long run can spend a shared budget before
the run ends. A separate budget for `acpx.permission_unsettled` keeps that
signal reachable even when the agent's normal traffic would otherwise spend
a shared budget first.

Each budget counts the cumulative number of emitted events for the run, not
the live ledger size, so an agent cannot refill a budget by opening and
settling requests in a loop. When a budget is spent, the observer emits
nothing further for that event type; it never emits a reduced event. The run
finalization step emits at most one `acpx.permission_unsettled` event per
still-open ledger entry, and at most one `acpx.permission_observer_truncated`
event for the whole run.

## Related instrumentation

The sandbox duplex transport also writes one run-log event as one of its three
sinks. See the
[Sandbox Duplex Transport Instrumentation](observability.md#sandbox-duplex-transport-instrumentation)
section in the Observability contract.

## Execution recovery

Provider identity diagnostics remain in the local run log. They record the notification method, expected and received thread/turn identifiers, and the classification (root, verified descendant, stale, unrelated informational, or invalid authoritative). They omit the original provider payload and credentials. Repeated informational notices are bounded.

Recovery lifecycle events retain the original structured failure code, retry attempt, next retry time, and predecessor/successor identifiers. Durable status delivery uses an idempotency marker; delivery grants no provider authority. Failed publication is retried without repeating provider work. These records are not first-party Telemetry.

## Codex resume usage snapshot

The native runner retains a bounded local `harness.diagnostic` event with code
`codex_resume_usage_snapshot`. It identifies `thread/tokenUsage/updated` as
`resume_usage_snapshot`, retains the reported thread and completed-turn IDs,
and records cumulative usage counters. It does not include provider credentials
or message content. The event establishes the accounting baseline; it is not a
new billable usage receipt or a user-facing provider warning. Other provider
identity checks remain in force.
