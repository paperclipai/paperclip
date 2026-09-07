# Scenario chat Interaction Map — Mobile Chat with Visible Mock Activity

Status: **approved UX contract**, implemented in TASK-16916 (2026-08-09).
Deviations taken during implementation are recorded in §11a; the §11 matrix is
kept as an acceptance contract; the recorded screenshot campaign is deferred.
Owner: UXDesigner. Implementer: 7I implementation (TASK-16916), consuming the
existing 7C mock adapter, 7D semantic catalog, and 7F explorer components.
Companion records: [Capability interaction map](capability-scenario-explorer-ux.md)
(the 7F contract — everything not overridden here is inherited verbatim),
[Live console interaction map](live-console-interaction-map.md) (chat console
baseline), [SDK component decisions](sdk-component-decisions.md).
(annotated desktop + mobile renders in `.paperclip-local/evidence/capability/`,
`scenario-chat-*` slugs).

Scenario chat adds a **Codex-style interactive chat** over the same package-local
Capability runner and mock `ControlPlanePort`. The board opens a scenario, chats
with the agent, and — this is the point of the phase — **sees the mock
Paperclip activity for every turn** instead of having it hidden behind chat.
The 7F explorer remains unchanged as the corpus-review surface; the chat is a
sibling surface in the same app shell, one React tree, sharing the picker,
transcript grammar, inspector components, and token layer.

The 7F authority rule is binding here too: the chat UI renders records the
runtime produced. It computes no exposure, evaluates no claim, applies no
redaction, holds no credential, and never re-times or reorders the artifact
stream.

## 0. Naming, vocabulary, and the turn model

- Surface name in the UI: **Scenario chat** (header: “Capability scenario chat —
  mock control plane”).
- All 7F §0 vocabulary carries over exactly: **task** in copy; machine values
  (case IDs, `MCK-102`, grants, JSON) verbatim in `--pcr-font-mono`;
  disposition labels **Control plane / Always tool / Optional tool**; parity
  statuses **Pass / Fail / Intentional gap / Not run** always icon + text.
- A **turn** is one user message and everything the runtime records until the
  agent settles (model output, semantic calls/results, authorization
  decisions, control-plane actions, state changes, reconciliation events,
  and the turn parity verdict). Turns are numbered from 1 in artifact order.
- **Session start** is turn 0: the control-plane-owned seeding record (wake
  payload, checkout, initial tool exposure) that exists before any user
  input. It renders with full control-plane styling — the demo must show
  that work happened with no agent tool before the first message.

## 1. Shell and information architecture

Same Vite entry, same app shell as 7F (`examples/scenario-explorer/`), new
routes under `#/chat/…` (§9). No second app, no second token sheet.

Desktop (≥ 64rem), three regions, one React tree:

- **Left rail (`--pcr-rail-width`, 17rem):** the existing 7F scenario picker,
  reused as-is (search, facets, grouped case list). Selecting a case in chat
  context seeds a chat session for that scenario instead of a fake run.
- **Center column (fluid, max `--pcr-center-width`, 48rem):** the **chat** —
  session header, conversation, and composer. Primary surface, strongest
  hierarchy. The composer is pinned to the bottom of the column.
- **Right rail (26rem, proposed token `--pcr-activity-width`):** the
  **Activity stream** — the ordered per-turn evidence (§4). Open by default
  on desktop; it carries the acceptance evidence, so it is never a
  collapsed-by-default drawer on desktop.

Mobile (< 64rem): single column behind the established segmented control
pattern (a `radiogroup`, per 7F revision 4), with exactly two segments:
**Chat · Activity**. The segmented control is sticky at the top; the
composer is sticky at the bottom of the Chat segment (thumb zone). The
Activity segment contains the complete §4 stream as stacked cards — mobile
gets **all** the evidence, never a summary-only view. A count chip on the
Activity segment surfaces attention states without opening it
(“Activity · 1 deny”).

Density: diagnostic-console dense. All values from `--pcr-*` tokens only
(`DESIGN.md` principles 2–4); the two 7F token-layer overrides (badge
min-width / text-transform, 7F revision 5) apply to the chat surface too.

## 2. Session header, scenario selection, reset and replay

The session header replaces the 7F run header on chat routes:

- **Row 1:** case ID (mono) + title, group badge, disposition badge.
- **Row 2 — session status chip**, exactly one of:
  - **Live · Codex (bounded)** (accent surface) — a real model is connected
    through the server-side relay;
  - **Replay · deterministic** (muted surface) — the scripted session is
    playing or played;
  - **Idle** (muted) — seeded, no turns yet.
- **Row 3 — controls:** mode segmented control (`Replay (scripted)` default /
  `Codex (bounded)` when the relay is reachable — same availability and
  disabled-reason rules as 7F §3.1), **Reset session**, and **Replay**
  (re-runs the recorded session deterministically). Reset is a destructive
  affordance: it clears the session back to the seeded turn-0 state and asks
  for confirmation via the SDK `Dialog` (“Reset this session? The transcript
  and mock state return to the seeded scenario.” — Forgiveness). Replay
  needs no confirmation; it reproduces the identical timeline (7F
  determinism contract).
- **Parity-so-far chip:** “Parity · 2 turns pass” (success) or
  “Parity · turn 2 fail” (danger), deep-linking the newest parity entry in
  the Activity stream.

Scenario switching mid-session prompts the same reset confirmation (the mock
core is seeded per scenario; two scenarios never share mutable state).

## 3. Chat transcript

The conversation composes the frozen SDK chat kit: `conversation`,
`message`, `tool-item`, `reasoning-item`, `Composer`. Three actors render
with three distinct visual grammars (Similarity + Common Region — a stranger
must attribute any row to its actor in two seconds):

1. **User turns** — right-aligned message bubbles on `--pcr-accent-surface`.
2. **Model output** — left-aligned message cards on `--pcr-card` with the
   standard streaming affordances (token reveal, jump-to-latest, auto-follow
   inherited verbatim from Live console §1; reduced-motion renders instantly).
   Reasoning summaries, when the driver emits them, use `reasoning-item`
   behind its existing disclosure.
3. **Agent tool work** — semantic calls render inline in the conversation as
   collapsed `tool-item` cards on `--pcr-surface-raised`: operation ID
   (mono) + disposition badge + one-phrase outcome. Expansion shows the 7D
   descriptor fields exactly as in 7F §3.2 (arguments, result, claims,
   idempotency, redaction chips). Denied calls render in place on
   `--pcr-danger-surface` with the typed denial (operation, missing claim,
   reason) — never toast-only, never any protected state.
4. **Control-plane work** — full-width strips on `--pcr-muted` with the
   “Control plane” badge and the 7F gutter glyph, copy naming the actor
   plainly (“Control plane registered the interaction and scheduled the
   continuation wake — no agent tool exists for this.”). Turn 0 seeding uses
   this grammar.

**Turn activity strip (new, binding):** after each completed turn the
conversation appends a full-width summary strip for that turn:
`Turn 2 activity · 3 tools · 1 denied · 2 control plane · diff 2 domains ·
parity ✓`, rendered as a single button. Counts are icon + text, never color
alone. Activation opens that turn’s group in the Activity stream (desktop:
scroll + flash the group, same connect cue as 7F authorization rows;
mobile: switch to the Activity segment anchored at the group, with a
“Back to chat” affordance that restores scroll position). The strip is the
guaranteed per-turn bridge — evidence is reachable from the turn itself,
not only by scanning the rail (Recognition over Recall).

The composer is the SDK `Composer` with its existing state machine —
`idle / submitting / active-turn (Steer) / interrupting / disconnected /
terminal` — and keyboard contract (Enter sends, Shift+Enter newline, Escape
moves focus to Stop during a turn). In Replay mode the composer renders
`disconnected`-style with the reason “Scripted replay — switch to Codex
(bounded) to chat live” and the Replay control adjacent; free-text input is
a live-driver capability, not a replay capability.

## 4. Activity stream (per-turn evidence)

**Source of truth:** the ordered run artifact timeline plus per-turn
records (§10 data contract). The stream is grouped by turn; groups render
newest-last and auto-follow the conversation. Each **turn group** is a
collapsible section headed by `Turn N` + the same counts as the turn strip;
the newest turn group is expanded by default, earlier groups collapse to
their header (progressive disclosure; Miller — never all turns fully open).
Inside a group, ordered sections, each rendered only when non-empty, always
in this order:

1. **Exposed tools** — the turn’s exposure record: Always (N) / Optional (N,
   each with its unlocking grant) / Control plane — no tool (N), reusing the
   7F `ExposureList`. Collapsed to counts by default; the acceptance-critical
   full list is one disclosure away.
2. **Calls and results** — one row per semantic call: operation (mono),
   disposition badge, outcome; expansion identical to the inline tool card.
   Rows and their inline conversation twins highlight each other on
   selection (uniform connectedness).
3. **Authorization** — the turn’s slice of the 7F `AuthorizationTable`:
   decision (Allow/Deny, icon + text), claims considered, reason,
   redactions; denied rows on `--pcr-danger-surface`.
4. **Control plane** — the turn’s control-plane actions with their decision
   records (inputs considered, resulting state change, audit reference).
5. **State diff** — the 7F `StateDiff` scoped to the turn: per-domain change
   summaries, unchanged domains as one muted row, `field: before → after`
   in mono. Wake/reconciliation events (continuation scheduling, blocker
   resolution, terminal reconciliation) render here as rows in their
   domains, badged “Control plane”.
6. **Parity** — the turn verdict row (icon + text + assertion counts),
   expanding to the 7F `ParityPanel` assertion rows for that turn. The
   session-level verdict lives in the session footer group.

The stream ends with a **Session** group: cumulative diff against the seed,
session parity verdict, and the restraint note when the correct behavior was
absence (“No further operations — N forbidden operations, none invoked”,
7F §3.2 rule carried over).

A filter chip row at the top of the stream (`All · Tools · Authorization ·
Control plane · Diffs · Parity`) narrows sections across all turns;
filtering never deletes groups, it collapses non-matching sections (the
turn skeleton stays scannable). Filter state is view state, mirrored to the
route (§9), never protocol state.

## 5. Actor distinction (binding summary)

| Actor | Surface | Marker |
| --- | --- | --- |
| User | `--pcr-accent-surface` bubble, right-aligned | — |
| Model output | `--pcr-card` message card, left-aligned | streaming caret |
| Agent tool work | `--pcr-surface-raised` collapsed card, conversation-indented | mono operation + disposition badge |
| Control plane | `--pcr-muted` full-width strip | “Control plane” badge + gutter glyph |
| Denied (any) | `--pcr-danger-surface` in place | Deny icon + text |

No view — chat, activity, expanded detail — may render a fact without its
actor attribution. If a record ever lacks attribution, that is a 7C artifact
defect to fix upstream, not a UI guess.

## 6. Credentials, redaction, denial

7F §5 applies verbatim (including revision 11: redaction chips render
`••• redacted <rule>` inline, no tooltip-only disclosure). Additionally for
chat: the composer submits user text to the package-local runner only; in
Codex mode the provider credential stays server-side behind the same relay
boundary proven in SDK, and no user-typed text is ever written to
`localStorage` (a page reload may drop an unsent draft; that is the accepted
trade against persisting conversation content).

## 7. States that must be designed, not defaulted

| State | Surface | Rendering |
| --- | --- | --- |
| No scenario selected | Chat + activity | Intro card (corpus stats + “Pick a scenario to start chatting” + three example deep links); activity rail shows the 7F corpus summary. No dead panels. |
| Seeded, no turns | Chat | Turn-0 control-plane strips render immediately (checkout, exposure); composer focused and ready in Codex mode; primed hint in Replay mode (“Replay the scripted session, or switch to Codex (bounded)”). |
| Turn streaming | All | Model card streams; composer in `active-turn` (Steer + Stop); the pending turn’s activity group shows a live-updating header (“Turn 3 · running”); controls that would corrupt the run (Reset, Replay, mode switch, scenario switch) disable with reasons. |
| Turn failed (harness/driver error) | Chat | Danger strip in place with the exact diagnostic and a “Retry turn” affordance; the partial activity group stays visible and is labeled partial. Never silently reset. |
| Denied operation | Chat + activity | §3/§4 danger rendering; the Activity segment chip counts denials. |
| Relay unavailable | Session header + composer | Codex option disabled with reason; Replay mode fully usable; composer disabled-reason names the relay, not a generic error. |
| Session terminal | Composer | `terminal` state with its existing hint (“This session is closed. Replay it or reset the session state.”). |
| Reset confirm | Dialog | §2; focus returns to the composer after either outcome. |
| Long JSON / long code / long unbroken strings | Everywhere | `overflow-wrap: anywhere` on prose and key-value values; `pre` blocks may scroll **internally** (x) with a visible affordance, but the page never scrolls horizontally at any viewport ≥ 320px — the 7F `min-w-0` discipline is a hard gate at 390×844. |
| Unknown case ID in route | Chat | The 7F named error card (“No scenario named …”) — not a silent home fallback (closes 7F revision 10’s accepted gap for chat routes). |

## 8. Touch, keyboard, focus, accessibility

- Touch targets ≥ `--pcr-touch-target` (2.75rem) for segments, turn strips,
  group headers, filter chips, composer buttons.
- Landmarks: `nav` (picker), `main` (chat), `complementary` (activity);
  one `h1`; `F6` / `Control+Period` region cycling and the skip link carry
  over from 7F (revision 13) with the activity rail as the third region.
- Composer keyboard contract per §3; the turn strip and group headers are
  real `button`s; the mobile segment switch preserves and restores scroll
  position per segment.
- Focus order on a completed turn: model card → inline tool cards → turn
  strip → composer. After “Back to chat”, focus returns to the originating
  turn strip.
- Live regions: turn settle announces politely (“Turn 2 settled — 1 denied
  operation, parity pass”); a denial announces assertively once, when it
  lands (upgrading 7F revision 10’s interim).
- Streaming, flash cues, and auto-follow honor `prefers-reduced-motion`
  (instant/static variants, SDK rule). Contrast from existing token
  pairs; every status icon + text.

## 9. Routes and determinism

Hash routing, extending the 7F scheme:

```
#/chat                                   chat home (picker + intro)
#/chat/<case-id>                         live session, seeded (turn 0)
#/chat/<case-id>?replay=fake             deterministic scripted session, auto-played
#/chat/<case-id>?replay=fake&view=<chat|activity>&turn=<n>
#/chat/<case-id>?replay=fake&filter=<tools|authorization|control|diff|parity>
```

- `replay=fake` auto-plays the scripted session to completion; when the
  conversation and all activity groups are settled the shell sets
  `data-chat-state="settled"` (Playwright wait target; `pending` until then).
  Fixture time only, no wall-clock values, pixel-identical across loads at
  the same viewport — the 7F determinism contract applies unchanged.
- `view=activity` selects the Activity segment on mobile and scrolls the
  rail on desktop; `turn=<n>` anchors that turn’s group and expands it.
- Live chat routes (`#/chat/<case-id>` without `replay`) are the primary
  board experience and are exempt from pixel determinism; QA acceptance of
  live behavior uses the scripted routes plus one real Codex turn.
- Stable `data-testid`s (minimum new set): `chat-shell`, `session-header`,
  `session-status`, `chat-conversation`, `chat-turn-<n>`,
  `turn-activity-strip-<n>`, `activity-stream`, `activity-turn-<n>`,
  `activity-section-<turn>-<name>`, `activity-filter-<name>`, `composer`,
  `reset-session`, `replay-session`, `segment-chat`, `segment-activity`.
  7F testids keep their meanings.

## 10. Package-local implementation guidance (7I)

- **Reuse first.** The chat column composes the SDK chat kit
  (`conversation`, `message`, `tool-item`, `reasoning-item`, `Composer`,
  `Dialog`, `Badge`, `Banner`) — `RunnerConsoleApp` itself is *not* the
  shell (same 7F ruling: compose parts, don’t adopt the console’s
  session-timeline IA). The activity stream composes the existing explorer
  components: `ExposureList`, `AuthorizationTable`, `StateDiff`,
  `ParityPanel`, `ChannelEntry`, `RedactionChip`.
- **New explorer-local components** (one job each): `SessionHeader`,
  `TurnStrip` (the per-turn summary button), `ActivityStream` (turn
  grouping + filter chips), `ActivityTurnGroup`. Tokens only; the two
  candidate new tokens (`--pcr-activity-width: 26rem`,
  `--pcr-touch-target` if not yet minted) are proposed as token additions
  in the 7I PR, never inlined.
- **Data contract extension (owned by the runtime, not the UI):** timeline
  entries gain a `turn` number (0 = session seed); the artifact gains
  `turns[]` with per-turn `exposure`, `authorizationRecords`, `diff`,
  `reconciliationEvents`, and `parity`, each shaped exactly like their
  session-level 7F counterparts. A `user_message` timeline kind joins the
  existing five kinds. The session-level records remain and feed the
  Session group. The UI must not derive turn boundaries, per-turn diffs, or
  per-turn verdicts itself — if the runtime can’t supply a per-turn record,
  extend the runtime.
- **Driver seam:** Replay mode consumes recorded fixtures; Codex mode uses
  the bounded driver through the SDK relay. The chat UI is
  driver-agnostic — it renders whatever the artifact stream says happened.
- **Testing hooks 7I must ship:** component tests for `TurnStrip`,
  `ActivityStream` grouping/filtering, and per-turn diff/parity rendering;
  keyboard tests (composer contract, strip→group→back-to-chat focus
  round-trip, region cycling with the new rail); the §9 route determinism
  test; a 390×844 no-horizontal-scroll assertion on a long-JSON fixture;
  reduced-motion test; screenshot capture script for §11.

## 11. Screenshot acceptance matrix

Evidence lands in `.paperclip-local/evidence/capability/` as
`scenario-chat-<slug>-<viewport>.png` at **1440×900** and **390×844**, captured
from §9 routes after `data-chat-state="settled"`. Mobile captures must show
the correct active segment and no horizontal scrollbar.

| # | Slug | Route | Expected visible evidence |
| --- | --- | --- | --- |
| 1 | `chat-home` | `#/chat` | Picker + chat intro; no dead panels. |
| 2 | `chat-session` | `#/chat/ix-checkbox-01?replay=fake` | Turn-0 control-plane strips; user/model/tool/control-plane grammars all distinguishable; turn activity strips with counts; composer in its mode-correct state; desktop shows the activity rail with the newest turn expanded. |
| 3 | `chat-denied` | `#/chat/ap-mcp-gate-01?replay=fake&view=activity&turn=2` | Denied call on danger surface in both conversation and authorization section; missing claim + reason; Activity segment chip counting the deny (mobile). |
| 4 | `chat-activity-diff` | `#/chat/ix-checkbox-01?replay=fake&view=activity&turn=3` | Turn group with exposure counts, calls, authorization, control-plane rows, per-turn state diff (changed vs unchanged domains), reconciliation/wake row, turn parity verdict. |
| 5 | `chat-streaming` | `#/chat/ap-mcp-gate-01?replay=fake&stage=streaming` | Streaming model card, composer `active-turn` (Steer/Stop), pending activity group header, disabled session controls with reasons. Exempt from pixel determinism; capture once per viewport. |

The scripted fixtures for `ix-checkbox-01` and `ap-mcp-gate-01` chat
sessions are new 7I fixtures (the 7F fake-agent plans are single-shot, not
conversational); they must script at least two user turns each so turn
grouping is actually exercised.

Acceptance procedure: UXDesigner reviews all ten images against this matrix
before 7I implementation is accepted; deviations are fixed or recorded as
revisions in this document — silent divergence fails the gate (7F §9 rule).

## 11a. Revisions recorded during 7I implementation (TASK-16916)

Silent divergence fails the §11 gate, so every deviation the implementation
made from §1–§11 is recorded here rather than left for a reviewer to discover.

1. **Mode names: `Scripted (deterministic)` / `Codex (bounded)`, and the
   composer stays usable in scripted mode.** §3 said replay mode renders the
   composer `disconnected` because "free-text input is a live-driver
   capability". With the provider relay unavailable in the package-local demo
   (the same 7F §3.1 condition), that rule would have made the phase's own
   acceptance — "a user can complete successful and denied mock Paperclip
   interactions from chat" — unreachable. Scripted mode therefore accepts a
   prompt and drives the next recorded turn against the live mock core, and the
   composer note says exactly that, with the number of scripted turns left. The
   board is never told a model wrote the reply.
2. **`replay=fake` plays once per session, not per route.** An explicit
   **Reset session** on a `replay=fake` route returns to the seeded turn 0 and
   stays there; the route's auto-play applies to the first session only.
   Otherwise reset would be undone in the same frame by the route replaying,
   which is the opposite of what §2 promises.
3. **`stage=streaming` added to §9.** §11 shot 5 said "live route, staged".
   Staging by hand is a race, so the route parameter holds the last scripted
   turn mid-reveal and the shell reports `data-chat-state="streaming"` — a
   stable, linkable wait target. `pending` covers the mid-reveal transition.
4. **`data-chat-state` lives on the shell, not only on `chat-shell`.** On the
   mobile Activity segment the chat column is hidden, so a wait target that
   only existed inside it was unreachable exactly where the evidence is. Both
   elements now carry it.
5. **Tool cards reuse the 7F transcript disclosure rather than the SDK
   `tool-item`.** `ToolItem` requires a reducer `SessionItemSnapshot`, which a
   semantic call is not. The 7F rendering already follows the same
   `pcr-disclosure` grammar `ToolItem` itself uses, and reusing it keeps one
   description of a semantic call across both surfaces. `Message`, `Composer`,
   `Dialog`, `Badge`, and `Banner` are used as specified.
6. **Turn 0 reports `Pass`, not a blank verdict.** The seed makes exactly one
   checkable claim — control-plane work with no agent tool — and reports a
   verdict over that claim alone. Turns that did no agent work and made no
   control-plane claim report `Not run`; no turn ever reports a verdict for
   work nobody did.
7. **A third authored turn for `ix-checkbox-01`.** §11 shot 4 asks for a
   wake/reconciliation row, but the mock core schedules the continuation wake
   when an interaction is **resolved**, not when it is requested. Turn 3 is the
   board answering its own checkbox — a control-plane-owned action with no
   agent tool — which is a better demonstration of the phase's point than a
   fabricated wake would have been. Shot 4's route is therefore `turn=3`.
8. **Filtering the picker no longer clears the selected case on the chat
   surface.** Narrowing the rail must not end a live session; the explorer
   keeps its existing behaviour.
9. **Evidence captures neutralise the sticky composer.** A full-page capture
   stretches the viewport to the content height, which leaves a sticky element
   floating mid-document. Pinning is proven by a browser test that scrolls the
   transcript and asserts the composer is still on screen.

## 11b. Acceptance review rulings (TASK-16920, UXDesigner, 2026-08-09)

Review method: all ten §11 captures inspected at full resolution, plus a live
pass against `demo:scenarios` at 1440×900 and 390×844 (scripted composer driven
interactively, streaming route inspected in-DOM). Shots 1–4 are **accepted**.
Shot 5 is **rejected pending revisions 12–14 below**; only shot 5 needs
re-capture.

Rulings on §11a: revisions 1, 2, 4, 5, 6, 7, 8, and 9 are **accepted** as
recorded. Notes where the ruling needed evidence beyond the text:

- **1 (composer usable in scripted mode) — accepted.** Verified live: a
  free-text prompt drives the next recorded turn; the status chip, mode
  segment, and the persistent composer note carry the attribution. The
  exhausted state is genuinely designed: with zero scripted turns left, a
  send runs a real `get_task_context` against the mock core and the reply
  says the script is finished and how to replay — no silent drop, no faked
  answer (Forgiveness; visibility of system status).
- **3 (`stage=streaming` route) — the route and wait-target approach are
  accepted**; hand-staged captures were a race and a deterministic stage is
  the right fix. The *current staging depth* fails §7 and the shot-5 matrix
  row — see revisions 12–13.
- **7 (`turn=3`) — accepted.** The mock core wakes on interaction
  *resolution*, not request; a board-owned resolution producing the real
  `wake.scheduled` row demonstrates the phase's point without fabricating a
  wake. Shot 4's evidence confirms the reconciliation row renders in the
  turn diff, badged Control plane.

Reviewer-recorded revisions (10–11 accepted as built, 12–14 are the fixes
shot 5 is gated on):

10. **Mobile keeps three segments: Scenarios · Chat · Activity.** §1 said
    "exactly two", which was written for the session surface and forgot that
    mobile has no other path to the picker; with two segments a phone user
    could never switch scenarios. The 7F segmented-control precedent (7F
    revision 4) already includes the picker segment. §1 is amended; the
    Activity count chip behaviour is unchanged. Accepted as built.
11. **Chat-home activity rail renders a purpose hint, not the 7F corpus
    summary.** §7 asked for the corpus summary in the rail; the intro card
    already carries the corpus stats, so repeating them one column away is
    redundancy, not information (Occam). The hint card instead sets the
    rail's mental model — what will appear there once a session starts — so
    the panel is neither dead nor duplicate. §7 is amended. Accepted as
    built.
12. **Fix required — staged streaming must hold the activity stream too.**
    At `stage=streaming` the transcript is held mid-turn and the chat shows
    "Turn 2 · running", but the activity rail renders the held turn fully
    settled: calls the transcript has not shown yet, the state diff, and a
    **parity verdict** — under a header promising evidence appears "as the
    conversation happens". A surface whose whole premise is honest evidence
    must not show a verdict for a turn it says is still running (§4 source
    of truth; §7 streaming row: "the pending turn's activity group shows a
    live-updating header"). Fix: scope the `ActivityStream` to the same
    reveal ceiling the transcript uses (`chat-surface.tsx` holds the
    transcript at `holdAt` but passes the full artifact to the rail); the
    held turn's group renders the running header and only the evidence
    revealed so far — no diff, no parity, no counts that include unrevealed
    calls.
13. **Fix required — the staged hold must leave a model card visibly
    mid-reveal.** The §11 shot-5 row's first expected item is "streaming
    model card"; the current hold point (`firstSequence + 2`) lands on tool
    entries for `ap-mcp-gate-01`, so the only caret on screen is the
    pending-turn strip's. Choose the hold so a model-output entry is
    partially revealed (caret + partial text on a `--pcr-card` message
    card), or stage against a turn whose early entries include model
    output.
14. **Fix required — disabled session controls need visible reasons.**
    During a running turn, Reset/Replay disable with the reason only in
    `title` — invisible in evidence, unreachable on touch, unannounced by
    screen readers (§7 says "disable with reasons"; same rule that banned
    tooltip-only redaction disclosure in 7F revision 11). Fix: one muted
    line adjacent to the controls (e.g. "Controls return when the turn
    settles."), wired via `aria-describedby`; keep the `title` if you like,
    it just can't be the only channel.

Re-acceptance: re-run deferred recorded-evidence campaign and hand back only the two
`chat-streaming` captures for review; shots 1–4 stand.

## 11c. Re-acceptance ruling (TASK-16920 closing, UXDesigner, 2026-08-09)

Shot 5 (`chat-streaming`, both viewports, re-captured in `c8422d1aaa`) is
**accepted**. Revisions 12–14 verified against the new captures and the
code:

- **12 fixed.** The activity rail now consumes the same reveal ceiling as
  the transcript (`ChatActivityStream` takes the conversation's inclusive
  timeline ceiling); the held Turn 2 group renders the running header with
  only the revealed `request_approval` call, its denial, and the one
  authorization record — no diff, no parity verdict, no settled counts.
- **13 fixed.** The hold lands on a model card mid-reveal: partial message
  text with the caret on a `--pcr-card` message card, in addition to the
  pending-turn strip.
- **14 fixed.** "Controls return when the turn settles." renders as a
  visible muted line adjacent to the controls, wired via `aria-describedby`
  on all four mid-turn-disabled controls; `title` retained as a secondary
  channel.

Reproducibility spot-check in the review run: deferred recorded-evidence campaign re-run
produced **byte-identical** `chat-streaming` PNGs at both viewports.

15. **Post-capture copy change (demo-hardening commits `0566a9f3ca`,
    `362754a633`) — accepted, evidence refreshed.** After shots 1–4 were
    recorded, the composer helper gained a synthetic-demo disclaimer
    ("Synthetic demo only. Session state is memory-only and is cleared on
    reset, expiry, or restart; do not enter confidential or regulated
    data.") and the mock-core wording changed to "isolated" /
    "package-local". Both are improvements — the disclaimer is an honest
    trust signal consistent with this surface's premise, and the wording is
    more accurate — but they made the committed shot 1–4 captures stale
    (divergence would otherwise be silent, failing §11's own rule). The
    five affected PNGs (`chat-home` desktop, `chat-session` both,
    `chat-denied` desktop, `chat-activity-diff` desktop) were re-recorded
    at review time; the disclaimer verified to wrap cleanly at 390×844 with
    no horizontal scroll.

The §11 matrix is **fully accepted**. The gate is closed.

## 12. Out of scope / rejected

- All 7F §10 rejections stand (no Tailwind/Radix, no dark mode, no markdown
  renderer, no virtualization, no parity re-judging, no live-Paperclip
  affordances).
- **No bottom-sheet drawer on mobile.** The segmented Chat · Activity
  pattern is proven, keeps one React tree, and route-mirrors; a drawer adds
  a new component and an un-linkable state for no evidence gain. Rejected
  after comparison, not by omission.
- **No hiding of activity behind a “developer mode”.** Visible mock
  activity is the phase’s purpose; there is no toggle that suppresses the
  activity stream or turn strips.
- **No per-message edit/regenerate affordances.** The mock core’s
  determinism story is session-scoped (reset/replay), not message-scoped.
- Multi-session tabs, session persistence across reloads, and export are
  out of scope for the demo.
