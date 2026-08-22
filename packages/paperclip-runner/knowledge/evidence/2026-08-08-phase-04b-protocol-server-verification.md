---
type: Verification Evidence
title: Phase 4b protocol and demo-server verification
description: Deterministic and real-Codex evidence for browser-resolved requests, goals, lineage, controls, reconnect, replay, and credential isolation.
tags: [native-runner, phase-4b, codex, protocol, demo-server, evidence]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-08T04:43:00Z }
---

# Scope

This record covers the lowest Phase 4b driver, protocol fixture, and
package-local demo server. It changes nothing outside
`packages/paperclip-runner/` and exposes no Paperclip or provider credential to
the browser boundary.

# Deterministic evidence

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner exec vitest run \
  src/drivers/codex/codex-app-server-driver.test.ts \
  src/mock-core/phase4b-demo-server.test.ts
```

Result: TypeScript typecheck passed. The two focused files passed 37 tests.
The demo-server test needed permission to bind an ephemeral loopback port; its
first in-sandbox run failed with `listen EPERM`, then the same test passed with
loopback access.

The deterministic fixture covers all five upstream request kinds, five goal
operations, root/child lineage, same-turn steering, stale rejection,
interrupt-before-start, terminal races, recovery identities, and redaction.

# Package acceptance

```sh
pnpm --filter @paperclipai/paperclip-runner verify
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

The direct acceptance command passed its build, all typechecks, 107 TypeScript
tests, 39 Rust tests, script tests, and token gate before Chromium failed to
launch because this host does not install `libatk-1.0.so.0`. The repository's
supported rootless wrapper downloaded the browser libraries into the run-owned
scratch directory and then passed the complete acceptance path: 9 Playwright
tests, standalone/import and documentation checks, Phase 0 and Phase 1 parity,
and the Phase 0 through Phase 3 traces.

# Real Codex evidence

```sh
pnpm --filter @paperclipai/paperclip-runner record:phase4b
```

The first attempt correctly failed because the run-owned scratch directory was
outside the injected `PAPERCLIP_WORKSPACE_CWD`. The recorder now binds the
driver's assigned workspace root to that exact scratch directory. The second
attempt reached Codex but found that the generated goal methods were not
advertised at runtime. The recorder now records this as a precise disabled
capability instead of invoking a fake control. The final attempt passed.

Recorded result:

- Codex CLI/app-server: `0.132.0`;
- model/provider: recorded in the canonical session context;
- 190 canonical events before reconnect;
- 5 canonical events after the replay cursor, including `session.resumed`;
- exact output: `phase4b.txt` contains `phase4b real codex evidence`;
- exactly one semantic result and one turn terminal;
- continuous source sequence;
- stable run, normalized session, driver thread, and provider session IDs;
- explicit `goals: false` with `capability not advertised`;
- server-side provider authentication and no credential value in evidence.

See the [real server trace](phase-04b-real-codex-server.json).

# Failures fixed

- Replaced automatic request decline with one pending typed browser resolution.
- Added cleanup for provider resolution, terminal, protocol failure, close, and
  reconnect so a request cannot receive two responses.
- Added visible same-turn steering acknowledgements and exact stale-turn errors.
- Queued pre-start interrupts until the provider turn ID exists and return
  `already_terminal` when completion wins.
- Added capability-probed goal methods rather than version-only assumptions.
- Added parent/child lineage derived from upstream identity instead of inferred
  UI nesting.
- Added a second bounded browser redaction pass; narrowed its sensitive-key
  matcher after a test found that `tokenBudget` was incorrectly redacted.
- Redacted nested Paperclip home paths from Codex sandbox metadata after the
  final evidence scan found a server-side writable-root path.
- Made the demo server use only its configured workspace after the boundary
  test supplied a hostile browser path.

# Remaining ownership

The Phase 4b browser issue owns the React UI, request cards, controls, protocol
inspector, screenshots, accessibility checks, and persistent live-service
handoff. This lowest layer is ready for that consumer.
