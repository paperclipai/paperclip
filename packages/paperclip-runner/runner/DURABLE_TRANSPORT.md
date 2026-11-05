# Durable PRP transport

Core uses durable PRP v1 for a selected, flag-enabled `paperclip_runner`
agent or recovery of its persisted run. On a fresh launch or restart,
`paperclip-runnerd` selects durable mode from its connection arguments.

- With `--connect-url <url>`, the Runner dials Core.
- With `--listen-address 0.0.0.0 --listen-path /api/runner/v1/connect/<run-id>`,
  the Runner listens for Core. `--listen-port` defaults to `43127`.

Choose one form. Both require `PAPERCLIP_RUNNER_BOOTSTRAP_TICKET`.
Recovery uses the same entry point. The Runner rejects `--source-reconcile`.

## Trust boundary

- For outbound `ws://`, every resolved address must be loopback. The Runner
  resolves the destination once and reuses the pinned addresses on reconnect.
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

## Recovering Codex between turns

Suppose run A finishes a turn, its Runner exits, and run B wants to continue
the conversation. Core uses ordinary recovery for A, then attaches B with
authenticated `run.attach`. If the original process is alive, its owner can
verify and adopt it instead.

**Is A idle?** Before launch, the host driver (`codexSourceRecoveryVersion: 1`)
checks that A’s process stopped and its saved session was idle. After launch,
the Runner (`recoveryIntegrityVersion: 1`) verifies that Codex restored an idle
session when no command effect is uncertain. It reads the goal, then the
thread. An unexpected turn or active goal blocks recovery, even if the goal
changes during the thread read. Accepted updates stay queued for delivery.

Active runs use same-run recovery. Indeterminate commands follow the replay
rules above. A prepared session can continue normally, but this handoff
requires a completed turn. Reads and cleanup leave a prepared provider unopened.

**Who owns the session?** Core matches A’s Runner instance, environment lease,
run, normalized session, turn and item. History reads require A’s thread. A
resume request returns saved state without asking Codex to resume twice. Retained events and usage
belong to A. The authenticated `authorityRunId` identifies the current owner
(A for same-run recovery). Losing that owner blocks new commands and dispatch.

If Core loses its cached preparation, the preparer uses A’s frozen
`recoveryLaunch.requirements`, exact identity and authenticated owner. It
leaves A’s configuration in place and the cache empty. B inherits A’s recorded
launch policy on later attachments. Explicit settings must agree after
provider defaults are applied. Authenticated context and instruction grants
keep their usual precedence and compatibility checks.

**When can B start work?** After authenticated attachment, Core persists B’s
fresh snapshot and checkpoint and runs any recovery callback. B can then
start work. If a write or callback fails, Core can retry the handoff.
Cancellation cleanup only settles retained work.

Live qualification still needs to verify that restoring a provider starts no
work, deployed storage honors fsync, and the old process has exited.

## Recovering ACPX between turns

`paperclip-runnerd --build-metadata` prints `acpxRecoveryIntegrityVersion: 1`
when the Runner implements these ACPX checks. The hosted ROM build copies
that field into its manifest. The host driver advertises a separate
`acpxSourceRecoveryVersion: 1` and checks whether this run qualifies.

The Runner compares the restored session identity, pending requests, turn
and goal with A’s saved idle state. After reading the goal, it checks updates
that arrive during the final status read and keeps them queued for delivery.
As with Codex, a prepared session can continue or be cleaned up. This handoff
requires a completed turn. Suspended sessions use their usual recovery path.
