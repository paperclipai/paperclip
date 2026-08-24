# Native Runner Cumulative End-to-End Tutorial

## What this tutorial is

This tutorial combines each implemented Native Runner phase into one procedure.
It currently includes Phase 0 through the Phase 5 browser SDK layer.

## What this tutorial proves

This tutorial proves that the standalone package boundary, static replay path,
local live-run path, durable recovery path, and direct Codex driver work
together. It does not use the Paperclip control plane. Phase 4 uses a real
local Codex session through the mock core.

The current system includes the Rust mock-core tracer, shared protocol fixtures,
the Rust supervisor, a scripted fake harness, CLI live runs, and browser live and
replay modes. It also includes the Rust outbound WebSocket client, durable
outbox, package-local mock core, recovery CLI, and recovery browser view.
The final phase adds a skillless task envelope, direct app-server driver,
semantic completion tools, and the same reducer/replay proof used by fixtures.
Phase 5 freezes that browser transport and reducer projection as public SDK
subpaths, then proves them with a reference console and a second consumer.

## Current end-to-end path

1. Follow [Phase 0: Run the Standalone Tracer](phase-00-standalone-tracer.md).
2. Confirm the final JSON contains `run_phase0_0001`,
   `session_phase0_0001`, and `succeeded`.
3. Confirm the cross-language parity check passes.
4. Confirm the shell prompt returns and no Paperclip service was started.
5. Open the [Phase 0 journal entry](../../knowledge/journal/2026-08-07-phase-00.md)
   and its linked verification evidence.
6. Follow [Phase 1: Validate and Replay a PRP Fixture](phase-01-static-replay.md).
7. Compare the happy-path CLI snapshot with the browser page.
8. Exercise the duplicate, gap, unknown-field, and unsupported-version fixtures.
9. Open the [Phase 1 journal entry](../../knowledge/journal/2026-08-07-phase-01.md)
   and its linked verification evidence.
10. Follow [Phase 2: Run the Local Runner and Fake Harness](phase-02-local-runner.md).
11. Run the happy, permission/input, interruption, error, and duplicate-terminal scenarios.
12. Open the browser live mode and confirm the completed run says `Match` for live and replay output.
13. Open the [Phase 2 journal entry](../../knowledge/journal/2026-08-07-phase-02.md)
    and its linked verification evidence and screenshots.
14. Follow [Phase 3: Break Recovery on Purpose](phase-03-break-recovery.md).
15. Confirm that the recovered runner and session IDs stay the same.
16. Confirm that the outbox is empty after replay and cumulative acknowledgement.
17. Open the [Phase 3 journal entry](../../knowledge/journal/2026-08-07-phase-03.md).
18. Follow [Phase 4: Run the Skillless Codex Driver](phase-04-skillless-codex.md).
19. Inspect the exact model-context snapshot and confirm that it has no
    Paperclip instructions, bearer credentials, or unrelated skills.
20. Run the safe task, then steer and interrupt separate sessions. Confirm
    stable session identities and exactly one result and terminal event.
21. Open the [Phase 4 journal entry](../../knowledge/journal/2026-08-08-phase-04.md)
    and its linked real-session trace and verification evidence.
22. Follow [Phase 4b: Run the Protocol Demo Server](phase-04b-protocol-server.md).
23. Confirm requests stay pending for a typed browser decision, stale steering
    is rejected, and reconnect keeps the same run and session identities.
24. Open the [Phase 4b protocol/server journal](../../knowledge/journal/2026-08-08-phase-04b-protocol-server.md)
    and its linked deterministic and real-Codex evidence.
25. Follow [Phase 5: Run the SDK Console and Mini Consumer](phase-05-sdk-console.md).
26. Run the fake lifecycle in both consumers, then confirm the mini consumer
    reaches `Replay parity: match` after reconnect and replay.
27. Run the safe real-Codex browser smoke and inspect the Phase 5 screenshots.
28. Open the [Phase 5 journal](../../knowledge/journal/2026-08-08-phase-05-sdk.md)
    and its linked package-acceptance evidence.

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
- every live browser event passes the Phase 1 validator and reducer before display;
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
- automatic skill, app, and collaboration instruction blocks are disabled;
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
pnpm --filter @paperclipai/paperclip-runner console:phase4b
```

Open `http://127.0.0.1:4180/` and press **Live console**. Work through the
[Phase 4b live console tutorial](phase-04b-live-console.md) to reach every
state above from the eleven deterministic demo chats. Add
`PAPERCLIP_PHASE4B_DRIVER=codex` to run the identical screens against a real
Codex session.

## Step 7: Run the reusable SDK consumers

```sh
pnpm --filter @paperclipai/paperclip-runner console:phase5
```

Open `http://127.0.0.1:4181/reference-console/` and
`http://127.0.0.1:4181/mini-consumer/`. Follow the
[Phase 5 tutorial](phase-05-sdk-console.md) for the deterministic lifecycle,
real-Codex smoke, keyboard checks, and package acceptance command.
