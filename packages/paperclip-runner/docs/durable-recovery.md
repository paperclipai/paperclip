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
   The welcome selects PRP v1, returns a short-lived connection lease, reports
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
