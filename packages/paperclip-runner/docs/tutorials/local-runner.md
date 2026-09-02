# Local runner: Run the Local Runner and Fake Harness

## What this phase is

Local runner is a local live-run path. A TypeScript mock core starts a Rust runner.
The Rust runner starts a scripted fake harness. The processes use JSON lines over
stdio.

## What this phase proves

This phase proves that a native session can run from start to finish without
Paperclip, a network provider, or a real model. It proves cleanup, request
resolution, interruption, bounded logs, one terminal result, and live/replay
parity.

## Prerequisites

- Node.js 24.11 or newer
- pnpm 9 or newer
- a stable Rust toolchain with `cargo`
- a Chromium-compatible browser

Start from a clean repository checkout and run every command from the
repository root. Install the package dependencies and browser:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --ignore-scripts --dev
pnpm --filter @paperclipai/paperclip-runner exec playwright install chromium
```

On a minimal Linux host, install the browser libraries too:

```sh
pnpm --filter @paperclipai/paperclip-runner exec playwright install-deps chromium
```

`playwright install-deps` requires root. On a Debian or Ubuntu host where root
is unavailable, use the package's rootless verification command instead. It
downloads the required browser-library packages into a user-owned cache,
extracts them without installing system packages, and scopes `LD_LIBRARY_PATH`
to the verification process:

```sh
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

## 1. Run the package verification path

```sh
pnpm --filter @paperclipai/paperclip-runner verify
```

Expected: Rust, TypeScript, protocol, boundary, documentation, and browser
checks pass. The final Local runner line reports one terminal event and a successful
semantic result.

## 2. Run the happy path in the CLI

```sh
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario happy-path --quiet
```

Expected summary facts:

- `eventCount` is `19`;
- `terminalCount` is `1`;
- `semanticResult` is `done`;
- harness and runner exit codes are `0`.

Capture the live trace as a validated replay fixture:

```sh
# Recorded evidence generation is deferred from this release.
```

The command writes
`packages/paperclip-runner/.paperclip-local/evidence/local-runner-happy-path.json`.

## 3. Run the scripted control flows

```sh
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario permission-input --quiet
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario interrupted --quiet
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario error --quiet
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario duplicate-terminal --quiet
pnpm --filter @paperclipai/paperclip-runner trace:local-runner -- --scenario happy-path --duplicate-turn-command --quiet
```

Expected:

- permission and input finish with `done`;
- interruption exits the harness with `130` and reports `yielded`;
- scripted error exits the harness with `7` and reports `yielded`;
- duplicate terminal still reports `terminalCount: 1`;
- duplicate turn command does not start a second turn.

## 4. Use the live browser

Start the package-local server:

```sh
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179
```

Open `http://127.0.0.1:4179`, then follow these steps:

1. Keep `Happy path` selected and choose **Start local run**.
2. Confirm the terminal badge says `succeeded`.
3. Confirm `Harness process exit` is `0` and `Semantic result` is `done`.
4. Confirm `Live and replay reducer output` says `Match`.
5. Select `Permission and input`, start the run, and choose **Allow**.
6. Enter a trace name and choose **Send input**. Confirm the run completes.
   Each interactive request remains open for five minutes. If it expires, the
   page reports that the run finished and asks you to start a new run.
7. Select `Interruption`, start the run, and choose **Interrupt turn** when the
   button becomes active.
8. Confirm the terminal badge says `cancelled`, the semantic result says
   `yielded`, and the timeline contains one `run.terminal` event.
9. Switch to **Static replay** and confirm the Replay fixture path still works.

Stop Vite with `Ctrl+C`.

The browser regression suite writes its temporary screenshots under the
ignored `packages/paperclip-runner/test-results/` directory. It never rewrites
the committed protocol fixtures.

## 5. Inspect the fixtures

- [Local-runner fixtures](../../protocol/fixtures/local-runner/)
- [Local-runner protocol reference](../local-runner.md)

## What this proves

- the Rust runner owns and cleans the fake-harness process group;
- the fake driver emits deterministic live events and requests;
- logs are bounded;
- process exit and semantic result stay separate;
- duplicate commands and terminal proposals do not repeat effects;
- every browser event passes the Replay validator and reducer;
- replay after completion produces the same final snapshot.

Durable recovery must not begin until the Local runner human checkpoint is accepted.
