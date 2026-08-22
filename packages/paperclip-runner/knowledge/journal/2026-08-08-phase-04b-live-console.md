---
type: Engineering Journal Entry
title: Phase 4b live console browser tracer
description: Decisions, failures, fixes, and evidence for the package-local browser console over the canonical runner protocol.
tags: [native-runner, phase-4b, browser, console, reducer]
status: stable
generated: { by: anthropic/claude-opus-5, at: 2026-08-08T05:25:00Z }
entry_kind: phase
phase: "4b"
---

# Context

The [protocol and demo-server layer](2026-08-08-phase-04b-protocol-server.md)
gave the browser typed routes and a server-only credential boundary. The
[UX gate](2026-08-08-phase-04b-ux.md) gave it an approved interaction map and a
component decision record. This entry records building the console itself.

# Decisions

1. Extend the existing devtool with a **Live console** mode. Do not build a
   second app shell.
2. Keep one data contract: canonical PRP events plus the shared reducer. The
   browser runs `applyPrpEvent`, the same function the server and CLI run, so
   live output and replayed output cannot drift.
3. Add a deterministic scripted `HarnessDriver` behind the same demo-server
   routes the real Codex driver uses. The console can then reach every
   protocol state without a provider account, and the real driver is a single
   environment variable away.
4. Let the manifest, not the UI, own the list of expected observations. The
   human checkpoint script lives in the data, not in hand-written copy.
5. Adapt shadcn/ui and AI Elements source with zero new runtime dependencies.
   Rebuild the radix-backed patterns on native primitives: `<dialog>` for
   modals, `<details>` for disclosures, the WAI-ARIA tabs and menu-button
   patterns by hand.
6. Put the submitted message text into the `turn.submitted` payload so the
   transcript can show the operator's own message from a canonical event
   instead of a shadow store.
7. Render exactly one layout. A second CSS-hidden copy would duplicate the
   transcript log landmark and every control in the DOM.

# Failures and fixes

1. **The mobile and desktop trees both rendered.** The first build hid one with
   a media query. That duplicated every `data-testid`, every interactive
   control, and the `role="log"` landmark. Fixed with a `matchMedia` hook that
   renders one tree.
2. **A resumed stream never opened.** The SSE route wrote its headers and then
   waited. When a subscriber resumed past the last event there were no bytes to
   send, so Node held the response open and the browser stayed in `CONNECTING`
   forever. Fixed by writing an SSE comment immediately after the headers.
   This only appeared after a reconnect, which is exactly the case the phase is
   about.
3. **A finished turn stayed steerable.** The composer read
   `snapshot.activeTurnId ?? state.activeTurnId`. When the reducer correctly
   set the active turn to `null`, the nullish fallback reached back to a stale
   public-state read and the primary action stayed **Steer**. Fixed by making
   the reducer authoritative whenever a snapshot exists.
4. **Interrupt before start was unreachable.** The composer left `submitting`
   as soon as the create call returned, so **Stop** was disabled during the
   exact window the race needs. Fixed by deriving the pending-turn state from
   the timeline: a `turn.submitted` with no later `turn.*` event.
5. **Lineage, goals, and pending requests went stale.** The event stream
   carries events; those fields live in the server's public state. Fixed with a
   debounced state refresh whenever new events arrive.
6. **The left rail overflowed its track.** Long run and session identifiers
   gave the rail panels a min-content width of 398px inside a 272px track, and
   the panels slid under the transcript. Fixed with `minmax(0, 1fr)` tracks and
   wrapping identifiers. Found by measuring bounding boxes in the browser, not
   by reading the CSS.
7. **The new mode broke five frozen Phase 1-3 browser tests.** Landing on the
   console changed the entry path those specs rely on. Reverted the landing
   mode and navigated explicitly in the new spec instead.

# Evidence

- 15 driver and manifest tests, 11 transcript-model tests, 19 live-console
  browser tests, and the 9 pre-existing browser tests all pass.
- 23 screenshots at 1440x900 and 390x844 in
  [`evidence/phase-04b/`](../evidence/phase-04b/).
- The boundary check now fails on any AI SDK, radix, Tailwind, or markdown
  runtime import under `devtools/browser/`, with a negative fixture proving it.
- Full record: [Phase 4b live console verification](../evidence/2026-08-08-phase-04b-live-console-verification.md).

# Gaps and next questions

1. Child threads are read-only because the app-server does not advertise child
   steering. If a later Codex release adds it, the disabled composer becomes a
   capability-gated live one; the diagnostic string is already the seam.
2. Real-Codex evidence for the console UI is a QA step, not an automated one.
   The scripted driver proves the surfaces; a human still has to confirm the
   same screens against a real session.
3. Screen-reader passes are specified in the interaction map and asserted at
   the semantics level here. An assistive-technology pass remains a QA task.
4. Markdown rendering and syntax highlighting stay rejected. If Phase 5 turns
   this into an SDK console, both become dependency decisions to revisit.
