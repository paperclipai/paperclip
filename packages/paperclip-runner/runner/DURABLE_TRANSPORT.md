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

Pending Codex semantic requests are provider events, not replayed control
commands. Their native call identity is persisted in the provider sidecar. A
restarted runner resumes the same Codex thread, recognizes the reissued call,
and records reconciliation without producing another semantic input. The
server's deterministic result command and durable semantic receipt then finish
the original request and make the application effect idempotent.

State written before complete-command fingerprints existed is migrated by
compacting its legacy command journal through the last recorded controller
sequence. The runner can recover, but it rejects redelivery of those older
commands instead of guessing an identity or repeating an uncertain effect.

The outbox has separate hard and reserved limits. P1/P2 events cannot consume
the P0 reserve. When the soft limit is reached, the runner enters backpressure
and rejects the new non-P0 event rather than silently losing it. Exhausting the
P0 reserve is an explicit unrecoverable condition.

## Current boundary

Durable mode is selected only when `paperclip-runnerd` receives
`--connect-url`. Its executor accepts a Codex app-server descriptor and bound
completion contract through `run.prepare`, owns the provider process group,
resumes the persisted Codex thread after runner restart, and translates
provider notifications to PRP events. The server supplies each one-use
bootstrap ticket only through the child environment, restarts an unexpectedly
exited runner up to a fixed bound against the same state directory, stores each
process identity for bounded cancellation, and waits for the durable result
and terminal pair. The existing local fake-runner mode remains unchanged.
