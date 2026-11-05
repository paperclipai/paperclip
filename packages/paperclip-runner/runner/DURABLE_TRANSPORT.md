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

`recoveryIntegrityVersion: 1` in build metadata attests ordinary Codex
recovery integrity checks. There is no separate native recovery mode;
`--source-reconcile` is rejected. Recovered dormant provider state with no
uncertain effectful command must still be dormant after restoration. An
unexpected live turn or active goal fails closed. After reading the goal, the
Runner checks goal updates received while waiting for the final thread read.
Accepted updates stay queued for ordinary event delivery. Same-run active recovery and
indeterminate command replay retain their existing behavior. Prepared
state retains its existing no-restore behavior during reads and cleanup. It is
not a candidate for new completed-predecessor admission; existing prepared
cleanup and ordinary continuation remain available.

A process owner may reconcile a completed predecessor under its exact six-field
authority before ordinary authenticated `run.attach`. The selected execution
driver's `sourceRecoveryVersion: 1` attests stopped ownership and strict dormant
prelaunch admission; binary integrity metadata alone does not provide that proof.
The authenticated `authorityRunId` remains the current controller owner while
retained events and accounting stay attributed to the predecessor. Existing
retain-only controls prevent business dispatch and fresh work until attachment,
authentication and checkpoint persistence complete. History reads require the
retained thread identity; the resume facade publishes existing state without
another provider resume.

If controller-local preparation is absent, `recoveryLaunch: { requirements }`
supplies frozen source facts to a fresh authorized preparation. It neither
replaces the ordinary source configuration nor populates its cache. It requires
exact source identity, a preparer and an authenticated `authorityRunId`. Same-run
recovery supplies that same run ID. The owner must remain available through the
transport's lifetime; losing it blocks command admission and semantic dispatch.
The immutable recorded launch policy carries through later warm attachment.
Explicit target settings must be effectively compatible under the provider
factory's defaults; authenticated context and instruction grants retain their
existing precedence and compatibility checks.

Recovered interrupted attachment releases its source dispatch hold after the
fresh target snapshot and checkpoint persist and the recovery-completion callback succeeds.
Callback or checkpoint failure keeps that completion gate available for retry.
Cancellation cleanup remains retain-only.

A process owner may use the same data to
adopt its verified existing incarnation without spawning another process. These
checks do not establish vendor restore inertness, rollout fsync or physical
process retirement; paired provider qualification remains necessary.
