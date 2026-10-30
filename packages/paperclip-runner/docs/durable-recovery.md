# Durable recovery Durable Transport and Recovery

Durable recovery adds a real outbound WebSocket path to the standalone package. The
Rust `paperclip-runnerd` process is the client. The TypeScript mock core is the
remote peer. Neither side imports Paperclip server, UI, database, or shared
control-plane code.

This is a local reliability and authenticated-transport proof. The mock keeps
the RFC 6455 carrier on `ws://127.0.0.1`, but PRP application frames use a
mutually authenticated, encrypted session. Loopback position and the
WebSocket acceptance header are not authentication. A production bridge should
still use `wss://` for defense in depth and remains a separately reviewed
deployment phase.

## Execution duration and operation deadlines

Native turns have no total elapsed-time limit unless the operator configures
`timeoutSec` on the agent. Zero means unlimited. The controller passes that
setting separately from bootstrap, recovery, checkpoint, and finalization
operation bounds. A live turn must not inherit the internal 15-minute operation
deadline; tool waits count toward an explicitly configured turn duration.

The native-session API exposes `turnTimeoutMs` for that duration. An explicit
`timeoutMs` retains its prior operation/turn behavior for existing embedding
callers, while `turnTimeoutMs: 0` overrides its turn bound. Cancellation, budget
controls, input handoffs, and bounded cleanup remain independent.

Normal runner launches also set `--max-runtime-ms 0`, meaning no total process
lifetime limit. The standalone durable runner defaults to the same value.
Explicit positive limits still stop at their deadline; connection/auth attempts,
reconnect grace, cancellation, and idle cleanup remain bounded independently.
Neither quiet tool execution nor a productive turn is an idle session.

The authenticated welcome advertises `connectionLeaseRenewalVersion: 1`.
Supporting runners send `lease_renew` halfway through the remaining lease,
independently of provider output. The request carries the current expiry and
revocation epoch under the exact connection, lease, and run identity. The
controller persists an extended expiry before returning `lease_renewed`, which
also echoes the request's previous expiry. The runner updates its in-memory
lease without replacing its process, provider, thread, turn, token, or epoch.
Retries of the same observed expiry replay the persisted extension. Renewal
never admits an expired, revoked, or differently bound credential.

If a reply is lost, reconnect authentication may reconcile a later expiry only
when this runner has an outstanding renewal on that same credential. Warm
handoff receipts continue to bind exact expiry and renewal pauses during their
transition. Old controllers that do not advertise renewal retain their bounded
lease behavior; deploying both updated controller and runner is required.

Tests simulate three weeks of renewal on one authenticated connection, exercise
lost-reply reconnect without reexecuting provider startup, and keep a quiet
active Codex fixture in the same runner/provider PIDs beyond its original lease
expiry. These are boundary regressions, not a weeks-long real-provider soak.

Provider startup ownership summaries validate goal commands with their required
PRP v2 command vocabulary. Incoming wire commands still undergo the negotiated
protocol validation before execution; ordinary persisted v1 summaries remain
compatible.

## Adoption and retired launch artifacts

A live runner is adopted with its admitted artifact binding and authenticated
process identity. ACPX and OpenCode launch profiles are constructed only when a
new runner will actually be spawned. Adoption does not read the retired
controller's provider-pack executables, sidecar or proxy files. Fresh launches
still require the existing artifact digests and provider-pack authority.

The component regression starts the production runner and OpenCode proxy against
a scripted harness, removes the controller's launch files, then recovers the
same process and provider session and completes another turn. This exercises the
real transport; it does not qualify a hosted OpenCode or ACPX deployment.

## Source-bound profile history

Copilot profile v68 binds the merged hot-upgrade and current master transport.
Published v66 and the earlier hot-upgrade v67 identity remain byte-for-byte
historical records. The distinct development v66 identity is retained under
`copilot-profile-v66-hot-upgrade-candidate-historical-identity.json`; it does not
replace the published v66 fixture. Decoding historical versions does not grant
fresh-launch permission. Installation still requires the exact current profile,
package and digest. These records do not establish hosted harness qualification.

## External controller checkpoints

The optional controller persistence callback stores recovery control state, not
an output transcript. Text deltas do not trigger callbacks; usage updates are
coalesced into the next control checkpoint. Authentication, command intents and
outcomes, semantic inputs, lifecycle and result events retain commit barriers.
Priority-zero and unknown event kinds are never treated as disposable output.

Installing the callback makes it the controller's durable authority. The local
state file is replaced once with a fail-closed marker; ordinary control changes
no longer rewrite or fsync a second local journal. The controller can continue
if that directory disappears. A new controller must restore the committed
external checkpoint before opening the directory; the marker cannot recover
an execution or authorize a new one. This does not change the sandbox runner's
journal or controllers without an external persistence callback.

Fresh semantic inputs reserve their original live callback before awaiting the
checkpoint barrier. Recovery cannot steal first dispatch when no saved outcome
exists. The reservation is released if persistence or admission fails; business
execution still starts only after durable persistence succeeds.

Recovery and live semantic-tool dispatch share per-call ownership. Overlapping
reconciliation calls cannot invoke the same callback twice while its outcome is
pending. An already queued authoritative result is replayed without resolving
its business outcome again. Failed or unknown outcomes retain the existing
reconciliation and authority rules.

Pending completion inputs (`paperclip_finish` and `paperclip_block`) use the
driver's existing completion handler even when its caller supplies no recovery
lookup for ordinary tools. Codex transport waits for both authenticated startup
and handler installation; the external driver waits for session opening.
An ordinary tool with no outcome lookup remains held. Reconciliation does not
turn a missing lookup into permission to repeat that tool.

Transport readers use a committed view when external persistence is enabled.
Lifecycle and result events, command outcomes and warm-handoff authority become
visible only after the checkpoint callback succeeds. A failed write leaves the
previous view in place until a successful retry. Internal admission still sees
staged intents so overlapping recovery cannot duplicate them. Command results
flush their checkpoint even when no next command is waiting.

Streamed output continues without checkpoint writes. The view stops before a
pending control event to preserve event order, reuses immutable event records
and unchanged decoded commands, and caches the visible projection between
changes. It neither copies a second transcript nor adds an idle scan.

A rejected persistence callback closes the current connection and keeps the last
successful revision. A later flush or reconnect retries from a complete checkpoint,
including when the failed response hid a successful commit. Queued writes also
rebuild their delta against the last successful callback. Commit barriers remain
in force, and no retry timer runs when the controller is idle.

Supporting runners advertise `recoveryCursorVersion: 1` in `auth_hello`. The core
includes that capability and `recoveryAckedSourceSeq` in both authentication
proofs. The runner verifies the cursor equals its persisted acknowledgement.
After authentication and owner admission, a replacement core can reconcile that
cursor with its sparse checkpoint. It only skips already-acknowledged history;
new delivery remains contiguous. Unacknowledged events use the existing outbox.
A peer without this capability cannot attach to a sparse external checkpoint.
New runners can still authenticate to older controllers that use full journals.

There is no per-output external checkpoint timer or remote-controller cache
fsync. Local-only controllers retain their full file journal. Existing application
callbacks, the bounded runner outbox, and backpressure remain. Losing the
controller before acknowledged display output reaches its application log can
leave a display tail gap; this must not trigger provider or tool reexecution.

Prepared environments retain at most two opaque configuration IDs, each bound to
its exact execution identity across a warm handoff. They are captured with control
state, never output, and do not duplicate instructions or preparation requirements.
An execution driver can provide `authorizeRunnerAdoption(configurationId, identity)`
to recheck current authority before registering a surviving runner, without
preparing its resources again. The driver owns policy; Runner knows no project or
account rules. Missing bindings and rejected checks fail closed. Without this
optional hook, adoption retains the existing `prepareLaunch` recovery callback
and requires its controller-local preparation cache. Older checkpoints without
a configuration binding cannot use the cache-independent adoption path.
Supplying the hook for adoption without `prepareLaunch` is rejected at construction;
the transport must not silently skip a requested authority check. Drivers that do
not use prepared environments keep their existing adoption contract.

## Connection and authentication

The connection starts in this order:

1. The mock core creates a random bootstrap ticket with a five-second lifetime.
2. The ticket is passed to the runner through
   `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET`. It is not a command-line argument.
3. The runner opens an unauthenticated WebSocket upgrade with no bearer header,
   then sends only a public credential locator, a fresh client nonce, complete
   runner/run/session identity, approved runner version and digest, negotiated
   protocol range, and durable resume cursors.
4. The core returns a fresh server nonce plus an HMAC-SHA-256 proof over the
   complete transcript. The proof binds runner, environment lease, run,
   normalized session, turn, item, runner artifact, selected protocol,
   credential/connection lease identity, expiry, and revocation epoch.
5. The runner validates that proof before returning its own transcript-bound
   proof. The bootstrap ticket or connection lease token itself never crosses
   the socket. A failed proof does not consume a one-use bootstrap ticket.
6. Both sides derive directional AES-256-GCM keys from the capability and both
   nonces. Strict per-direction counters reject replays and out-of-order frames.
7. Only after mutual authentication does the core send an encrypted `welcome`.
   The welcome selects a supported PRP version, returns a short-lived connection lease, reports
   the cumulative committed event cursor, and carries at most one pending
   command. Every later ACK, command, revoke, event, and command result remains
   inside the encrypted session.
8. Later connections authenticate with the connection lease. A real runner
   process restart receives a new one-time bootstrap ticket and loads the same
   durable state before it connects.

The runner keeps the live connection lease token in memory only. Its state file
does not contain the bootstrap ticket or connection lease token. The mock core
persists domain-separated SHA-256 authentication keys instead of raw
capabilities. Used, expired, revoked, or identity-mismatched credentials fail
closed during the challenge. The runner validates the complete encrypted
welcome and every control envelope against the authenticated connection,
runner, environment lease, run, normalized session, turn, item, protocol,
lease ID, expiry, and revocation metadata before applying an ACK or command.

Semantic input integrity uses SHA-256 of the complete transmitted input's
canonical JSON, with UTF-16 object-key order and JavaScript number formatting.
The controller checks this proof after authentication and exact run/session/
turn/item correlation, before committing, dispatching, or acknowledging the
input. Receipt redaction has a separate digest; a redacted digest cannot stand
in for wire integrity, including when only a protected field changes. A failed
integrity proof keeps the existing operator-required recovery fence. Updating
the verifier does not clear a previously failed run or replay its work.

The daemon captures and removes the bootstrap environment variable before it
parses arguments or starts child work. Secret buffers are overwritten when they
are dropped. It resolves the destination once before sending a bearer value and
accepts only concrete loopback addresses. Userinfo, query strings, fragments,
wildcards, private-network addresses, public addresses, and mixed DNS answers
fail closed.

## WebSocket limits

The package client implements the RFC 6455 upgrade and masked client text
frames with Node-free Rust standard-library code. The mock core validates the
upgrade and parses bounded masked frames.

- Maximum HTTP upgrade headers: 16 KiB.
- Maximum PRP frame: 1 MiB.
- Unknown frame opcodes and unmasked client frames close the connection.
- Malformed JSON is recorded as a bounded diagnostic. Durable state remains
  available for reconnect.
- WebSocket ping/pong and PRP diagnostic pong state are supported.

## Durable runner state

The runner writes `runner-state.json` below its private state directory. The
directory uses mode `0700` and the file uses mode `0600` on Unix. Every update
is written to an exclusive unpredictable sibling file, synchronized, atomically
renamed, and followed by a parent-directory sync. Symlinked directories or state
files, wrong ownership, and wrong modes fail closed.

The state contains:

- stable runner, environment lease, run, session, turn, and item IDs;
- next source event sequence and cumulative acknowledged source sequence;
- unacknowledged event envelopes and their byte counts;
- a bounded recent processed-command cache with a SHA-256 command digest and
  prior result, plus a fixed-size fail-closed replay filter for compacted IDs;
- lifecycle, reconnect, backpressure, harness generation, and recovery facts;
- bounded, redacted diagnostics.

Raw runner stdout and stderr are never redirected to durable files. The runner
itself redacts and bounds a terminal diagnostic before publishing it through an
atomic private-file replacement, so neither an output burst nor controller
restart can create a transient unbounded or unredacted diagnostic file.

Authentication capabilities and arbitrary command bodies are not stored. A
recent command is represented by a SHA-256 comparison digest from the vetted
RustCrypto implementation, its stable ID and controller sequence, the redacted
result, and the logical-effect count. The exact cache keeps at most 128 entries.
Older IDs are added to a fixed 4 KiB Bloom filter before their exact records are
removed. A possible filter match is rejected with zero effects, so Bloom false
positives can reject new work but can never make an old command effective again.
The durable controller sequence remains monotonic across compaction and restart.

## Event delivery and ACKs

The runner writes an event to the outbox before it sends the event. Event IDs
and source sequence numbers do not change after reconnect or restart.

The mock core commits or deduplicates an event before it sends this cumulative
ACK:

```json
{
  "kind": "ack",
  "payload": { "ackedSourceSeq": 9 }
}
```

The ACK means that every source event through sequence 9 is committed or
deduplicated. The runner rejects an ACK that moves backward or beyond its
produced source cursor. It removes only events at or below a valid ACK.

The controller stages routine priority 1 and 2 event snapshots with asynchronous
file writes and file fsyncs. Those operations let unrelated HTTP requests run
while the volume is slow. Rename and directory fsync remain synchronous. The
candidate snapshot stays private until its atomic replacement
and directory flush finish. Lifecycle readers and replacement connections see
only the committed cursor. The controller acknowledges the event after that commit.
A command that saves during staging includes the pending event in its own
durable write. Further commands do not add event deliveries or cause another
staged write. Other authority changes leave an uncommitted event available for
replay instead of repeatedly rewriting the snapshot. A replaced
connection cannot publish its old candidate. Its unacknowledged event remains
available for replay. A failed write fences further authority until reload.
Priority 0 events, all `run.*` and `turn.*` lifecycle events, commands,
authentication, and semantic tool input retain synchronous persistence. The
lifecycle rule also covers producers that label a terminal event priority 1.
A terminal suffix remains in the same
control-loop turn. Semantic tool admission and dispatch cannot yield to a
replacement connection between those operations.
Controller replacement must still stop ingress and drain admitted processing
before a successor reuses the journal. External control routes stop their
reconnect loop before the controller joins admitted work. An incomplete drain
cannot certify a reusable checkpoint. Snapshots use compact JSON; existing
indented snapshots remain readable.

For the lost-ACK fault, the mock commits an event, drops the ACK and socket, and
reports the prior cursor once after reconnect. The runner sends the same bytes
again. The mock increments delivery count, keeps one logical event, and sends
the committed cumulative ACK.

## Command delivery and effects

Mock-core commands are durable before delivery. Only the lowest pending
controller sequence is sent. A command result advances the queue.

The runner stores a command result before it sends the result. When a result or
socket is lost, the same command is delivered again. An equal command ID and
digest returns the stored result. It does not add events or repeat a process
effect. Reusing the ID with different bytes is rejected.

The trace records `logicalEffectCount`. Every completed command has exactly one
logical effect. A policy rejection, such as a new turn during drain or storage
pressure, has zero effects.

## Semantic operations that outlive a turn

An execution session includes the provider process, the runner's durable call
receipts and event outbox, and the controller's durable command queue. Ending a
provider turn closes admission of new work. It does not establish whether a
semantic operation already dispatched to the server succeeded or failed.

The tool bridge retains pending call IDs, operation IDs, and exact arguments
across that boundary. It accepts the authority's late result without delivering
it to an obsolete provider turn. An identical result is an idempotent replay;
a different result for that call remains a conflict. Codex records harmless
result replay as `semantic_tool_result_duplicate` in a diagnostic event, with
no task failure. Conflict errors identify the call, operation, and both result
digests without including the result bodies.

The controller checkpoints a reusable session only after every admitted tool
has a matching completed result-delivery command and the provider has drained.
A callback rejected before business dispatch can report
`semantic_tool_not_dispatched`. A callback rejected after dispatch has an
unknown outcome; the controller must not invent a failure or execute it again.
After controller restart, an already committed input without a result remains
unsettled. It requires authoritative reconciliation, not an automatic retry.
A different case is a runner crash after the controller saved the result but
before its delivery command completed. Codex/OpenCode explicitly opt in to
reconciling that exact `semantic_tool.result` command through their durable tool
receipt. The full command fingerprint must match. This delivers the saved
answer without executing the business operation. Unsupported providers and all
other indeterminate commands remain non-reexecutable. This change does not
repair legacy journals already containing contradictory or failed receipts.

`update_agent_instructions` and `restore_agent_instructions` use a durable,
company/run-scoped mutation receipt keyed by call ID. Before attempting a file
write, the authority commits an `instructionToolAttempts` record and an
`agent.instruction_write_attempted` activity row with the call ID, operation ID,
and input digest. This evidence survives a later filesystem or database failure.
Completed calls and retries after authority restart return the exact original receipt.
Changing the arguments under that ID is an idempotency conflict. Receipt replay
still checks current instruction-write authorization. Concurrent callers in the
same process wait for the first handler before checking the receipt again.

The filesystem and PostgreSQL are not one atomic store. If a write is visible
but its receipt transaction rolls back, the attempt record remains durable and
the result is unknown. An identical call with an attempt but no committed result
raises `paperclip_runner_instruction_outcome_unknown`; it does not write again
or pretend to have succeeded. This also applies to another process reaching a
reserved call before its effect transaction starts. The controller retains an
unsettled operation for authoritative reconciliation. If only the commit
acknowledgement was lost, the committed receipt is replayed normally.
The native tool wrapper propagates `SemanticToolOutcomeUnknownError` instead
of turning it into a completed failed tool response. Ordinary validation,
authorization, and stale-base errors still return normal tool errors. Before
returning a definite pre-write failure, the authority saves its status, message,
and details under the attempt's `failure` receipt. Replays return that original
error without executing again, even if the old CAS base becomes current again.
Failure-receipt storage errors retain an unsettled operation instead of exposing
an unrecorded final answer.

### Lossless arguments and bounded transport

Execution arguments do not use the diagnostic preview formatter. Accepted
input remains exact, including Unicode, line endings, and long document tails.
The credential policy rejects input it would have to alter before dispatch.
Diagnostic copies remain redacted and bounded. The semantic input limit is
480 KiB of encoded JSON, leaving room for the encrypted frame's hex expansion
and envelope inside the 1 MiB wire limit. Oversized input fails before a write;
it is never truncated into an apparently successful write.

A result command retains a SHA-256 `inputDigest` instead of duplicating the
full input alongside the full result. The canonical input event retains the
arguments. Settlement validates the digest and all run, event, call, operation,
and correlation identities. Legacy result commands carrying the full input
remain supported. Large results still have to fit the command transport limit;
exceeding it leaves the outcome unsettled rather than retrying an effect.

### Deterministic fault coverage

These tests use explicit barriers, durable reloads, real runner processes with
scripted providers, and a real PostgreSQL database. They do not require a paid
model or rely on an LLM choosing the desired timing.

| Fault | Required assertion | Regression suite |
| --- | --- | --- |
| Stop before/after server result; restart before late delivery | No invented failure; pending identity survives; late result accepted | Rust `provider_bridge`, `codex_provider` |
| Provider terminal before tool completion | New turn blocked until actual result; safe replay and later reuse | Rust `acpx_provider_turns`, `acpx_provider_state` |
| Crash before/after applying a saved delivery receipt, before command completion | Exact result delivery recovers only for opted-in providers; changed commands and ordinary operations never replay | Rust durable runner tests |
| Lost result acknowledgement; conflicting redelivery | Identical result accepted; changed result rejected with IDs and digests | Rust `codex_provider`, `provider_bridge` |
| Concurrent writes held at filesystem commit; authority restart | One write, one audit record, same receipt; revoked authorization rejected | Server `agent-instruction-tools.integration.test.ts` |
| Failure after file rename or rollback while saving the receipt | Durable attempt and audit evidence survive; no success claim and no second write | Server `agent-instruction-tools.integration.test.ts` |
| Receipt commits but its database acknowledgement is lost | Exact original result replays; one file-update audit and one attempt record | Server `agent-instruction-tools.integration.test.ts` |
| Tool handler throws an unknown-outcome error versus a validation error | Unknown propagates without a completed tool event; validation returns an ordinary failed response | `codex-app-server-driver.semantic-results.test.ts` |
| Invalid arguments, oversized input, or stale base; restart and replay | Original failure replays with zero writes, even after the base becomes valid | Server `agent-instruction-tools.integration.test.ts` |
| Failure receipt cannot be stored | No unrecorded final failure; attempt remains unsettled and never reexecutes | Server `agent-instruction-tools.integration.test.ts` |
| Long Unicode input and result; corrupted input digest | Exact bytes across persistence/wire; no copied input in result; bad proof blocks settlement | Rust durable-state tests; `durable-prp-control-plane.test.ts` |
| Handler finishes during close, after close budget, or persistence fails | Checkpoint marked settled only with completed delivery and drained provider | `runnerd-codex-transport.test.ts` |
| Controller restarts with committed input but no result | No second dispatch and no fabricated outcome | `durable-prp-control-plane.test.ts` |
| Execution and cleanup both fail | Original execution error retained; cleanup error attached | `native-session-runtime.test.ts` |
| Retry in same process or after local log loss | Earlier attempts survive locally and in the durable mirror | Server `run-log-store.test.ts` |
| Two restores overlap and one appends before the other publishes | Complete prefix is published without replacement; both attempts survive | Server `run-log-store.test.ts` |
| New run whose row has no log reference, output sequence, or log size | No durable-mirror request; a later attempt with a recorded log reference still restores after local loss | Server `run-log-store.test.ts`, `heartbeat/run-output.test.ts` |

## Residual local trust and revocation window

The authenticated session removes trust in whichever process wins the configured
loopback port: a relay can forward opaque bytes, but it cannot learn a bootstrap
or lease capability, decrypt control data, or forge a welcome, ACK, command, or
revoke frame. The remaining local-host assumption is that the OS protects the
runner process memory, inherited bootstrap environment at launch, private
`0700`/`0600` state paths, and the mock core's derived authentication keys from
other same-user processes with debugging, memory-reading, or filesystem access.
An attacker with those privileges is outside this transport boundary.

Lease expiry is checked locally before control data is applied. Explicit
revocation reaches an already-connected runner through an authenticated revoke
frame; if that frame cannot be delivered, the session remains usable until the
connection closes or the runner reaches the signed lease expiry. The mock uses
a 30-second lease, so that is the maximum demonstrated revocation window. A
production core should close active sessions when it revokes a lease and choose
the lease TTL to match its required revocation bound.

## Restart and reconciliation

Local Linux process receipts use the kernel's `/proc/PID/stat` start ticks,
`/proc/stat` boot time and `CLK_TCK` to record process birth. The server and
retained Runner maintenance use the same reader. `/proc/PID` directory ctime
can differ from birth and must not grant process ownership. Invalid or missing
birth metadata fails closed. PID, process group and owner checks remain required.
Drain active Linux runs before updating or rolling back across the previous
ctime-based receipt format; do not rewrite a live receipt to force adoption.

A socket drop keeps the same Rust process and in-memory lease. The process
reconnects and reloads the mock-core command and event cursor.

A runner restart kills the real Rust process with unacknowledged work. A new
Rust process receives a fresh ticket, reads the same state file, emits a P0
`runner.reconciled` event, and continues the same runner, session, turn, item,
command, and source-event identities.

The harness-restart fault starts the real Local runner `fake-harness` child, waits
for its ready message, terminates its process group, and starts a second child.
The runner then emits `harness.exited`, `harness.ready`, and
`session.reconciled` events with the same normalized session, turn, and item
IDs.

If a lease expires, reconnect fails closed. The runner records
`lease_expired_requires_bootstrap` and exits with its state intact. The mock
then gives the replacement runner a fresh ticket. Recovery continues from the
same cursor.

If recovery cannot be truthful, state names the outcome. For example, failure
to reserve storage for a P0 event records `p0_storage_exhausted` and the
`unrecoverable` lifecycle. It never reports a fresh session as resumed.

## Protocol versions and warm handoff

Ordinary PRP v1 connections remain supported. A warm `run.attach` that changes
run authority requires negotiated PRP v2, as well as the warm-transition
capability. The runner refuses a v1 warm attachment before provider work. A v1
peer acknowledges placeholders for native session-goal and capability events;
those acknowledgements do not prove that the peer observed the native state.
Rotation must not discard that retained evidence or relabel it as a new run.

A connection lease fixes its protocol version. Advertising v2 on reconnect
does not upgrade an existing v1 lease. For a v2-capable runner holding a v1
lease, the owned transport's process-recovery path can replace the process
with fresh authorization when configured with a reconnect grace. It preserves
validated state and original authority and issues a new one-use bootstrap.
The old process must exit first; any old provider owner must also be retired.
The connection lease exists only in process
memory; no credential or journal file needs to be edited. The replacement
negotiates v2 and replays retained native session state on the original
authority. Its native event acknowledgements must settle before warm handoff.
The controller must still authorize replacement and verify current process,
artifact, and run ownership. This is not an automatic in-place lease upgrade
or a general operator UI migration flow. An old binary stays old when its
immutable launcher restarts it. Replacing a legacy binary or an adopted owner
requires separate artifact and ownership admission; this path does not qualify
that migration. Pending warm-transition receipts
require their separate exact recovery admission, not an ordinary bootstrap.

## Backpressure and bounded storage

The runner has a byte limit and a reserved P0 region.

- P2 item deltas coalesce before delivery.
- P1 events cannot consume the P0 reserve.
- New turns are rejected while backpressure is active.
- A P0 `runner.backpressure` event explains the state.
- P0 events are never dropped to make room.
- The state records peak outbox bytes so the final empty outbox does not hide a
  limit violation.

The storage-pressure trace emits 250 P2 updates. They become one coalesced
event, all P0 facts reach the mock core, peak bytes remain below the configured
limit, and the next turn is rejected without an effect.

## Drain and revoke

`runner.drain` persists the `draining` lifecycle and a P0
`runner.draining` event. It rejects later `turn.start` commands but continues to
deliver the existing outbox. `runner.shutdown` stops only after the outbox is
acknowledged.

A `revoke` envelope persists the `revoked` lifecycle. The runner flushes any
existing durable events and exits. It does not accept new work or delete
unacknowledged facts.

## Process identity

An external process owner can publish `startedAt` after launch dispatch returns.
`spawnRunner` preserves that live value through its restart wrapper. Once the
owner has a verified process identity, consumers use its birth time rather than
controller construction or attachment time. Replacing the controller must not
change the admitted process identity.

## Verification

The production durable control plane and live-session suites cover reconnect,
ACK replay, restart recovery, backpressure, lease expiry, drain, and revoke.

`src/control-plane/runner-recovery-fixture.test.ts` builds the test-only Cargo
example `recovery-fixture`. It links the unchanged production durable runner with
a scripted `CommandExecutor`, whose worker thread performs bounded hashing steps
and retains each resulting output until the normal executor ACK transfers it to
the runner outbox. There is one process, no HTTP counter service, and no production
provider-admission switch. Private fixture receipts report completed steps, queue
depth and process identity; they do not acknowledge or recover protocol events.

The short experiment starts one turn, removes the controller, then releases real
work. Eight retained events fill the fixture queue and pause work explicitly.
A replacement authenticates and drains through PRP. At step 32 the executor waits
for a controller command, survives another replacement, then completes 64 steps
without repeating the turn. The test runs with ordinary filesystem persistence
and with opaque external checkpoints restored onto empty controller storage.
An independent short-deadline case checks termination with recovery state intact.
These prove the runner mechanism, not Codex, Claude, Daytona or application
authorization. Server adoption and installed-artifact qualification have separate
owners and evidence.

Run the short experiment from this package with:

```sh
pnpm exec vitest run src/control-plane/runner-recovery-fixture.test.ts --maxWorkers=1
```

The fixture builds through Cargo during test setup. Production distribution builds
do not include the example. Existing control-plane tests separately inject failed
checkpoint persistence, stale/unauthenticated cursors and output floods, including
the zero-per-text-checkpoint-write gate.

Use `--json` for the complete trace or `--output <path>` to write it. The CLI
and browser show connection counts, safe lease ID and expiry, stable identities,
source and ACK cursors, outbox current/peak bytes, command delivery/effect
counts, replay counts, restart counts, outcomes, and redaction assertions.

They never show bootstrap tickets or connection lease tokens.

Regenerate the checked fault matrix and every exact per-fault trace with:

```sh
# Recorded evidence generation is deferred from this release.
```

Checkpoint decoding also exposes read-only recovery evidence: the admitted runner/session identity, authenticated connection count, and highest recorded source sequence. This projection grants no authority and adds no checkpoint writes. Qualification compares it across controller replacement; a replayed canonical event by itself does not prove that a replacement controller has authenticated a runner.
