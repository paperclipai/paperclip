# ACP run lifecycle

This document describes how one ACP agent run starts, runs its turn, and releases
its resources. It covers the run coordinator, the six run resources, the
settlement order, the server-owned staging lease, and the known limitations.

## The run coordinator

One `run()` coordinator owns one attempt. It sequences four steps in a fixed
order:

1. **Startup.** Bring up the runtime and establish the session.
2. **Turn.** Run the agent turn against the ready runtime.
3. **Settlement.** Release every resource the run acquired.
4. **Result reproduction.** Return the external result to the caller.

The coordinator holds the routing table as data. It reads the startup outcome and
routes on it:

- A build failure or a partial-bridge failure throws from startup. The coordinator
  replays the startup-rollback entries and rethrows the original error.
- A runtime-create, handshake, missing-handle, or configuration failure produces a
  settle result. The coordinator settles the resources, then reproduces the error
  result.
- Every other startup outcome produces a ready result. The coordinator runs the
  turn, settles the resources, then reproduces the turn result.

The coordinator has no catch around the turn: the turn never rejects and returns a
typed completion. The coordinator reproduces the external result AFTER settlement,
so a caller never observes a result before the run releases its resources.

## The six run resources

A run resource ledger holds the resources between acquisition and settlement. The
ledger is the single owner. The closed set of run resources is:

- `acp_runtime` — the composite of the runtime, the session handle, and the child
  process. `runtime.close()` is the one release boundary for all three.
- `staged_runtime` — the workspace and the runtime staged into the sandbox, plus
  the one-time host-side cleanup of the staged temporary files.
- `control_bridge` — the control-plane callback bridge.
- `agent_bridge` — the agent process-session bridge.
- `managed_home` — the per-run managed-home copy-back hook.
- `staging_lease` — the per-session staging lease.

The host lane acquires only `acp_runtime`. The sandbox lane also acquires the
staging and transport resources. Each resource enters the ledger the moment it
exists, so the settlement always closes it, even on an early failure.

## The settlement order

The settlement sequence is the one live cleanup owner for every settled path. It
claims the ledger once, makes the pure reuse decision, then runs the ordered
steps:

1. `end_session` — close every runtime the reuse decision did not transfer, and
   drop the warm entry when it closes.
2. `settle_reuse` — perform the decision. A save transfers the reuse candidate to
   the site store; every other case discards it.
3. `stop_transport` — stop both bridges in one settled batch.
4. `sync_back` — run the site sync-back (the managed-home copy-back).
5. `release_staging_lease` — release the staging lease last (see below).

An error policy governs every step: a step records its error, and the later steps
still run. Every step is a no-op on an empty resource slot.

The reuse decision is pure and runs before any close. A save is eligible only when
a candidate exists, the settlement cause permits a save, and no run-scoped
credential that the candidate would carry into the store remains valid.

## The server-owned staging lease outer context

The staging lease is a per-session lease. Only one run of a session may stage into
the same remote workspace at a time. A second run of the same session waits on the
lease until the first run releases it.

The lease releases as the run's final act, after the coordinator settles every
other resource AND reproduces the result. This ordering keeps a same-session
second run blocked on the lease until the first run fully returns, so the second
run never re-stages into a workspace the first run still uses. The release runs in
a `finally`, so an earlier teardown fault never strands the lease.

## Per-phase run-log events

The run writes one [run-log event](run-log-events.md) per named lifecycle
phase, to the `heartbeat_run_events` table. This event is not a Paperclip
Telemetry event and not an OpenTelemetry export. Each event carries only the
phase name, the wall-time duration, and the outcome (`ok` or `failed`). The
phase name is one member of a closed allowlist. An event never carries a
command, an argument, a path, an environment value, or a raw identifier. A
run-log write failure never fails the run.

## Known limitations and deferred work

- **Host-lane runtime reuse is disabled.** A run-minted API key is a stateless
  token that the control plane never revokes on run end. A warm host runtime would
  carry a still-valid credential into the next run. The host lane therefore closes
  and relaunches on every run, rather than keeping the runtime warm, until a
  run-scoped credential rebind protocol exists.
- **The sandbox staged-files reuse stays enabled.** Its reuse payload carries no
  credential, so a compatible resume reuses the already-staged runtime.
- **The per-phase run-log events record the duration and the outcome only.**
  They never change run control flow.
