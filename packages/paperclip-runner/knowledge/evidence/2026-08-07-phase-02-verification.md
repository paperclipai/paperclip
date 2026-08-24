---
type: Verification Evidence
title: Phase 2 verification
description: Exact tools, commands, results, and screenshots for the local runner and fake harness.
tags: [native-runner, phase-2, verification, rust, supervisor, fake-driver, browser]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-07T22:13:00Z }
phase: "2"
---

# Environment

- OS: `Linux 6.17.0-1019-aws aarch64`
- Node.js: `v22.22.2`
- pnpm: `9.15.4`
- Vitest: `4.1.10`
- Vite: `6.4.1`
- Playwright: `1.61.1`
- Rust/Cargo: `1.97.1` in the user-local toolchain

# Commands and observed results

## 1. Rust formatting, tests, and process cleanup

```sh
cargo fmt --manifest-path packages/paperclip-runner/runner/Cargo.toml --all -- --check
cargo test --manifest-path packages/paperclip-runner/runner/Cargo.toml --locked --workspace
```

Result: exit 0. Rust formatting passed. Eighteen library tests and two supervisor
integration tests passed. The cleanup test proved that the harness and spawned
worker process group both stop.

## 2. TypeScript and live-run conformance

```sh
pnpm --filter @paperclipai/paperclip-runner test:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
```

Result: exit 0. Eight Vitest files and 46 tests passed. The Phase 2 cases cover
driver lifecycle, command and file items, bounded logs, duplicate commands,
permission/input, interruption, error exit versus semantic result, duplicate
terminal suppression, controller-disconnect cleanup, credentials, live/replay
parity, and the operator-safe rejection of a command sent after completion.

## 3. CLI scenario matrix

```sh
for scenario in happy-path permission-input interrupted error duplicate-terminal; do
  node packages/paperclip-runner/dist/cli/phase2-mock-core.js --scenario "$scenario" --quiet
done
node packages/paperclip-runner/dist/cli/phase2-mock-core.js \
  --scenario happy-path --quiet --duplicate-turn-command
```

Observed facts:

| Scenario | Events | Terminal | Semantic result | Harness exit | Runner exit |
|---|---:|---:|---|---:|---:|
| happy path | 19 | 1 | `done` | 0 | 0 |
| permission/input | 20 | 1 | `done` | 0 | 0 |
| interrupted | 16 | 1 | `yielded` | 130 | 0 |
| error | 15 | 1 | `yielded` | 7 | 0 |
| duplicate terminal | 15 | 1 | `done` | 0 | 0 |

The duplicate turn command returned one duplicate receipt and did not create a
second `turn.started` event.

## 4. Browser build, interactions, and screenshots

```sh
pnpm --filter @paperclipai/paperclip-runner build:browser
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner test:browser
```

Result: exit 0. Vite transformed 219 modules. The token check passed. Six
Playwright tests passed in 14.3 seconds. They cover Phase 1 static replay,
duplicate/version states, live completion and replay parity, permission/input,
and interruption with one terminal event. The permission/input test deliberately
waited 10.5 seconds before submitting input and still completed with replay
parity.

The documented development server was also started directly:

```sh
pnpm --filter @paperclipai/paperclip-runner browser:dev --host 127.0.0.1 --port 4179
curl -fsS http://127.0.0.1:4179/
curl -fsS http://127.0.0.1:4179/src/main.tsx
```

Result: both requests returned successfully, the Vite process stayed alive, and
dependency optimization emitted none of the Ajv downlevel-transform errors.

The minimal host lacked Chromium libraries. The rootless helper downloaded
and extracted the matching Ubuntu packages under
`$PAPERCLIP_RUN_SCRATCH_DIR/arm64`, then scoped `LD_LIBRARY_PATH` to
the verification process. No system package was installed and no root access
was used. Playwright screenshots were written under ignored `test-results/`
paths, leaving the committed evidence images unchanged.

## 5. Boundary and knowledge checks

```sh
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Result: exit 0. The standalone boundary passed. Documentation links and the OKF
v0.2 bundle passed validation.

## 6. Complete package acceptance sequence

```sh
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

Result: exit 0 with the rootless browser-library path active. The command built
Rust, TypeScript, and browser outputs; ran all typechecks, tests, goldens,
parity, token, boundary, browser, docs, and OKF checks; ran the Phase 0 tracer
and Phase 1 replay; and finished with the Phase 2 happy-path summary.

# Browser artifacts

## Completed live run

[Phase 2 completed run screenshot](phase-02-live-complete.png)

- PNG: 1440 × 1851, RGB
- SHA-256: `01524691337ad58d1b9f4592685a7d3b67d225e1c8aede6afdc576d1a5b5dc15`
- Shows 19 validated events, process exit 0, semantic result `done`, one terminal
  event, and live/replay `Match`.

## Permission request

[Phase 2 permission screenshot](phase-02-live-permission.png)

- PNG: 1440 × 1196, RGB
- SHA-256: `1b33f2345299badef63f8f9ea300aa3d9d46148e5f29aca0b8419c5526f7881d`
- Shows the live pending permission request before resolution.

## Interrupted run

[Phase 2 interrupted run screenshot](phase-02-live-interrupted.png)

- PNG: 1440 × 1656, RGB
- SHA-256: `35a6d90e9647bb3ac477c39240652ad9c427c93cec10f2eeada609001d6a45dc`
- Shows exit 130, semantic result `yielded`, cancelled terminal state, one
  terminal event, and live/replay `Match`.

# Acceptance mapping

- Deterministic Rust runner and supervisor: passed.
- Small local harness transport: stdio JSONL passed.
- Timing, error, permission, input, interruption, and terminal scripts: passed.
- Mock-core command/event loop through package contracts: passed.
- Bounded logs and separate process/semantic facts: passed.
- Driver conformance and controller/harness cleanup: passed.
- Duplicate commands and exactly one terminal event: passed.
- Browser live mode with Phase 1 validator/reducer: passed.
- Live/replay parity: passed.
- Package reference, tutorial, cumulative steps, evidence, OKF journal, and
  screenshot set: linked and validated.

# Remaining risk

The local process and in-memory browser path do not prove Phase 3 durable
delivery or reconnect behavior. Production Paperclip behavior remains unchanged.
