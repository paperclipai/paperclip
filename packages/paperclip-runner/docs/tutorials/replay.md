# Replay: Validate and Replay a PRP Fixture

## What this phase is

Replay is a static replay path for a Paperclip Runner Protocol fixture. It uses the same reducer in the CLI and browser.

## What this phase proves

This phase proves that Rust and TypeScript accept the same protocol data. It also proves that duplicate events do not change the result.

The tutorial validates one fixture. It reduces the events in the CLI. It then shows the same snapshot in the browser.

## Prerequisites

- Node.js 20 or newer
- pnpm 9 or newer
- a stable Rust toolchain with `cargo`
- a Chromium-compatible browser

Start from a clean repository checkout and run every command from the
repository root. Install only this workspace without writing
the root lockfile:

```sh
pnpm install --filter @paperclipai/paperclip-runner --lockfile=false --ignore-scripts --dev
pnpm --filter @paperclipai/paperclip-runner exec playwright install chromium
```

On a minimal Linux host, Playwright may also request system browser libraries:

```sh
pnpm --filter @paperclipai/paperclip-runner exec playwright install-deps chromium
```

## 1. Check the contract and golden corpus

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck
pnpm --filter @paperclipai/paperclip-runner check:replay-goldens
pnpm --filter @paperclipai/paperclip-runner check:replay-parity
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

Expected: generated schema sources are current, TypeScript and Rust accept the
same fixtures, all parity summaries match, and the standalone boundary passes.

## 2. Replay the happy path in the CLI

```sh
pnpm --filter @paperclipai/paperclip-runner replay:fixture
```

Expected JSON facts:

- `ok` is `true`;
- `snapshot.integrity` is `complete`;
- `snapshot.timeline` contains 9 entries;
- `snapshot.terminal.runTerminalState` is `succeeded`.

Pass a different fixture path to inspect another case:

```sh
pnpm --filter @paperclipai/paperclip-runner replay:fixture packages/paperclip-runner/protocol/fixtures/replay/source-gap.json
```

Expected: `snapshot.integrity` is `gap_detected` and the missing source sequence
is `3`.

An unsupported required version exits non-zero and returns a structured error:

```sh
pnpm --filter @paperclipai/paperclip-runner replay:fixture packages/paperclip-runner/protocol/fixtures/replay/unsupported-required-version.json
```

## 3. Open the standalone replay page

Start the package-local Vite server:

```sh
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179
```

Open `http://127.0.0.1:4179`, then:

1. Select `Happy path` and confirm the terminal badge reads `succeeded`.
2. Edit the fixture summary in the JSON textarea and select **Validate & replay**.
3. Select `Duplicate event` and confirm one duplicate is ignored.
4. Select `Source sequence gap` and confirm the missing sequence diagnostic.
5. Select `Unsupported required version` and confirm replay is rejected.
6. Expand **Inspect snapshot JSON** and compare it with the CLI output.

Stop Vite with `Ctrl+C`.

## 4. Run the browser regression path

```sh
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner test:browser
```

Expected: the Playwright tests pass and temporary screenshots are written under
the ignored `packages/paperclip-runner/test-results/` directory. The regression
suite does not rewrite committed evidence images.

## What this proves

- JSON Schema is the executable source for validation and TypeScript types.
- The CLI and browser call the same validator and reducer.
- Duplicate delivery is idempotent and sequence gaps remain visible.
- Unknown optional fields do not change the v1 projection.
- No Paperclip server, UI, CLI, adapter, or production database module starts or
  imports into the standalone path.

Local runner is outside this tutorial and must not start before the Replay human
checkpoint.
