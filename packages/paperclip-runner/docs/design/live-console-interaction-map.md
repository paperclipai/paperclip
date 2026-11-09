# Live console Interaction Map — Live Codex Protocol Web UI

Status: **approved for implementation** (UX gate TASK-16832, 2026-08-08).
Owner: UXDesigner. Implementer: browser tracer owner (TASK-16834).
Companion record: [component decisions](live-console-component-decisions.md).
This map is the interaction contract for the Live console required by
spec §29.1. It binds every surface to canonical Paperclip Runner Protocol (PRP)
events and reducer state only. No surface may derive state from third-party
component message types, and no surface may show a control the upstream
capability set does not support.

## 0. Shell and information architecture

Extend the existing devtools browser app (`devtools/browser/`) with a new
**Live console** mode next to the existing Replay–3 modes. Do not build a
second app shell. Reuse the existing token layer in `src/styles.css` and the
existing `ui-*` primitives.

Layout (desktop ≥ 64rem):

- **Left rail (fixed, ~17rem):** demo-chat manifest list, session/connection
  status block, goal banner, parent/child lineage tree.
- **Center column (fluid, max ~48rem):** chat transcript + composer. This is
  the primary surface; it gets the widest column and the strongest visual
  hierarchy.
- **Right rail (collapsible, ~24rem):** protocol inspector. Closed by default
  on first load; its toggle lives in the header. State persists per session in
  `localStorage` (UI preference only — never protocol state).

Layout (mobile < 64rem): single column. Transcript + composer first; manifest
picker, goal banner, lineage, and inspector become stacked collapsible sections
behind a segmented control (`Chat · Session · Inspector`). Composer stays
docked to the bottom of the viewport in the Chat segment.

Density: this is a diagnostic console — lean dense (Doherty: prioritize
feedback latency over decoration). All spacing from the existing scale.

## 1. Transcript and composer

**Source of truth:** the reducer timeline (`SessionSnapshot.timeline` /
`SessionItemSnapshot`), fed by `item.started` / `item.delta` /
`item.completed` / `item.failed` and turn lifecycle events.

Transcript rules:

1. Items render in reducer order. Never reorder client-side; the reducer's
   sequence is authoritative (protocol authority rule).
2. Item roles: `user`, `assistant`, `reasoning`, `tool`, `system/diagnostic`.
   User items align right with a filled surface; everything else aligns left
   full-width. Reasoning and tool items render collapsed by default with a
   one-line summary (Progressive Disclosure); assistant text renders expanded.
3. Streaming: an in-flight item (`item.started` + deltas, no terminal event)
   shows a streaming affordance (pulsing cursor block, `--motion-fast`
   respecting `prefers-reduced-motion`). Text appends without layout jumps.
4. Auto-follow: transcript sticks to bottom while the user is at bottom. Any
   upward scroll disengages following and shows a **"Jump to latest"** pill
   (fixed above the composer) with unseen-item count. Clicking or pressing
   `End` re-engages. Never yank scroll position while disengaged.
5. Failed items (`item.failed`) render in place with a danger surface and the
   exact diagnostic string — no toast-only errors; failures are part of the
   record (Visibility of System Status).
6. Empty state: before any session, the transcript shows the manifest picker
   inline ("Pick a demo chat or start a blank session") — not a bare void.

Composer states (one state machine, one visible primary action):

| State | Trigger | Primary action | Notes |
|---|---|---|---|
| `idle` | no active turn | **Send** (`turn.submitted`) | textarea enabled |
| `submitting` | send clicked, no `turn.accepted` yet | disabled, spinner in button | keep text visible |
| `active-turn` | `turn.started` for my turn | **Steer** (see §2) + **Stop** icon-button | composer relabels; input stays enabled for steering |
| `interrupting` | stop clicked | both disabled, "Stopping…" | see §3 |
| `disconnected` | transport lost | disabled + reconnect banner | see §7 |
| `terminal` | `session.closed`/`session.failed` | disabled + replay affordance | see §7 |

Composer behavior: `Enter` submits, `Shift+Enter` inserts newline. Textarea
auto-grows to 8 lines, then scrolls. The active state is announced via a
visually-hidden `aria-live="polite"` status line ("Turn running", "Steering
sent", "Turn stopped").

## 2. Steering: acknowledgement and stale-turn rejection

While a turn is active the composer's primary action is **Steer** and sends
`turn/steer` with `expectedTurnId` bound at submit time.

1. **Optimistic pending, explicit ack.** On send, append a local "steering"
   chip to the transcript in a `pending` visual state (muted, spinner).
   Promote it to `acknowledged` (solid, check) only on driver acknowledgement.
   Never silently merge steering text into the user-message stream before ack.
2. **Stale-turn rejection is a first-class outcome, not an error toast.** If
   the turn completed/failed/was interrupted between typing and send, the
   driver rejects on `expectedTurnId` mismatch. The chip flips to `rejected —
   turn already ended`, with the composed text preserved in an inline
   **"Send as new message"** action (Forgiveness: one keystroke recovers the
   intent; never discard typed input).
3. The pending chip must resolve to exactly one of `acknowledged`, `rejected
   (stale turn)`, or `failed (diagnostic)` — no indefinite pending. If the
   transport drops mid-steer, resolve to `failed` with the reconnect banner.
4. `aria-live="polite"` announces ack/rejection with the same copy as the
   visual chip.

## 3. Interruption: three races, no session replacement

Stop is a distinct destructive-adjacent action: icon button with `Stop`
label, danger-tinted only while `active`, never adjacent enough to Send to
misclick (Fitts: minimum 2.75rem target, `--space-3` gap).

Race matrix (all three must be visually distinguishable — spec test contract):

| Race | UI before | UI after |
|---|---|---|
| interrupt **before start** (`turn.submitted`, no `turn.started`) | composer `submitting` | pending turn card resolves to `turn.cancelled` state: "Cancelled before start" |
| interrupt **during generation** | streaming assistant item | stream stops in place; item keeps partial text with an "interrupted" divider; `turn.interrupted` badge on the turn group |
| interrupt **during tool** | tool item running | tool item resolves to interrupted state with its last known status; no fabricated tool result |

Rules:

1. Stop → `interrupting` state ("Stopping…", both actions disabled) until the
   terminal turn event arrives. If the driver reports interrupt unsupported,
   show the exact diagnostic and re-enable — never kill or replace the session
   (spec: "without silently replacing the session").
2. Partial output is preserved and labeled; never blank an interrupted item
   (the partial record is the point of a tracer).
3. After `turn.interrupted`, composer returns to `idle` — resume is just a new
   send. The turn group shows its terminal badge permanently.

## 4. Runtime request cards (command / file-change / permission / tool / user-input)

**Source of truth:** `runtime_request.created` / `.resolved` / `.expired` /
`.cancelled` plus `SessionRequestSnapshot` (`requestId`, `requestKind`,
`type`, `status`, `prompt`). Action availability comes from the upstream
request contract per request — the card renders only the actions the request
offers (never invent "approve for session" if the request does not offer it).

Placement: inline in the transcript at timeline position, plus a compact
"pending requests" counter chip in the session status block that scrolls to
the oldest pending card. A pending blocking request also pins a slim banner
above the composer ("1 request waiting — Review") because the turn cannot
proceed (Zeigarnik: make the open loop visible where the user is looking).

Card anatomy (one component, five kinds):

- Kind icon + kind label (`Command`, `File change`, `Permission`, `Tool`,
  `Input`) + requestId (mono, truncated, full value in tooltip/inspector).
- Prompt/body: exact upstream prompt text. Command and file-change payloads
  render in a mono block (command line, file diff summary) — never paraphrase.
- Action row, in this order when offered: **Approve** (primary),
  **Approve for session** (secondary, only when upstream offers it),
  **Reject** (quiet danger), **Cancel** (ghost, only when upstream allows
  requester-side cancel). User-input kind renders a text field + **Submit**
  instead of approve/reject.
- Resolution states: `pending` (accent left-border), `resolved — <outcome>`
  (success surface, chosen action named, actor + time), `expired` (muted,
  "expired before response"), `cancelled` (muted). Resolved cards collapse to
  a single summary line, expandable (transcript stays scannable).

Rules:

1. **Single-response guarantee in the UI:** on first click, disable the whole
   action row and show a resolving spinner; the card resolves only on the
   `runtime_request.resolved` event, not optimistically. A late duplicate
   click therefore cannot double-respond (mirrors the driver's no-double-
   response contract).
2. A request resolved elsewhere (driver timeout, upstream cancel) must update
   the card in place with the true outcome.
3. Keyboard: cards are focusable list items; action row is reachable by `Tab`;
   see §10 for the full contract.

## 5. Goal capability states (set / view / pause / resume / clear)

**Source of truth:** capability negotiation from the app-server (per spec
§29.1.5), surfaced through the driver's capability snapshot. Goal state
changes arrive as canonical events; the banner derives from reducer state.

Surfaces:

- **Durable goal banner** in the left rail (and Session segment on mobile):
  shows active goal text, state (`active`/`paused`), and last transition time.
  Hidden entirely when no goal has ever been set this session; shows a quiet
  "No goal set" row once goal capability is confirmed supported.
- **Goal menu** (not a fuzzy palette — five fixed operations, Hick's law):
  a menu button `Goal ▾` in the session status block opening a menu with
  `Set goal…`, `View`, `Pause`, `Resume`, `Clear`. `Set goal…` opens a small
  dialog with one textarea. `View` focuses/expands the banner. Operations
  invalid in the current goal state (e.g. `Resume` while active) are disabled
  with the reason in a tooltip and `aria-disabled` + description.

Capability gating (spec-critical):

1. If the installed app-server does not advertise goal support, the whole menu
   renders disabled with the **exact diagnostic** from capability negotiation
   (e.g. `Goal operations unsupported: app-server 0.132.0 does not advertise
   goals capability`) — copied verbatim into tooltip and inspector. Never hide
   the control silently (discoverability of the gap is a deliverable) and
   never fabricate a client-side goal.
2. Partial support (some verbs missing) disables only the missing verbs, same
   exact-diagnostic rule per verb.
3. Every goal mutation is also a transcript/system event ("Goal paused") so
   replay shows the same history.

## 6. Parent/child lineage and subagent activity

**Source of truth:** upstream thread identities (parent/child thread lineage
from the driver; `normalizedSessionId` / thread ids). No client-side
inference.

- Left-rail **lineage tree**: root session plus child threads, each row =
  name/id (mono, truncated) + live state dot (`starting`, `running`,
  `terminal-ok`, `terminal-failed`) + last-activity relative time. The row for
  the currently viewed thread is marked with `aria-current="true"`.
- Selecting a child switches the center transcript to that child's timeline
  (read-only if the driver does not support steering children). Breadcrumb at
  the transcript top: `root ▸ child-a` for orientation (Jakob: matches file
  tree/thread conventions).
- **Unsupported child steering renders as an explicit disabled composer** with
  the exact diagnostic ("Direct steering of child threads is not supported by
  this app-server"), not an absent composer and not an emulated one (spec:
  "shown as unsupported rather than emulated").
- Child terminal states persist in the tree (terminal dot + badge); activity
  is history, not just presence.

## 7. Reconnect, refresh, resume, replay

**Source of truth:** transport status + `session.resuming` / `session.resumed`
/ `session.reconciled` / `runner.reconnected` events and reducer cursor state.

1. **Connection status** lives in the session status block: `connected`,
   `reconnecting (attempt n)`, `disconnected`, with the socket/cursor detail
   in the inspector. State changes announce via `aria-live="polite"`.
2. **Transport drop:** banner above composer ("Connection lost — reconnecting…
   / Retry now"). Composer disabled while disconnected (§1). On resume, the
   reducer replays from the durable cursor; the transcript must end
   byte-identical to a never-disconnected session (live/replay parity is a
   test contract, and the UI must not maintain shadow state that could
   diverge).
3. **Page refresh:** reload restores the same normalized session and renders
   the full replayed transcript, then continues live. A subtle divider marks
   "replayed to here" for diagnostic honesty; it disappears on the next live
   event group.
4. **Replay mode:** a terminal session offers **Replay** (from the manifest
   list or terminal banner): re-runs the recorded canonical events through the
   reducer with a stepper (play/pause, step, position slider). Replay is
   visually distinguished by an eyebrow badge `REPLAY` in the header — never
   let replay be mistakable for live (trust).
5. Never offer "start new session" as the recovery path for a drop — resume
   the exact session (Codex rule: never replace a lost session).

## 8. Protocol inspector

**Source of truth:** the raw upstream method/event names and the canonical
event stream, side by side. The inspector is the debugging surface; the
transcript stays clean (Tesler: complexity lives here, deliberately).

Right-rail panel with four tabs:

- **Events:** virtualized list, one row per canonical event — `seq`,
  `eventType`, turn/item id (mono). Row expands to the full canonical payload
  and, when present, the raw upstream method/notification that produced it
  (`debug` channel). Filter box (plain substring) + eventType facet chips.
  Clicking a transcript item highlights its events and vice versa
  (Uniform Connectedness across panels).
- **Requests:** pending + resolved runtime requests with full lifecycle
  timestamps; row links to the transcript card.
- **Capabilities:** negotiated capability/version table (steer, interrupt,
  goals, child threads, usage…), each row `supported / unsupported —
  <exact diagnostic>`. This is the authoritative view backing every disabled
  control in §5/§6.
- **Session:** identities (runId, normalizedSessionId, thread ids,
  sourceInstanceId), sequence/cursor state, gap detection status, usage
  counters, connection history.

Rules: monospace for identifiers and payloads; copy-to-clipboard per row;
**redaction is upstream's job but the inspector must render redaction markers
verbatim and never attempt client-side un-redaction or pretty-printing that
could reconstruct secrets**. No credential ever reaches the browser (spec
security rule), so the inspector renders only what the demo server sends.

## 9. Demo-chat manifests

**Source of truth:** deterministic manifest files shipped with the package
(one per spec scenario: completion, steering, interruption/resume, approvals,
user input, subagents, goals, reconnect, replay).

- Manifest list in the left rail: name, one-line purpose, scenario badges,
  and an **expected observations** disclosure listing exactly what the runner
  should show (from the manifest, not hand-written in the UI).
- Running a manifest pins a compact **observation checklist** panel the user
  can tick off manually (recognition over recall — the human checkpoint
  script is embedded in the UI, not in a separate doc).
- **Reset control** per manifest and a global "Reset demo state": resets
  demo-server state and clears the local session, with a confirm dialog
  naming exactly what is destroyed ("Discards the current live session
  transcript. Recorded evidence files are not touched.").
- Manifests must be runnable in any order; the list shows last-run outcome
  per manifest (`passed observations`, `not run`, `interrupted`).

## 10. Keyboard and accessibility acceptance criteria

These are the testable ACs for the component/keyboard/a11y checks required by
the spec evidence list. Implementation must satisfy every row; QA verifies
each with keyboard-only and screen-reader passes.

**Keyboard**

- K1. Every interactive control is reachable and operable with `Tab`/
  `Shift+Tab`/`Enter`/`Space` alone; no keyboard trap anywhere, including
  dialogs and the inspector.
- K2. Composer: `Enter` sends (or steers when a turn is active),
  `Shift+Enter` newline. `Escape` while a turn is active moves focus to the
  Stop button (it must never interrupt directly — destructive actions require
  explicit activation).
- K3. Request cards: card list is an `role="list"`; each card's actions are
  reachable in visual order; the oldest pending card is focusable via the
  pending-requests banner (`Enter` on banner focuses it).
- K4. Goal menu: standard menu-button pattern (`Enter`/`Space`/`ArrowDown`
  opens, arrows navigate, `Escape` closes, focus returns to trigger).
- K5. Lineage tree: `role="tree"` arrow-key navigation; `Enter` selects a
  thread; selection is announced.
- K6. Transcript: `End` jumps to latest and re-engages follow; `Home` jumps
  to first item; transcript region is a labeled `role="log"` landmark.
- K7. Inspector tabs: standard tabs pattern (arrow keys switch, `Tab` enters
  panel); event rows expand/collapse with `Enter`.
- K8. Replay stepper: `Space` play/pause, `ArrowLeft`/`ArrowRight` step,
  slider operable by arrows with value announced.
- K9. Visible focus indicator (`--ring`, ≥2px, ≥3:1 contrast against both
  adjacent colors) on every focusable element; focus order matches visual
  order.

**Screen reader / semantics**

- A1. Transcript is `role="log"` with `aria-live="polite"`; streaming deltas
  do **not** announce per-token — announce on item completion and on state
  transitions only (avoid SR flooding).
- A2. Turn/steer/interrupt/connection/goal state changes each produce exactly
  one polite announcement with the same copy as the visible state.
- A3. A pending blocking request announces assertively once
  (`aria-live="assertive"` on the banner), then stays quiet.
- A4. Every state conveyed by color (status dots, card borders, badges) has a
  text or icon equivalent (WCAG 1.4.1 color-independence).
- A5. Disabled capability controls expose the exact diagnostic via
  `aria-describedby`, not only a hover tooltip.
- A6. Dialogs (`Set goal…`, reset confirm) are proper modal dialogs: labeled,
  focus moved in, trapped, restored on close.
- A7. All identifiers/payload blocks are in `<code>`/`<pre>` semantics; copy
  buttons are labeled with what they copy ("Copy event 42 payload").

**Visual/WCAG**

- V1. Text contrast ≥ 4.5:1 (normal) / 3:1 (large); non-text UI ≥ 3:1 —
  verify the token pairs used by new surfaces (notably `--muted-foreground`
  on `--muted` and status-on-surface pairs).
- V2. Pointer targets ≥ 2.75rem (44px) on mobile breakpoints; Stop and Send
  separated by ≥ `--space-3`.
- V3. `prefers-reduced-motion` disables streaming pulse, auto-scroll
  smoothing, and skeleton shimmer (fall back to instant updates + static
  placeholders).
- V4. Layout holds at 320px width and 200% zoom without horizontal scroll of
  the transcript (WCAG 1.4.10 reflow); the inspector may scroll internally.
- V5. Both viewports in evidence: 1440×900 and 390×844 screenshots for every
  major state (QA gate).

## 11. UX acceptance criteria for the implementation handoff

1. All surfaces derive from canonical events/reducer snapshots; grep-level
   check: no import from any AI SDK, and adapted component files contain no
   third-party message-type imports (see decision record).
2. Every state named in §1–§9 is reachable via the demo manifests, and each
   has a distinct, labeled visual state (no two states share identical UI).
3. All K/A/V criteria in §10 pass keyboard-only and screen-reader passes.
4. Unsupported capabilities render exact diagnostics (§5, §6, §8-Capabilities)
   — zero fabricated controls, zero silently hidden controls.
5. Token compliance: no raw color/spacing/radius/type values in new component
   files; everything through `src/styles.css` custom properties (extend the
   token set via PR if a needed token is missing — see decision record §5).
6. Screenshots at both evidence viewports for: idle+empty, streaming turn,
   steering ack + stale rejection, all three interrupt races, each request
   kind (pending/resolved/expired), goal supported+unsupported, lineage with
   an active child, reconnect banner + replayed divider, replay mode,
   inspector (Events + Capabilities tabs), and one full mobile pass.
