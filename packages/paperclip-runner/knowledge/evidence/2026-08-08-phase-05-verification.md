---
type: Verification Evidence
title: Phase 5 browser SDK verification
description: Targeted and package-acceptance evidence for the versioned SDK, two public consumers, fake/real drivers, accessibility, reconnect, and replay.
tags: [native-runner, phase-5, sdk, browser, react, codex, evidence]
status: stable
generated: { by: openai/codex-local, at: 2026-08-08T07:50:00Z }
---

# Scope

This record covers Phase 5 under `packages/paperclip-runner/`: the versioned
browser and React surface, scoped styles, reference console, mini consumer,
package boundaries, fake and real drivers, documentation, and visual evidence.
It does not change production `server/`, `ui/`, database, routes, persistence,
or legacy adapters.

# Targeted tests

```sh
pnpm --filter @paperclipai/paperclip-runner test:phase5
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
```

Results:

- Phase 5 Vitest: **3 files, 20 tests passed**.
- TypeScript public and browser configurations: passed.
- Generated protocol source check: passed.
- SDK token gate: passed.
- Package/deep-import boundary gate: passed.

Coverage includes framework-free client errors and injection, exact duplicate
event delivery to the shared reducer, file/tool/plan projection, exact failure
diagnostics, component `data-slot` contracts, request locking, and the five
extension points.

# Fake-driver browser acceptance

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run test:browser:phase5
```

Result: **5 Playwright tests passed** in 16.4 seconds after adding an explicit
responsive-tree readiness check before mobile evidence capture.

The tests cover both public consumers, every required fake lifecycle state,
Composer/menu/dialog/tabs/replay keyboard behavior, one polite live region,
semantic control names, status text, reduced-motion-safe styles, exact mobile
and desktop bounding-box measurements, reconnect and gap recovery, durable
cursor replay, and live/replay reducer parity.

# Real Codex evidence

Direct server trace:

```sh
pnpm --filter @paperclipai/paperclip-runner record:phase4b -- \
  knowledge/evidence/phase-05/phase5-real-codex-trace.json
```

Result: passed. The trace proves exact file output, a validated semantic
result, one terminal event, continuous source sequence, stable run/session and
provider identity after reconnect, replay, explicit unsupported-goal state,
and absent provider credentials and host paths.

Browser consumers:

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run record:phase5:codex
```

Result: reference console passed and produced its live screenshot. The mini
consumer was then rerun independently after replacing a timing-sensitive real
steering visual with the safe completion manifest:

```sh
bash scripts/verify-rootless-linux.sh pnpm exec playwright test \
  --config examples/playwright.real.config.ts --grep 'mini consumer'
```

Result: **1 test passed** in 14.1 seconds. Codex explicitly reported goals as
disabled; the consumer kept its goal controls disabled. The public consumer
completed a safe real turn, reconnected the same session, entered replay, and
reported parity. Provider credentials were not rendered.

# Screenshots

The [`phase-05/`](phase-05/) directory contains 33 files:

- Reference console at 1440x900 and 390x844: idle, streaming, steering,
  interrupt, pending and resolved requests, goal, reconnect, replay, and
  failure.
- Mini consumer at both viewports: idle, custom renderer and token override,
  pending request with custom detail, reconnect, and replay.
- Live Codex reference-console and mini-consumer captures at 1440x900.
- The redacted real Codex trace described above.

Visual inspection covered a desktop idle surface, mobile pending request,
custom renderer/token override, mini real replay, and reference real Codex
completion. The mobile request controls fit the viewport; the live reference
shows a completed terminal tool and passed observations.

# Package acceptance

```sh
cd packages/paperclip-runner
bash scripts/verify-rootless-linux.sh pnpm run verify
```

Result: **passed with exit status 0**. Notable totals in the cumulative run:

- TypeScript: **18 files, 171 tests passed**;
- Rust: **37 unit tests and 2 supervisor integration tests passed**;
- boundary/recorder Node tests: **8 passed**;
- Phase 5 targeted suite: **20 passed**;
- accepted Phase 1–4b browser suite: **28 passed**;
- Phase 5 browser suite: **5 passed**;
- Phase 0 Rust/TypeScript and Phase 1 fixture/reducer parity: passed;
- Phase 0 tracer, Phase 1 replay, Phase 2 happy path, and Phase 3 lost-ACK
  recovery: passed.

# Documentation

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Result: documentation links and OKF v0.2 validation pass.

# Known provider constraints

Real-provider timing is not the oracle for race screenshots. The deterministic
driver owns steering, interrupt, request, and goal branches. Real Codex owns
the provider authentication boundary, normalized identity, redaction, safe
completion, reconnect, and replay. This preserves upstream terminal and
capability truth instead of hiding a real failure or fabricating support.
