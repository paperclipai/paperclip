---
type: Verification Evidence
title: Phase 4b live console verification
description: Deterministic driver, transcript-model, browser, boundary, and screenshot evidence for the package-local live Codex protocol console.
tags: [native-runner, phase-4b, browser, console, evidence]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-08T05:25:00Z }
---

# Scope

This record covers the Phase 4b browser layer: the deterministic demo driver,
the demo-chat manifests, the additive demo-server routes, and the **Live
console** mode in `devtools/browser/`. Every file is under
`packages/paperclip-runner/`. No Paperclip server, UI, database, or
control-plane file is imported or changed.

# Deterministic evidence

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck:typescript
pnpm --filter @paperclipai/paperclip-runner typecheck:browser
pnpm --filter @paperclipai/paperclip-runner exec vitest run
```

Result: typecheck clean; **14 test files, 133 tests passed**.

New deterministic coverage:

| File | Tests | Proves |
| --- | --- | --- |
| `src/mock-core/phase4b-scripted-driver.test.ts` | 15 | schema-valid canonical events, steering acknowledgement, stale-turn and already-terminal rejection, interrupt before start, preserved partial text, interrupted tool with no fabricated result, single-response requests, answers absent from acknowledgements, goal lifecycle, exact unsupported-goal diagnostic, child lineage terminal states, failed turn, resumed identity and continued source sequence |
| `devtools/browser/src/live/transcript-model.test.ts` | 11 | role mapping, timeline-ordered transcript, submitted-message rendering, interrupted projection, resolved-request record, exact failure diagnostic, live/replay projection equality, composer state machine, goal capability gating, capability diagnostics |

# Browser evidence

```sh
pnpm --filter @paperclipai/paperclip-runner test:browser
```

Result: **28 tests passed** — 19 new live-console tests plus the 9 pre-existing
Phase 1-3 tests, which are unchanged and still pass.

The live-console tests assert, at both evidence viewports where relevant:

1. empty state, streamed turn, and a completed turn with a structured result;
2. steering acknowledgement, and a stale steer that keeps its text recoverable;
3. all three interrupt races, each with a distinct visible outcome;
4. approval cards that render only the offered actions, lock on first click,
   and collapse to a named resolution;
5. a submitted user-input answer and an unanswered request that expires;
6. the goal lifecycle, and the exact upstream diagnostic on a disabled menu
   mirrored in the inspector's Capabilities tab;
7. child threads with persistent terminal states and an explicitly disabled
   child composer carrying the exact diagnostic;
8. a failed item with its exact diagnostic in the transcript record;
9. a transport drop, a resume to a byte-identical transcript, and a page
   refresh that restores the same session;
10. replay mode with its `REPLAY` badge and stepper;
11. the inspector, including a live-versus-replay reducer comparison reading
    `match`;
12. the keyboard contract: `Escape` focuses Stop without interrupting, `Enter`
    steers, inspector tabs and the lineage tree respond to arrow keys, and the
    transcript is a labelled `role="log"` region with `aria-live="polite"`;
13. a reset dialog that names exactly what it discards;
14. a 390x844 pass with no horizontal page overflow.

Two negative assertions run against the rendered DOM: no `Bearer ` string and
no `auth.json` reference reaches the browser.

# Boundary and token evidence

```sh
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
node --test scripts/check-forbidden-imports.test.mjs
```

Result: all pass (4 boundary tests).

The boundary check now rejects `ai`, `@ai-sdk/*`, `zod`, `radix-ui`,
`@radix-ui/*`, `cmdk`, `streamdown`, `shiki`, `use-stick-to-bottom`,
`class-variance-authority`, `tailwindcss`, and `nanoid` anywhere under
`devtools/browser/`. A negative fixture in
`test-fixtures/forbidden-ui-runtime/` proves the rule fires. The console adds
**zero new runtime dependencies**.

# Screenshots

23 screenshots in [`phase-04b/`](phase-04b/), captured by the browser suite:

- Desktop (1440x900): idle and empty, streaming turn, completed turn, steering
  acknowledged, interrupt before start, interrupt during generation, interrupt
  during a tool call, pending request, resolved request, expired request, goal
  supported, goal unsupported, lineage with a child selected, failed turn,
  reconnect banner, refresh replay, replay mode, inspector events, inspector
  session.
- Mobile (390x844): idle and empty, session segment, pending request,
  inspector.

# Documentation evidence

```sh
pnpm --filter @paperclipai/paperclip-runner docs:validate
```

Result: documentation link validation and OKF v0.2 validation both pass.

# Known gaps

1. Real-Codex evidence for the console screens is a QA step. The scripted
   driver proves every surface; `PAPERCLIP_PHASE4B_DRIVER=codex` runs the same
   routes against a real session and needs a machine with a Codex login.
2. An assistive-technology pass (screen reader) is specified in the interaction
   map and asserted here only at the semantics level.
3. Child-thread steering is unsupported upstream, so the console shows the
   disabled composer rather than a live one.

# Startup command for QA

```sh
pnpm --filter @paperclipai/paperclip-runner console:phase4b
```

Then open `http://127.0.0.1:4180/` and press **Live console**. Add
`-- --host 0.0.0.0` to reach it from another host.
