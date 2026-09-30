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
company/run-scoped mutation receipt keyed by call ID. Concurrent identical
calls and retries after authority restart return the exact original receipt.
Changing the arguments under that ID is an idempotency conflict. Receipt replay
still checks current instruction-write authorization.

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
| Long Unicode input and result; corrupted input digest | Exact bytes across persistence/wire; no copied input in result; bad proof blocks settlement | Rust durable-state tests; `durable-prp-control-plane.test.ts` |
| Handler finishes during close, after close budget, or persistence fails | Checkpoint marked settled only with completed delivery and drained provider | `runnerd-codex-transport.test.ts` |
| Controller restarts with committed input but no result | No second dispatch and no fabricated outcome | `durable-prp-control-plane.test.ts` |
| Execution and cleanup both fail | Original execution error retained; cleanup error attached | `native-session-runtime.test.ts` |
| Retry in same process or after local log loss | Earlier attempts survive locally and in the durable mirror | Server `run-log-store.test.ts` |

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

## Verification

The production durable control plane and live-session suites cover reconnect,
ACK replay, restart recovery, backpressure, lease expiry, drain, and revoke.

Use `--json` for the complete trace or `--output <path>` to write it. The CLI
and browser show connection counts, safe lease ID and expiry, stable identities,
source and ACK cursors, outbox current/peak bytes, command delivery/effect
counts, replay counts, restart counts, outcomes, and redaction assertions.

They never show bootstrap tickets or connection lease tokens.

Regenerate the checked fault matrix and every exact per-fault trace with:

```sh
# Recorded evidence generation is deferred from this release.
```
