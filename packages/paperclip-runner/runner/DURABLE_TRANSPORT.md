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

After disconnect, runnerd tries Core when reconnect is due. Between attempts,
live Codex and ACPX processes can drain local output into the outbox. Work that
needs a provider request waits for Core, including managed-provider history
reads and unanswered tools or approvals. An ACPX sidecar can include a fresh
`goalAtTerminal` snapshot in `runtime.turn_terminal` to settle the turn offline.
A missing or stale snapshot waits for a connected goal read. Runnerd suspends
intake during terminal delivery or an authority transition.

If Codex hits its tool-receipt limit during reconnect, runnerd stops its local
process group at the original deadline. It reads the remaining stdout in short
intervals, then replays the frames in order across as many batches as needed.
Only confirmed EOF with no terminal permits a missing-terminal result.
If stdout stays open or the buffer lacks room for one maximum-size frame,
runnerd reports uncertainty and keeps the events already committed to disk.

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

A controller can die after it sends `turn.start` but before it checkpoints the
accepted turn. The provider keeps running that turn. On reattach, the host
driver adopts the single active turn only when the latest completed
`turn.start` result for this run accepted that exact turn id, and no run
attachment came after it. The driver then emits the missing `turn.accepted`
and waits for that turn instead of starting another. Any other active turn
still fails closed as an unexpected turn.

State written before complete-command fingerprints existed is migrated by
compacting its legacy command journal through the last recorded controller
sequence. The runner can recover, but it rejects redelivery of those older
commands instead of guessing an identity or repeating an uncertain effect.

The outbox has separate hard and reserved limits. P1/P2 events cannot consume
the P0 reserve. When the soft limit is reached, the runner enters backpressure
and rejects the new non-P0 event rather than silently losing it. Exhausting the
P0 reserve is an explicit unrecoverable condition.

While disconnected, soft-limit backpressure retains the rejected event and its
suffix at the provider owner until replay ACKs free outbox space. Oversized
events or exhausted hard limits stop the owned provider and preserve the
accepted durable prefix. The ACPX sidecar separately caps queued stdout at
4 MiB; exceeding that bound requests owned provider shutdown and records a
failure rather than allowing unbounded process memory while the Runner cannot
read.

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
Only a transport that starts under a later owner sends A's events to recovery
accounting, and only while its event identity is still A. After recovery moves
the transport to B, a later warm attachment treats B like any live owner. A
live warm `run.attach` also moves `authorityRunId` to B before
the Runner flushes A's outbox. Those events use ordinary accounting, which
drains A's usage under B.

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

Before B attaches, Runner saves the events it already received from A's sidecar.
The readiness snapshot stays blocked until Core acknowledges those events.
Another turn within A also keeps its buffered events without waiting for an ACK.
ACPX still replaces the sidecar at the next turn or run attachment. The saved
provider identity continues through that replacement.

## Host park eligibility

`CommandExecutor::host_park_ready` defaults to false. Native Codex opts in only
for the existing process that completed the current turn. An eligibility check
never selects or restores a provider. A restored process must complete its own
authoritative turn before it can be eligible. Reconstructing an accepted finish
during recovery preserves result delivery but does not qualify that process.
Active turns, goals, startup attempts, tool calls, pending credentials, and
unsettled events block parking. Known helper threads also block it: their
diagnostic lineage does not prove that their work finished. The bounded
completed-turn tail drain retains late accounting and goal changes for durable
state and normal event delivery.

Claude and Codex through ACPX also need a successful turn in the live sidecar.
Runner checks its qualified profile, session identity and source run A. It gives
that sidecar 100 ms to report its goal and session state. If the sidecar is slow
or declines, Runner stays attached. Runner keeps at most one unanswered read and
recognizes its late reply. Events received during that read still belong to A
and are delivered before B attaches. The existing policy still replaces the
sidecar at the next turn or run attachment; the saved provider identity continues.

The check also inspects the live provider
after that drain, so a late active-goal notification cannot be hidden by the
older executor journal. This hook does not detach a controller, stop a process,
or advertise hosted parking support. The host-control consumer must separately
validate the exact Runner identity and acknowledged sequence cut.

### Hosted park and reclaim loop

On Unix builds, `paperclip-runnerd --build-metadata` reports
`privateHostControlVersion: 1` for the existing private fd 4 protocol below.
Other builds omit this field. A consumer must verify the selected executable's
identity and require the exact supported version before using this channel;
an absent or unknown version does not establish support. Recovery and warm-task
versions do not establish it either. Ordinary artifact admission can ignore this
optional field.

This field describes protocol support only. It does not mean a provider is ready
to park or that a host implements the public `releaseResumeVersion` contract.
Runner readiness checks and host sleep/wake qualification are still required.

A trusted Launcher may pass a connected Unix stream at fd 4 and start durable
listener mode with `--host-control-fd 4`. The descriptor is close-on-exec before
provider startup. The private channel accepts the `park`, `claim`, and `retire`
requests defined in the host-control codec; it cannot execute PRP commands.

`park` requires the exact six-field authority, acknowledged command/event cut,
no unfinished transition or cleanup, and the provider eligibility proof above.
The Runner drops its controller connection and credentials, retains its provider
and journals, and blocks on host control without provider polling. Ordinary
reconnect grace does not expire a parked Runner. The configured process lifetime
still applies. Mount ownership stays with Launcher.

`claim` names the accepted park request and supplies a fresh bootstrap ticket.
It resumes authenticated PRP under the retained authority; ordinary `run.attach`
must still establish the next authority before new work. Pending reconnect and
live commands both reject execution before that attachment; snapshots, drain,
and cleanup remain available. Replaying the same claim returns its acknowledgement without consuming another ticket. A parked
retirement names the park request. Cancelling a claim additionally requires its
claim ID, the unchanged authority and sequence cut, and provider quiescence.
Retirement, parked host-channel loss, or process-lifetime expiry uses the existing
suspended lifecycle and provider shutdown path. There is no new checkpoint state.

This native loop does not advertise hosted parking support: Launcher retention,
Core orchestration, provider-specific qualification, and live VM sleep/wake
verification are required before rollout. Providers without an eligibility
implementation remain ineligible.


### Optional controller release and resume

An explicit session `release()` returns a copy of A's confirmed six-field source
identity. It returns `false` when support is absent or work is still active.
Those refusals leave active work and its controller route in place. Release and
released-source adoption require a registration checkpoint hook that owns process
cleanup. Without it, release returns `false` and adoption fails before claim.

For an eligible release, the controller first makes its existing route quiet,
then waits for the host acknowledgement before it closes that route. A failed
request can have taken effect. Its retry keeps the same source identity; a
resume retry also keeps the exact bootstrap ticket. The route stays quiet while
the result is uncertain. Resume's pinned ticket deadline bounds claim
reconciliation. A late reply cannot grant authentication or work permission.

A `resumed` result permits authentication under A. Ordinary `run.attach` must
still establish B before B can start work. An `unavailable` result reports known
absence of the retained Runner; it does not prove that descendants have stopped
or release their cleanup ownership. This optional contract adds no automatic
release policy or capability advertisement.
