---
type: QA Verification Evidence
title: Phase 4b live console — independent QA pass
description: QA Engineer independent execution of the Phase 4b clean-start tutorial, deterministic demos, real-Codex end-to-end session, full package acceptance, and browser screenshots.
tags: [native-runner, phase-4b, qa, browser, evidence]
status: stable
generated: { by: anthropic/claude-opus-4-8, at: 2026-08-08T06:35:00Z }
issue: PAP-16837
---

# Scope

Independent QA of the Phase 4b browser console and its protocol/demo server,
executed against a live service on the execution machine (branch
`PAP-16679-paperclip-runner`, head `cda1fb03ab`). This record supplements the
implementer's evidence
([2026-08-08-phase-04b-live-console-verification.md](2026-08-08-phase-04b-live-console-verification.md))
with a from-scratch QA execution: real browser interaction, a real Codex turn,
and the full package acceptance command run end to end.

# Environment

- node 22.22.2, pnpm 9.15.4, codex-cli 0.132.0 (login present at `~/.codex/auth.json`).
- Browser driver: agent-browser 0.33.2 using the ARM64 runtime chromium
  (`.paperclip/browser-runtime/chromium-arm64/bin/chromium-agent-browser`).
- Live service (demo driver): `pnpm --filter @paperclipai/paperclip-runner console:phase4b`
  → vite dev server on **http://127.0.0.1:4180/** (loopback-bound by design;
  the server enforces a loopback bind host and is intentionally NOT exposed on
  the tailnet / `paperclip-dev` host).
- Real-Codex service: `env -u PAPERCLIP_WORKSPACE_CWD PAPERCLIP_PHASE4B_DRIVER=codex
  pnpm --filter @paperclipai/paperclip-runner exec vite --config vite.config.ts
  --host 127.0.0.1 --port 4185` → http://127.0.0.1:4185/.

# Automated acceptance

Run with `PATH` including `~/.cargo/bin` and
`LD_LIBRARY_PATH=.paperclip/browser-runtime/chromium-arm64/root/usr/lib/aarch64-linux-gnu`
(the two host-toolchain prerequisites on this aarch64 box: Rust toolchain and
the shared libraries Playwright's headless_shell needs — `libatk-1.0.so.0` etc.).

| Command | Result |
| --- | --- |
| Step 1 targeted suites (scripted-driver, demo-server, transcript-model) | **40 passed** |
| `verify` → vitest (unit) | **15 files, 151 passed** |
| `verify` → Playwright browser | **28 passed** (40.4s) |
| `verify` → Rust workspace (`cargo test`) | ok — 37 core + parity suites passed |
| `verify` → goldens / phase0+1 parity / traces / replay / docs / forbidden-imports / browser-tokens | all passed |
| **`pnpm --filter @paperclipai/paperclip-runner verify`** | **exit 0** |

The 28 Playwright tests deterministically cover every tutorial step, including
the two fast interrupt races (during-generation, during-tool), goal-unsupported
exact diagnostic + capabilities mirror, child threads + refused child steering,
transport-drop resume, refresh restore, replay stepper, reducer parity `match`,
and the keyboard contract.

# Manual browser evidence (screenshots in `phase-04b/qa-2026-08-08/`)

| Step | Observed | Shot |
| --- | --- | --- |
| Idle empty | "Pick a demo chat", disabled Send, "Standalone · No Paperclip Core" | `01-idle-empty.png` |
| Clean turn | YOU → Reasoning → Tool `read_file` (Completed) → answer → Turn Completed; card auto "Passed Observations" | `03-completion-done.png` |
| Same-turn steering | live `pending → acknowledged` chip; typed text preserved (recoverable, never discarded) | `04b-steer-acknowledged.png` |
| Approvals | banner "1 request waiting — Review"; 4-action card locks + collapses to "resolved — Approve for session"; next card offers only Approve/Reject; Reject resolves | `06b-approval-resolved.png` |
| User input + expiry | two inputs resolve; third → `expired before response`; submitted answer never in the ack | `07e-expired-clean.png` |
| Interrupt before start | `Cancelled Before Start — interrupted before the provider accepted the turn`; no answer item | `05a2-interrupt-before-start.png` |
| Goal supported | Goal menu enabled after demo; "Set goal"; card "Passed Observations" | `08a-goal-supported.png` |
| Protocol inspector | tabs Events/Requests/Capabilities/Session; **Credentials in browser = No** | `09-inspector.png` |
| Session panel | Connected; Pending 0; **Credentials in browser = None**; Run/Session ids | `09b-inspector-session.png` |
| **Real Codex turn** | live streaming (~14s); multiple Reasoning + real `commandExecution` tools + SYSTEM events + genuine answer; `providerAuthentication: server-side`, `credentialsExposed: false` | `10-codex-real-turn.png` |

# Security / boundary confirmations

- Session-create response: `providerAuthentication: "server-side"`,
  `credentialsExposed: false`. Inspector reads **No**, session panel reads
  **None**. The browser never holds a provider login.
- Same-origin transport enforcement is live: `GET /api/phase4b/…` from a
  non-same-origin fetch returns `invalid_fetch_metadata` (Sec-Fetch-Site
  required).
- The codex driver enforces its working-directory boundary
  (`PAPERCLIP_WORKSPACE_CWD`); a temp dir outside it is rejected with
  "Codex working directory is outside the assigned workspace".

# Verdict

PASS. Every acceptance gate ran and passed; the clean-start tutorial behaves
exactly as written in a real browser; a real Codex end-to-end session works
through the same canonical protocol UI with credentials held server-side.
