# Capability Paperclip-style issue-thread UI

Capability renders the mock Paperclip issue as a native issue thread. A board user
reads the thread, answers typed interactions inline, and inspects the evidence
behind every mock mutation. The implementation follows the binding
[Capability issue-thread UX contract](design/capability-issue-thread-ux-contract.md).

The same shell hosts a second primary path: the
[clean-room live chat](capability-clean-room-chat.md) at `#/chat`, which starts a
blank thread on a freshly minted mock tenant instead of a preset scenario. It
reuses every surface described below — header, thread, composer, and Evidence
panel — and differs only in what the session is seeded with and in refusing any
non-live mode.

## Authority boundary

```text
browser  ->  package server  ->  CapabilityLiveSession  ->  paperclip-runnerd -> codex
             (projection)        CapabilitySemanticDispatcher -> ControlPlanePort mock
```

The browser holds no authority. It renders one shape,
`CapabilityIssueThreadSnapshot` (`src/issue-thread/types.ts`), and computes no
claim, policy decision, state diff, or parity verdict. Two producers emit that
shape:

- `capabilityIssueThreadFixture(slug)` — deterministic `fake` snapshots used by the
  screenshot matrix and the browser suite.
- `projectCapabilityIssueThread({ snapshot })` — the live projection. It runs in the
  package server and rearranges durable records only: the live session's
  transcript, evidence entries, semantic authorization records, and the
  serialized mock state.

The one browser-initiated mock mutation is an interaction response. It posts to
`POST /api/capability/ui/interaction`; `CapabilityLiveSession.resolveInteraction` stores
the typed response in the mock control plane **before** resuming the same Codex
thread, so the card only leaves `submitting` on server acknowledgement.

No provider, runner, or control-plane credential reaches the page. Redacted
fields render as `••• redacted` with the redaction rule name, mock issues use
the reserved `MCK-` prefix, and no real Paperclip URL is ever rendered.

## What the browser is allowed to see

The projection is an internal shape. What ships is the published DTO,
`toCapabilityPublicThreadView` (`src/issue-thread/public-view.ts`), which copies the
view field by field — so a field added to the projection, or to any record it
passes through, cannot reach a browser until it is listed there. Every response
path uses it: interim stream frames, the settled payload, and reconnect or
replay replies alike.

Three narrowings stack, so no single omission opens a disclosure path:

1. **At record time.** `redactCapabilityEvidenceData`
   (`src/live/evidence-redaction.ts`) is the only way an evidence entry enters
   a live session. Provider notifications are reduced to a coarse category,
   provider diagnostics to the fact that one occurred, tool arguments to the
   catalog-declared field names they used, and tool results to the outcome,
   revisions, and mock entity refs the UI resolves into cards. Provider thread
   and session identity, model and token metadata, and raw tool payloads are
   never retained, so no later reader, frame, or log can republish them.
2. **In the projection.** `Runner & events` details are composed from the
   redacted record rather than stringified from it, and `Calls & results` names
   the operation and its field count instead of echoing arguments.
3. **In the DTO.** Provider-authored turn and call identifiers are replaced by
   in-view aliases (`turn-1`, `call-1`) that stay consistent across anchors,
   evidence refs, and successive frames of one turn, and any value the caller
   declares withheld is scrubbed from the encoded result.

A streamed turn that fails answers with a code and fixed operator copy; the
underlying message stays server side, because provider text can quote prompts
and paths.

## Session capability

Every session-scoped route is bound to a per-browser capability. The server
mints one on session creation, stores only its SHA-256 with the session record,
sets it as an `HttpOnly; SameSite=Strict` cookie, and compares it in constant
time on every read and mutation — message, reconnect, interaction, stop, reset,
and new chat. A valid session id presented without its capability is answered
`404`, exactly like an id that never existed, so an unauthorized caller cannot
tell a live session from a dead one.

Rotation belongs to the actions that start something new — `New chat`, a scenario
POST, reset. Each revokes the caller's existing bindings before issuing the
replacement cookie. Reopening a page whose stored id is simply gone mints a
session under the capability the browser already holds instead, because rotating
there would make two tabs of one surface revoke each other on every load while
protecting nothing: one browser is one principal, and cross-browser denial rests
on the binding rather than on how often the value changes.

The two surfaces use separate cookie names (`paperclip_capability_issue`,
`paperclip_capability_chat`) because they are separate pages of one origin: a single
name would make opening the explorer revoke the clean room. A script that drives
these routes has to behave like one browser — `scripts/capability-cookie-jar.mjs` is
what the smoke scripts use for that.

## Surfaces

- **Header** — three identity chips (`Real Codex` / `Fake agent` / `Replay`,
  `Real runnerd` / `In-process runner`, and `Mock Paperclip` in every mode),
  status, priority, run state, and the Scenario/Replay/Reset/Stop controls.
  `data-session-mode` carries the mode as data, never as styling.
- **Thread** — turn groups binding the contract's T1–T11 item types: user
  messages, model prose, durable progress comments marked
  `Recorded to mock thread`, collapsed tool strips, interaction cards, document
  revision cards, deliverables, delegation cards, terminal dispositions, typed
  denials, and muted system notices.
- **Composer** — six mutually exclusive states behind `data-composer-state`:
  `ready`, `sending`, `streaming` (input stays editable to steer; Stop is
  primary), `waiting`, `reconnecting`, and `disabled`. Drafts survive refresh.
- **Evidence panel** — eight accordion sections in fixed order: Tools exposed,
  Calls & results, Authorization, Control plane, Runner & events, State diff,
  Traceability, Parity. The Tools section groups `Agent tool — always`,
  `Agent tool — granted` (with its grant), and a separated
  `Control plane (not exposed to the agent)` list, because what the model
  *cannot* call is first-class evidence. Every strip, denial, and card deep-links
  into the matching record, and each record links back to its thread anchor.
  Live sessions additionally put a six-tab DevTools inspector above these
  sections: revision timeline, complete browser-safe company state, structural
  diff, protocol records, runtime, and authority. The inspector can pause live
  following, export redacted JSON, and fork a retained revision.

The panel is collapsed by default and resizable between 320px and 640px with a
keyboard-operable splitter. Below 1100px it becomes an overlay sheet that
Escape dismisses; below 768px the page switches to a `Thread` / `Evidence`
segmented control, with Stop kept outside the `⋯` menu while a turn is active.
Closing the panel by either route hands focus back to the visible control that
owns it.

- **Replay strip** — in `mode=replay` a progress strip pins under the header
  with `Step back`, `Next turn`, and `Play all`. `?at=<ordinal>` is the single
  source of truth for the parked ordinal, so the three controls and the deep
  link all move the same value; `Play all` advances one ordinal every 800 ms
  and parks itself at the end of the recording.

## Routes

```text
#/issue/<fixtureProfile>?shot=<slug>&panel=<section>&rec=<id>&at=<ordinal>&seg=thread|evidence&mode=live
```

- `shot` seeds one of the twelve deterministic `fake` states.
- `mode=live` opts into the package session server; the default is `fake`.
- `capture=1` freezes animation, caret, and smooth scrolling for screenshots.
- The root element sets `data-thread-state="settled"` once hydration, fixture
  load, and auto-scroll finish. Tooling waits for that attribute, never a
  timeout.

## Commands

```sh
# Deterministic fake-mode app (no provider process)
pnpm --filter @paperclipai/paperclip-runner console:issue-thread

# Focused browser suite, including the axe gate on all 12 slugs × 2 viewports
pnpm --filter @paperclipai/paperclip-runner test:browser:scenarios

# View-model and live-projection unit tests
pnpm --filter @paperclipai/paperclip-runner exec vitest run src/issue-thread

# Screenshot matrix (12 slugs × 2 viewports) and its byte-stability check
# Recorded evidence generation is deferred from this release.
pnpm --filter @paperclipai/paperclip-runner check:capability:ui

# Real runnerd + real Codex through the same HTTP routes the browser uses
pnpm --filter @paperclipai/paperclip-runner smoke:capability:ui
# Recorded evidence generation is deferred from this release.
```

Hosts without the Playwright chromium system libraries can either run
`pnpm --filter @paperclipai/paperclip-runner verify:rootless` or set
`PAPERCLIP_RUNNER_CHROMIUM_PATH` to a preinstalled Chromium.

The committed PNGs are pinned to the Chromium build listed in
`.paperclip-local/evidence/capability/ui/index.md`, so `check:capability:ui` needs that same
browser. Point `PAPERCLIP_RUNNER_CHROMIUM_PATH` at the recorded browser before
comparing — and when that path is the agent-browser wrapper, also set
`PAPERCLIP_CHROMIUM_BIN` to the exact binary, because the wrapper otherwise
picks the newest installed Playwright Chromium. The issue-thread bundle
self-hosts its Latin Inter and DejaVu Sans Mono WOFF2 faces plus tiny status-glyph
subsets, so host fontconfig directories do not participate in capture. The recorder probes the
package-specific bundled families and refuses to record or compare when either
face is absent or fails to load; the drift report prints the Chromium version
and bundled-font probe it recorded with.

## Accessibility

The suite enforces the contract's blocking gate: axe reports zero serious or
critical WCAG 2.1 A/AA violations on every screenshot route at both viewports.
Structure is one `h1`, `header`/`main`/`complementary` landmarks, a `form`
composer, `section` interaction cards labelled by their prompt, and tool strips
as disclosure buttons with `aria-expanded`. Every state chip pairs color with a
glyph and text, all actionable controls clear 44×44 CSS px on mobile, and
`prefers-reduced-motion` disables the pulse dot, banner slide, and smooth
scrolling.

Focus management (§9.2) is covered by named regressions in the browser suite:

- Opening Evidence moves focus to its heading; closing it — with the `Close`
  button or with Escape on the overlay sheet — returns focus to the toggle.
- Resolving an interaction card moves focus to the card's state chip. The
  controls the user just operated unmount on resolve, so without this the
  keyboard caret drops to `body` at the moment the card changes.
- The `waiting` composer's anchor moves focus to the pending card's first
  control.

## Contract deviations

One deviation is recorded against the Capability contract:

- **§5 expired-family dimming.** The contract asks for a 60% opacity body on
  `stale_target` and the other expired outcomes. A literal opacity drops that
  card's text to ~3.2:1 and fails the blocking axe gate in §9.7. The dim is
  implemented as a recessed surface plus muted text that still clears 4.5:1.

## Determinism notes

Fake-mode fixtures render from authored data with a fixed clock, so two captures
of a slug from a clean checkout are byte-identical. Live sessions are not
byte-stable — a real model writes their prose — so live evidence lives in
`.paperclip-local/evidence/capability/ui-live/` and is excluded from the determinism gate.
Durable comments in live mode carry the mock control plane's own deterministic
clock rather than wall time, because that is the timestamp on the mock record.
