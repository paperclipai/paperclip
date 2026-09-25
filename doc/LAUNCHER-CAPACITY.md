# Pre-provider launcher capacity contract

The `codex_local` CLI adapter supports an optional contract for trusted launchers
that reserve local capacity before starting the provider. Configure
`engine: "cli"`, the launcher's `command`, and `launcherCapacityRecovery: true`
in the adapter config. The option defaults to off. Do not enable it for a
provider binary or a wrapper that does not implement this contract.

For every attempt, the adapter supplies a fresh 32-character lowercase hex
`PAPERCLIP_LAUNCHER_NONCE`. The launcher must consume this variable and remove it
from every provider and quota subprocess environment. If local capacity is
temporarily unavailable **before any provider execution**, it may write one
complete stderr line, substituting the supplied nonce:

```text
paperclip-launcher:v1:capacity_unavailable:<nonce>
```

It must then exit 5, with no stdout. Human stderr diagnostics may accompany the
record. Do not emit the record for quota blocks, unknown meter readings, auth
errors, configuration failures, cancellation, or after a provider has started.
Never invent a nonce when the variable is absent or malformed. No secrets or
provider-specific quota information belong in the record.

The adapter requires exactly one record, the current nonce, version 1, the
specified outcome, exit 5, empty child stdout, zero usage, and no protocol,
session, signal, timeout, transport, auth or provider-error contradiction.
Malformed, duplicated, unknown or stale records and arbitrary exit 5 cannot
authorize recovery. This is an assertion by a trusted configured launcher, not
a security boundary against a malicious wrapper. Stripping the nonce prevents
provider output from supplying the current launcher assertion.

Accepted refusals use `launcher_capacity_unavailable` and the existing
`executionRecovery.kind: "bootstrap"`, `providerWorkStarted: false`, augmented
with `launcher: { version: 1, outcome: "capacity_unavailable" }`. They do not
claim a provider quota or upstream failure. Child stdout/stderr and adapter
setup logs remain intact. Only this validated evidence, persisted with empty
child stdout and zero usage, lets the startup cooldown disregard adapter setup
stdout. Other bootstrap failures retain their previous output checks.

The existing durable scheduler supplies the same two-retry limit, delays,
idempotent successors, cancellation and issue ownership gates. Capacity
refusals do not trigger Codex's provider-error fallback settings. Exhaustion
uses the existing operator recovery disposition; this contract does not add
a scheduler or an unlimited wait queue.

Roll out the launcher and adapter independently with recovery disabled, then
enable the option once both are installed and verified. An older adapter never
issues a nonce, so a compatible launcher emits only its ordinary diagnostics
and exit code. An older launcher never emits a record, so the new adapter keeps
the old failure behavior. No deployment is implied by this source change.
