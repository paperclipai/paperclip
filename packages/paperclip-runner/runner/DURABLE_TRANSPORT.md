# Durable PRP transport

This layer gives `paperclip-runnerd` a provider-neutral, package-local PRP v1
transport. Nothing in the Paperclip server invokes the durable mode yet, and no
provider is installed by this change.

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
- The durable state directory is private, symlinks are rejected, and updates
  use a private temporary file, file sync, atomic rename, and directory sync.
  Credentials and lease tokens are never written to this state.

## Recovery contract

Events enter the outbox before delivery. A cumulative ACK may advance only to a
source sequence the runner has produced; acknowledged prefixes are removed
atomically from durable state. After disconnect, every remaining event is sent
again with the same identity and source sequence.

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

Durable mode is selected only when `paperclip-runnerd` receives
`--connect-url`. Its transport-only executor handles runner lifecycle commands
and rejects provider commands with `provider_not_installed`. The existing local
fake-runner mode remains unchanged. Codex execution, semantic tools, server
coordination, and the user-facing adapter belong to later layers.
