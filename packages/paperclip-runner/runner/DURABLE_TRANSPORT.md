# Durable PRP transport

This layer gives `paperclip-runnerd` a provider-neutral PRP v1 transport. The
Paperclip server invokes durable mode only for a selected, flag-enabled
`paperclip_runner` agent or recovery of its persisted native run. Codex is the
only installed provider; other providers remain unavailable.

## Trust boundary

- The runner accepts only `ws://` destinations whose complete DNS result is
  loopback. Resolution happens once and reconnects reuse the pinned addresses.
- A bootstrap ticket is read from `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET`, removed
  from the environment immediately, and never sent over the socket. Both peers
  prove possession through HMAC-SHA-256.
- A successful bootstrap exchanges the one-use ticket for a connection-bound,
  expiring lease held only in memory. Once authentication starts, a failed
  bootstrap attempt is not replayed automatically.
- Post-authentication frames use AES-256-GCM with direction-specific keys,
  monotonically increasing counters, and session-bound associated data.
  Plaintext, replayed, out-of-order, oversized, or incorrectly bound frames
  fail closed.
- Cross-language authentication primitives use the UTF-8 domain bytes followed
  by a NUL byte, then each input as an unsigned 64-bit big-endian byte length
  and its raw bytes. Challenge proofs cover the lexicographically key-sorted,
  compact JSON challenge payload. The server-to-runner integration test is the
  parity gate for these TypeScript and Rust encodings.
- The durable state directory is private, symlinks are rejected, and updates
  use a private temporary file, file sync, atomic rename, and directory sync.
  Credentials and lease tokens are never written to this state.

## Recovery contract

Events enter the outbox before delivery. A cumulative ACK may advance only to a
source sequence the runner has produced; acknowledged prefixes are removed
atomically from durable state. After disconnect, every remaining event is sent
again with the same identity and source sequence.

Executors retain polled events until runnerd acknowledges each event after its
outbox commit. Batches commit one event at a time, so a later oversized event or
capacity failure cannot roll back the accepted prefix or discard the
unacknowledged suffix. Each retained executor event has a stable identity that
runnerd derives into its PRP `sourceEventId`. If the process stops after the
outbox commit but before the executor acknowledgement, a bounded durable
receipt journal recognizes and byte-validates the retained copy without
appending a second event. Receipts outlive transport ACK removal; because the
provider queue is ordered and bounded, a possibly retained front event cannot
be evicted while later events advance the journal.

Commands require a contiguous controller sequence. The runner journals a
pending command before invoking its executor and persists its result afterward.
An exact duplicate returns the stored result without repeating the effect. If
the process dies inside the effect window, recovery records an indeterminate
result and refuses to execute that command again. Recent results are bounded;
commands older than the compacted controller cursor fail closed.

State written before complete-command fingerprints existed is migrated by
compacting its legacy command journal through the last recorded controller
sequence. The runner can recover, but it rejects redelivery of those older
commands instead of guessing an identity or repeating an uncertain effect.

The outbox has separate hard and reserved limits. P1/P2 events cannot consume
the P0 reserve. When the soft limit is reached, the runner enters backpressure
and rejects the new non-P0 event rather than silently losing it. Exhausting the
P0 reserve is an explicit unrecoverable condition.

## Current boundary

Unix builds advertise `hostedParkingVersion: 1` in `--build-metadata`. A trusted
listen-mode launcher may pass `--host-control-fd 4`, a connected Unix stream
carrying newline-delimited JSON frames up to 16 KiB. Parking requires an exact
source identity and command/ACK cut plus a settled, live native Codex process.
While parked, Runner waits only for private control, stream closure, or its
existing hard lifetime. A claim installs a fresh bootstrap ticket in memory;
the `claimed` reply precedes PRP authentication and `run.attach`.

An unscoped `{op:"retire",id,parkId}` applies only while parked. Retiring an
unused claim additionally requires `claimId`, all six `identity` fields,
`lastControllerCommandSeq`, and `ackedSourceSeq`. Runner atomically rechecks
the current claim, unchanged source cut, absence of pending operations, and
settled provider proof before shutdown. Missing, stale, attached, or active
claim requests return `conflict`; exact successful retries replay their receipt.
Stream EOF still retires the owned process regardless of claim state.

Durable mode is selected only when `paperclip-runnerd` receives
`--connect-url`. Its executor accepts a Codex app-server descriptor and bound
completion contract through `run.prepare`, owns the provider process group,
resumes the persisted Codex thread after runner restart, and translates
provider notifications to PRP events. The server supplies the bootstrap ticket
only through the child environment, stores the process identity for bounded
cancellation, and waits for the durable result and terminal pair. The existing
local fake-runner mode remains unchanged.

For conditional retirement, the task host persists an unpredictable request ID
before delivery. After checking the claim and journal cut, Runner atomically
records the lowercase SHA-256 of that ID in `host-retirement-proof.v1` beside
its journal and syncs it before provider shutdown. All paths after acceptance
exit the Runner loop. The host can match this proof after a lost socket reply.
It must still confirm physical termination before admitting a cold successor.
