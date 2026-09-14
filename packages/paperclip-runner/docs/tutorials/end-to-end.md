# Native Runner Cumulative End-to-End Tutorial

## What this tutorial is

This tutorial combines each implemented Native Runner phase into one procedure.
It currently includes Conformance through the Standalone Paperclip adapter tracer.

## What this tutorial proves

This tutorial proves that the standalone package boundary, static replay path,
local live-run path, durable transport, and direct Codex driver work
together. It does not use the Paperclip control plane. Codex uses a real
local Codex session through the mock core.

The current system includes the Rust mock-core tracer, shared protocol fixtures,
the Rust supervisor, a scripted fake harness, CLI live runs, and browser live and
replay modes. It also includes the Rust outbound WebSocket client and durable
outbox.
The final phase adds a skillless task envelope, direct app-server driver,
semantic completion tools, and the same reducer/replay proof used by fixtures.
SDK freezes that browser transport and reducer projection as public SDK
subpaths, then proves them with a reference console and a second consumer.
Standalone consumes the public runner contract from Paperclip behind a default-off
flag while preserving server-owned workspace, governance, and status authority.

## Current end-to-end path

1. Follow [Conformance: Run the Standalone Tracer](conformance-standalone-tracer.md).
2. Confirm the final JSON contains `run_conformance_0001`,
   `session_conformance_0001`, and `succeeded`.
3. Confirm the cross-language parity check passes.
4. Confirm the shell prompt returns and no Paperclip service was started.
5. Follow [Replay: Validate and Replay a PRP Fixture](replay.md).
6. Compare the happy-path CLI snapshot with the browser page and exercise the
   duplicate, gap, unknown-field, and unsupported-version fixtures.
7. Follow [Local runner: Run the Local Runner and Fake Harness](local-runner.md).
8. Run the happy, permission/input, interruption, error, and duplicate-terminal scenarios.
9. Open the browser live mode and confirm the completed run says `Match` for live and replay output.
10. Follow [Codex: Run the Skillless Codex Driver](codex.md).
11. Inspect the exact model-context snapshot and confirm that it has no
    Paperclip instructions, bearer credentials, or unrelated skills.
12. Run the safe task, then steer and interrupt separate sessions. Confirm
    stable session identities and exactly one result and terminal event.
13. Follow [Live console: Run the Protocol Demo Server](live-console-protocol-server.md).
14. Confirm requests stay pending for a typed browser decision, stale steering
    is rejected, and reconnect keeps the same run and session identities.
15. Follow [SDK: Run the SDK Console and Mini Consumer](sdk-console.md).
16. Run the fake lifecycle in both consumers, then confirm the mini consumer
    reaches `Replay parity: match` after reconnect and replay.
17. Run the safe real-Codex browser smoke.
18. Follow [Standalone: Run the Thin Paperclip Adapter](standalone-thin-paperclip-adapter.md).
19. Run the unchanged port conformance suite against mock and database-backed
    Paperclip ports, then inspect one local feature-flagged task.
20. Disable the flag and confirm a fresh task selects legacy while persisted
    native finalization remains native.

The one-command form after installation is:

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

On a minimal Debian or Ubuntu host without root access, use the rootless browser
dependency path:

```sh
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

## Cumulative guarantees

- the fixture is validated before any mock-core mutation;
- event sequence and run identity agree through the terminal result;
- Rust and TypeScript printed output is covered by exact string and parity assertions;
- deliberate TypeScript and Cargo references to Paperclip core are rejected;
- documentation and journal indexes are machine checked;
- the package remains runnable without Paperclip core;
- JSON Schema remains the language-neutral authority for TypeScript and Rust;
- replay is deterministic and idempotent under duplicate delivery;
- source gaps are visible and never synthesized away;
- CLI and browser paths use the same validator/reducer module;
- browser components keep visual values in the package-local token layer.
- the Rust supervisor owns the fake harness process group and cleans it up when the controller closes;
- command IDs are idempotent and controller sequence numbers stay contiguous;
- runtime permission and input requests round-trip over the local protocol;
- process exit is recorded separately from the structured semantic result;
- bounded logs retain only their configured tail;
- exactly one terminal event closes every completed local trace;
- every live browser event passes the Replay validator and reducer before display;
- replaying the completed live event list produces the same final snapshot.
- a lost cumulative ACK replays the same durable event ID without a second
  logical event;
- repeated commands return the stored result and cause one logical effect;
- runner and harness restarts preserve runner, session, turn, and item IDs;
- backpressure bounds local storage without dropping P0 events;
- lease expiry, drain, revoke, and unrecoverable storage outcomes are explicit;
- CLI and browser diagnostics do not expose bootstrap or connection-lease
  tokens.
- the Codex child receives an allowlisted environment without Paperclip or
  OpenAI bearer credentials;
- automatic skill and app instruction blocks are disabled, while Codex's
  built-in collaboration instructions are enabled by default and remain
  explicitly removable for controlled eval baselines;
- direct app-server create, resume, read, turn, steer, interrupt, usage, and
  reconciliation operations preserve stable identities;
- provider events normalize to canonical lifecycle, model, tool, file,
  request, usage, verification, result, and terminal events;
- the first validated semantic completion wins, identical duplicates are
  idempotent, and a changed duplicate is rejected;
- unsupported capabilities degrade through explicit redacted diagnostics;
- the real trace and its replay reduce to the same final snapshot.
- supported provider requests wait for one typed browser resolution and clean
  up exactly once;
- same-turn steering is acknowledged while stale and direct-child steering are
  rejected;
- pre-start interrupts queue until the provider turn ID exists and terminal
  races return `already_terminal`;
- goal controls are capability probed and disabled precisely when unavailable;
- parent/child activity derives from provider thread identities;
- the demo server fixes the workspace and keeps Codex authentication out of
  browser JSON, events, and diagnostics;
- refresh/reconnect replays canonical events and resumes the exact persisted
  provider thread.
- the browser console renders only reducer state and canonical events, with no
  second event model and no client-side session cache;
- steering resolves to exactly one of acknowledged, stale-rejected, or failed,
  and rejected text stays recoverable;
- interrupt before start, during generation, and during a tool call each end in
  a distinct visible state, and the session is never replaced;
- request cards offer only the actions the upstream request offers and lock on
  the first click until the canonical resolved event arrives;
- unsupported capabilities render disabled controls carrying the exact upstream
  diagnostic, never hidden and never emulated;
- a transport drop, a page refresh, and replay all reproduce the same
  transcript from the durable cursor;
- no provider credential reaches the browser DOM, and adapted components add no
  new runtime dependency.
- the browser and React contracts are versioned package subpaths with React as
  a peer and no new runtime dependency;
- the reference console and mini consumer import public APIs only;
- exactly five extension points cover item bodies, request details, Composer
  actions, token theming, and transport injection;
- duplicate canonical events reach the shared reducer unchanged;
- both consumers preserve identity through reconnect and reduce replay to the
  same final state.

## Step 6: Chat with a live session in the browser

```sh
pnpm --filter @paperclipai/paperclip-runner console:live-console
```

Open `http://127.0.0.1:4180/` and press **Live console**. Work through the
[Live console tutorial](live-console.md) to reach every
state above from the eleven deterministic demo chats. Add
`PAPERCLIP_LIVE_CONSOLE_DRIVER=codex` to run the identical screens against a real
Codex session.

## Step 7: Run the reusable SDK consumers

```sh
pnpm --filter @paperclipai/paperclip-runner console:sdk
```

Open `http://127.0.0.1:4181/reference-console/` and
`http://127.0.0.1:4181/mini-consumer/`. Follow the
[SDK tutorial](sdk-console.md) for the deterministic lifecycle,
real-Codex smoke, keyboard checks, and package acceptance command.
