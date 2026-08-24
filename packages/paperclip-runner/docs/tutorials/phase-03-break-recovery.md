# Phase 3: Break It on Purpose

## What this phase is

Phase 3 adds a durable outbound WebSocket connection.

The Rust runner connects to a package-local mock core. The runner stores events
before it sends them. It stores each command result before it replies.

This phase does not use the Paperclip server, UI, database, or a real model.

## What this phase proves

This tutorial proves that a broken connection does not create a false new
session.

You will drop a socket. You will lose an acknowledgement. You will restart the
real Rust runner process. You will also restart the real fake-harness child.

Each test keeps the same runner, session, turn, item, command, and event IDs.
Repeated delivery causes one logical effect. P0 events are not lost. The
diagnostics do not show authentication secrets.

## Before you start

From the repository root, build the package binaries:

```sh
pnpm --filter @paperclipai/paperclip-runner build:typescript
pnpm --filter @paperclipai/paperclip-runner build:phase2-binaries
```

The commands below use only loopback network access. They create temporary
state below the Paperclip run scratch directory when it is available. The CLI
removes that state after each successful proof.

## Step 1: Drop the socket

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault socket-drop
```

Confirm:

- `Outcome: recovered` is shown.
- The connection count is at least 2.
- The runner ACK and core ACK are equal.
- Every assertion says `PASS`.

## Step 2: Lose one ACK

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault lost-ack
```

Confirm:

- the output shows at least one replay delivery;
- the outbox ends with 0 pending events;
- `P0 lost 0` is shown;
- `PASS no duplicate logical events` is shown;
- the runner, session, turn, and item IDs are unchanged.

The network may deliver one event more than once. The mock core keeps one
logical event and advances one cumulative cursor.

## Step 3: Restart the Rust runner

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault runner-restart
```

Confirm:

- the output shows 1 runner restart;
- the output shows 2 fresh bootstraps;
- a replay delivery is present;
- every assertion says `PASS`.

The test kills `paperclip-runnerd` while an event is unacknowledged. The next
process reads the same private state file. It emits `runner.reconciled` and
continues the same durable source cursor.

## Step 4: Restart the fake harness

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault harness-restart
```

Confirm:

- the output shows 1 harness restart;
- `PASS stable identity` is shown;
- `PASS source cursor continuity` is shown.

The test starts a real fake-harness child, stops its process group, and starts a
second child. The normalized session, turn, and item IDs do not change.

## Step 5: Repeat a command

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault duplicate-command
```

Confirm:

- the output shows at least one duplicate command delivery;
- `PASS one logical effect per accepted command` is shown;
- `workspace.ready` exists one time in JSON output when you add `--json`.

## Step 6: Apply storage pressure

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault storage-pressure
```

Confirm:

- backpressure is active in JSON output;
- peak storage is below the maximum;
- the next turn is rejected;
- `PASS P0 events preserved` is shown;
- `PASS bounded storage` is shown.

## Step 7: Test lease expiry, drain, and revoke

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault lease-expiry
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault drain
pnpm --filter @paperclipai/paperclip-runner trace:phase3 -- --fault revoke
```

Confirm:

- lease expiry uses a fresh bootstrap and resumes the same cursor;
- drain reports `Outcome: drained` and rejects new work;
- revoke reports `Outcome: revoked`;
- all three traces finish with an empty acknowledged outbox;
- every security assertion passes.

## Step 8: Open the browser recovery view

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179
```

Open `http://127.0.0.1:4179/` and select **Recovery**. Use the **Fault** selector
to run these cases with **Run Phase 3 recovery**:

1. **Normal connection**
2. **Socket drop**
3. **Lost ACK**
4. **Runner restart**
5. **Revoke**

Also run **Storage pressure** when checking the bounded-storage state.

Confirm:

- recovery status becomes **complete** after every run;
- **Outcome** is **Recovered** for the normal, socket-drop, lost-ACK, and
  runner-restart cases, while revoke shows the warning-toned **Revoked** outcome
  and its reason;
- **Connections**, **Reconnects**, **Runner restarts**, and **Fresh bootstraps**
  distinguish the normal, reconnect, process-restart, and lease-bootstrap paths;
- **Recovery history** lists every committed source sequence and event type, with
  a `delivered N×` marker on events delivered more than once;
- **At-least-once redeliveries** can be non-zero for a normal connection because
  the runner may resend a still-unacknowledged in-flight outbox batch. Use the
  reconnect counters and per-event delivery markers to identify injected
  recovery; a lost ACK adds an extra delivery to the affected event;
- **Storage** reports current bytes and the maximum, and storage pressure shows a
  warning-toned **Backpressure** badge;
- the connection lifecycle is human-readable, such as **Stopped**;
- **Same runner and session** says **Preserved**;
- **Secrets redacted** says **Yes**;
- no bootstrap ticket or connection lease token appears.

## Step 9: Run the package verification path

Run:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

The verification path builds TypeScript, Rust, and the browser. It runs unit,
integration, browser, boundary, documentation, parity, and tracer checks for
Phases 0 through 3.

## Evidence

- [Phase 3 verification record](../../knowledge/evidence/2026-08-07-phase-03-verification.md)
- [Phase 3 recovery screenshot](../../knowledge/evidence/phase-03-recovery-diagnostics.png)
- [Phase 3 OKF journal entry](../../knowledge/journal/2026-08-07-phase-03.md)
- [Phase 3 transport reference](../phase-03-durable-transport.md)

Phase 4 remains uncreated. A human must accept the Phase 3 checkpoint before
later work starts.
