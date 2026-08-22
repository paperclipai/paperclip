---
type: Engineering Journal Entry
title: Phase 4b protocol and demo-server layer
description: Decisions, failures, fixes, and evidence for browser-resolved Codex requests and the server-only credential boundary.
tags: [native-runner, phase-4b, codex, protocol, demo-server]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-08T04:35:00Z }
entry_kind: phase
phase: "4b"
---

# Context

Phase 4 proved one skillless real Codex run. Phase 4b needs a browser, but the
browser must not own Codex authentication or invent a second event model. This
entry records the lower driver and server contract built before the UI.

# Decisions

1. Store the installed Codex 0.132.0 wire shapes in one deterministic fixture.
2. Keep provider server requests pending until one typed browser resolution.
3. Map browser actions to narrow response unions. Never accept an arbitrary raw
   provider response from the browser.
4. Keep permission acceptance empty so it cannot widen the skillless sandbox.
5. Emit visible canonical acknowledgement items for steer and interrupt.
6. Reject stale turns and direct child steering. Never emulate either action.
7. Queue interruption only while `turn/start` lacks its provider ID. After a
   terminal, return `already_terminal`.
8. Probe goal support with the side-effect-free get method. Generated bindings
   alone do not prove runtime capability.
9. Derive subagent lineage from upstream thread source and parent identity.
10. Fix the demo server's workspace at construction. Browser bodies cannot
    choose filesystem roots.
11. Replay only validated canonical events through the existing reducer.
12. Apply browser redaction after driver redaction as defense in depth.

# Evidence

See the [verification record](../evidence/2026-08-08-phase-04b-protocol-server-verification.md),
[real Codex server trace](../evidence/phase-04b-real-codex-server.json),
[reference](../../docs/phase-04b-protocol-server.md), and
[tutorial](../../docs/tutorials/phase-04b-protocol-server.md).

# Failures

- The first HTTP test could not bind loopback inside the default sandbox. It
  passed unchanged with explicit loopback permission.
- The initial public redactor treated every key containing `token` as a secret
  and hid `tokenBudget`. The matcher now targets credential key names, not
  usage fields.
- The first real recorder workspace conflicted with the heartbeat's assigned
  workspace root. The recorder now supplies the exact scratch root to the
  driver rather than weakening containment.
- Codex generated goal types but returned method unavailable at runtime. The
  driver now disables the controls and records the diagnostic.

# Known gaps

- The demo server is an in-memory tracer boundary, not production persistence.
- Pending provider requests cannot survive loss of the provider process. The
  canonical pending fact remains replayable, and recovery records cancellation.
- The lower layer does not render UI or provide screenshots. The next Phase 4b
  browser task consumes this API.
- The real model did not exercise every request kind or a subagent. The
  deterministic fixture remains the conformance authority for those paths.

# Follow-up questions

- Should Phase 5 freeze HTTP polling plus SSE, or expose a transport-neutral
  client interface first?
- Which Codex feature advertisement should replace the goal method probe when
  the app-server publishes a stable capability list?
