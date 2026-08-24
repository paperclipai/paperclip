---
type: Verification Evidence
title: Phase 3 durable transport verification
description: Package-only evidence for lost-ACK replay, restart recovery, command deduplication, and redacted diagnostics.
tags: [native-runner, phase-3, websocket, recovery, evidence]
status: stable
generated: { by: openai/gpt-5, at: 2026-08-07T23:31:00Z }
---

# Scope

This evidence covers the package-local mock core and runner transport. It does not use the Paperclip server or UI.

# Required checks

```sh
pnpm --filter @paperclipai/paperclip-runner typecheck
pnpm --filter @paperclipai/paperclip-runner test
pnpm --filter @paperclipai/paperclip-runner check:browser-tokens
pnpm --filter @paperclipai/paperclip-runner check:forbidden-imports
pnpm --filter @paperclipai/paperclip-runner docs:validate
pnpm --filter @paperclipai/paperclip-runner record:phase3
pnpm --filter @paperclipai/paperclip-runner verify:rootless
```

# Acceptance mapping

- The runner uses an outbound loopback WebSocket.
- A one-time bootstrap ticket creates a connection lease.
- A lost acknowledgement keeps one event in the durable outbox.
- A restarted runner loads the same identity and sends the event again.
- The mock core records one logical event and one duplicate delivery.
- The runner records one repeated command and one command effect.
- The terminal event uses the same runner and session IDs.
- Drain and revoke states are visible.
- CLI and browser diagnostics do not contain the ticket or lease token.

# Recorded outputs

- [CLI recovery trace](phase-03-recovery-trace.json)
- [Complete fault matrix](phase-03-fault-matrix.json)
- [Per-fault exact outputs](phase-03-faults/)
- [Browser recovery screenshot](phase-03-recovery-diagnostics.png), 1440 by
  1000 pixels, SHA-256
  `2c79ea7a9834943ee9dc3dfc6a5c4eb9359518cf773882dc75882031710f84d0`.

# Local verification result

- TypeScript tests: 61 passed.
- Rust tests: 34 passed, including fourteen Phase 3 transport, storage,
  deduplication, secret-lifecycle, destination, and state-file tests.
- Focused Phase 3 and browser-middleware tests: 21 passed.
- Phase 3 fault tests: 14 passed, including one-time ticket reuse rejection,
  cross-runner credential rejection, and symlink-safe mock-core state.
- Browser tests: 7 passed with the rootless Linux library path.
- TypeScript, Rust, and browser typechecks passed.
- Browser token, package boundary, documentation link, and OKF checks passed.
- All eleven recorded fault traces passed all seven assertions.
- The complete package `verify` path passed through `verify:rootless`.
- Destination tests reject public, private, wildcard, mixed-answer, userinfo,
  query, fragment, and malformed WebSocket targets before a capability is sent.
- State tests reject symlinks, preserve an attacker-chosen sibling target, and
  verify private file modes. A real child-process test proves the captured
  bootstrap capability is absent from inherited environment data.

The first browser attempt found missing host libraries. The rootless package
script supplied private copies without changing the host.

The first documentation pass also found the linked Phase 3 screenshot was not
yet in the evidence directory. The passing browser run produced it, it was
visually inspected, and the final verification used the checked evidence file.

# Review state

- Security review: pending.
- UX review: pending.
- QA tutorial run: pending.
- Human checkpoint: pending.
