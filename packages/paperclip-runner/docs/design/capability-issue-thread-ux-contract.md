# Capability — Issue-Thread UX Contract

Status: **binding** for track 7G (Paperclip-style Web UI) and reviewable by tracks 7E/7K.
Source of authority: Capability plan (TASK-16897 `plan` document), Revision 3 §"Page information
architecture", §"Native issue-thread interactions", §"Live execution contract", and Revision 4
§"Final evidence eligibility". Capability vocabulary: Capability generated contract
(`generated/capability/capabilities.yaml`, `mcp-tool-map.yaml`, `eval-traceability.yaml`,
`contract-schema.json` — TASK-16939).

If a corner of this contract is underspecified, 7G comments on TASK-16940 and waits for a
revision. 7G does not diverge silently. Deviations are either fixed in the implementation or
written back into this document as an explicit revision.

---

## 0. Vocabulary (normative)

All UI copy and all implementation identifiers use the 7A terms. The UI never invents
capability language.

- **Dispositions** (closed enum): `control_plane_owned`, `always_agent_tool`,
  `optional_agent_tool`.
- **Always semantic operations** (thread-visible verbs): `get_task_context`,
  `report_progress`, `answer_status_question`, `finish_task`, `block_task`, `request_review`,
  `write_document` (+ revision reads), `request_human_input` (kinds `questions`,
  `confirmation`, `checkbox`, `suggest_tasks`, `item_verdicts`), `register_deliverable`.
- **Optional operation families**: discovery (`scoped_discovery`, `search_tasks`,
  `list_agents`, …), delegation/dependencies (`create_task`, `delegate_task`,
  `set_dependencies`, `create_blocked_task`), approvals (`request_approval`,
  `decide_approval`, …), cases, workspace runtime, routines, company skills, secrets, admin,
  escape hatch. Grants render exactly as 7A writes them (e.g. `rf:read_or_write`).
- **Mock-state kinds**: `operation_result`, `runtime_decision_record`, `active_task_context`.
- **Eval keys**: case `id` (e.g. `ix-confirmation-plan-01`), `group` (16 groups),
  `fixtureProfile` (e.g. `hb-baseline`), `browserEvidenceRecipe` (e.g. `hb/hb-context-01`),
  `expectedSemanticOperations`, `forbiddenOperations`.
- **Modes**: `live` (real Codex via real runnerd), `fake` (deterministic fake agent),
  `replay` (recorded canonical events). A surface never shows an unlabeled mode.

Human-readable labels (UI copy) for the dispositions are fixed: `Agent tool — always`,
`Agent tool — granted`, `Control plane`. The machine term appears in the debug panel and in
tooltips, never invented synonyms ("system tool", "built-in", etc. are forbidden).

## 1. Identity and mode banner (always visible)

The page must answer, at all times and on every viewport, four questions: who is the agent,
what runs it, what control plane it talks to, and whether this session is live.

1. **Three identity chips**, rendered in the issue header and never hidden by scroll
   (header is sticky):
   - `Real Codex` — cyan chip, only when the active session mode is `live`. In `fake` mode the
     chip reads `Fake agent`; in `replay` it reads `Replay`.
   - `Real runnerd` — neutral chip with a live process dot (pulse while a runnerd session is
     attached; static gray when detached). Shown in `live` mode only; `fake`/`replay` show
     `In-process runner`.
   - `Mock Paperclip` — amber chip, shown in **all** modes. Tooltip: "All issue records are
     mock. No real Paperclip API is reachable."
2. **Mode is data, not styling**: the root element carries `data-session-mode="live|fake|replay"`
   and the chips render from the server-reported session record. A session artifact with
   `mode=fake` must be visually distinguishable from `live` in every screenshot (Revision 4
   evidence eligibility).
3. **Mock identifier scheme**: mock issues use a reserved prefix that cannot be confused with
   a real company (fixture default: `MCK-<n>`, e.g. `MCK-31`). The UI never renders a
   `/PAP/...`-style link to a real control plane; mock entity links navigate inside the
   explorer only.
4. **No credential surface**: no header, panel, tooltip, error, or diff may contain a token,
   key, or `Authorization` value. Redacted fields render as `••• redacted` with the redaction
   rule name from the authorization record.

## 2. Page information architecture

### 2.1 Desktop (reference viewport 1440×900)

```
┌──────────────────────────────────────────────────────────────┬───────────────┐
│ Issue header (sticky):                                       │               │
│  MCK-31 · title · StatusBadge · PriorityIcon · assignee      │  Debug panel  │
│  [Fake agent|Real Codex] [Real runnerd] [Mock Paperclip]     │  (collapsed   │
│  run state · Scenario ▾ · Replay · Reset · Stop              │   by default; │
├──────────────────────────────────────────────────────────────┤   resizable   │
│ Thread column (centered, max-width 760px, single column):    │   320–640px)  │
│   turn groups: user message → agent activity → responses     │               │
│   comment / interaction / document / deliverable /           │               │
│   disposition cards in chronological order                   │               │
│   system notices (wakes, reconciliation) as one-line rows    │               │
├──────────────────────────────────────────────────────────────┤               │
│ Composer (pinned bottom of thread column)                    │               │
└──────────────────────────────────────────────────────────────┴───────────────┘
```

- The **thread is the primary readable surface**. Default panel state is **collapsed**; the
  user's open/width choice persists per browser (`localStorage`), and deep links may force it
  (§10). The page never leads with raw protocol events.
- Thread column measure: max-width 760px, centered in the remaining space; `text-sm` body
  scale per the Paperclip type ramp.
- Debug panel: right side, resizable 320–640px with a keyboard-operable splitter
  (`role="separator"`, `aria-valuenow`), collapse toggle in the header (`Evidence` button with
  open/closed state).
- Below 1100px viewport width the panel switches from side-by-side to an overlay sheet from
  the right (same content, same tab order), so the thread column never drops below ~600px.

### 2.2 Mobile (reference viewport 390×844)

- One column. Sticky condensed header: row 1 = `MCK-31` + StatusBadge + overflow menu `⋯`
  (Scenario, Replay, Reset inside the menu; **Stop stays outside the menu** whenever a turn is
  active). Row 2 = the three identity chips, wrapping to a second line if needed — chips never
  cause horizontal page scroll.
- A **segmented control** with exactly two segments — `Thread` and `Evidence` — sits under the
  header (pattern validated in the Scenario chat mobile review; a drawer was rejected there and
  stays rejected). Thread is default. Badge on `Evidence` shows the current turn's
  authorization-denial count when nonzero.
- Composer is fixed to the bottom of the `Thread` segment, above the keyboard inset
  (`env(safe-area-inset-bottom)`).
- **No horizontal page scroll at 390px** (`document.scrollingElement.scrollWidth <=
  clientWidth` is an automated acceptance check). `pre`/code/diff blocks wrap or scroll inside
  their own container only.
- Touch targets ≥ 44×44 CSS px for every actionable element, including chip tooltips
  (tap-to-toggle on touch), accordion headers, and interaction-card controls.

## 3. Thread item taxonomy

Every thread item renders from a **mock-core record or canonical event** — the browser holds
no state authority, computes no claim/policy/parity result, and never mutates mock state
outside an interaction response (§5). Items in chronological order, grouped by turn:

| # | Item | Source | Anatomy |
|---|------|--------|---------|
| T1 | **User message** | thread record | Right-aligned bubble style is **not** used; Paperclip comment card with author "You (board user)", timestamp, markdown body. |
| T2 | **Agent response** | model output items | Comment card, author = agent identity chip (`Fake agent` / `Real Codex`), streaming state per §6. Model prose only — never confused with durable records (see T3). |
| T3 | **Durable progress comment** | `report_progress` / `answer_status_question` `operation_result` | Distinct comment card with a `Recorded to mock thread` marker (filled corner tag + tooltip naming the semantic operation). This is the visual boundary between ephemeral model text (T2) and durable mock records. |
| T4 | **Tool activity strip** | semantic call + typed result | One line per call inside the turn group: status glyph (`✓ ok`, `✕ denied`, `⏳ running`), operation id (`write_document`), one-line human summary, `›` expander. Expanded: request args (redacted per rules), typed result, and a `View in Evidence` link that opens the debug panel pre-filtered to that call. Strips are collapsed by default; a turn shows at most 3 strips + `N more…` expander (progressive disclosure). |
| T5 | **Interaction card** | `request_human_input` record | §5. Rendered at its chronological position. |
| T6 | **Document card** | `write_document` result | Document key + title, revision chain (`r3 → r4`), author, `View diff` (opens Evidence → State), and stale marker when a later revision exists. |
| T7 | **Deliverable card** | `register_deliverable` result | File/ref name, kind (attachment bytes / external ref / workspace file), size, registered-by, download affordance for attachment-backed deliverables. |
| T8 | **Dependency / delegation card** | optional-op results (`create_task`, `set_dependencies`, …) | Created mock child issues with identifiers and blocker edges (`MCK-32 blocks MCK-31`). |
| T9 | **Disposition card** | `finish_task` / `block_task` / `request_review` result | Terminal banner card: new status via StatusBadge, explanation body, named blocker owner where applicable. After a terminal disposition the composer enters `disabled` (§6). |
| T10 | **Denial notice** | typed policy denial (`operation_result` with deny) | Inline red-bordered strip variant of T4: `✕ create_task — denied: missing grant su:read_or_write`. Shows deny reason **from the authorization record verbatim**; never leaks protected state or credentials. |
| T11 | **System notice** | `runtime_decision_record` (wake, checkout, reconciliation, budget stop, session events) | One-line, muted, icon + text (e.g. `⚙ Wake: issue_blockers_resolved → turn 3 started`). Progressive disclosure into Evidence → Control plane. Never a card; system notices must read quieter than work content. |

Turn grouping: each turn renders a hairline group header `Turn N · <mode> · <n> tool calls ·
<hh:mm:ss>` binding T2/T4/T5-T10 items produced within it. Thread auto-follows the newest item
only while the user is at the bottom; a `Jump to latest` pill appears when scrolled up
(≥ 300px) or when new items arrive off-screen.

## 4. Composer contract

States (mutually exclusive; `data-composer-state` attribute is the test/screenshot hook):

| State | Trigger | Visual | Controls |
|-------|---------|--------|----------|
| `ready` | session attached, no active turn, issue non-terminal | normal input, `Send` primary | Send (Cmd/Ctrl+Enter), attach disabled in Capability |
| `sending` | message posted, turn not yet streaming | input cleared, inline spinner on Send | Send disabled |
| `streaming` | active turn | input stays **editable** (steer), primary button becomes `Stop` (destructive-outline), helper text `Codex is working — send to steer, or stop the turn.` | Send = steer (queued as next user input), Stop |
| `waiting` | pending interaction card requires the user | input disabled, helper `Answer the pending request above to continue.` with an anchor link that scrolls to and focuses the pending card | none |
| `reconnecting` | transport lost | input disabled, helper `Reconnecting… your session is preserved.` | Retry now |
| `disabled` | terminal disposition, replay mode, or budget stop | input disabled with reason line (`Issue is done`, `Replay is read-only`, `Budget limit reached`) | New scenario / Reset |

Draft text survives refresh (localStorage per session id). Stop never discards the transcript;
a stopped turn's partial output stays in the thread with a `Stopped by user` marker on the
turn header.

## 5. Interaction cards (native lifecycle)

All five `request_human_input` kinds render as native cards using the typed payload's prompt,
options, labels, and validation — never as markdown asking the user to type an answer.

Kinds and their answer controls:

- `questions` (ask_user_questions): typed form — per-question control (radio/select/short
  text), one submit.
- `confirmation` (request_confirmation): target summary + Accept / Reject buttons; reject
  reason textarea when the payload requires it. **Revision-bound**: the card shows the target
  (`plan · r4`) and links the exact revision.
- `checkbox` (request_checkbox_confirmation): checkbox list with min/max enforcement,
  default-selected ids, Accept label / Reject label from payload.
- `suggest_tasks`: proposed-task list (title + description); board accepts a subset; accepted
  tasks appear as T8 cards afterwards.
- `item_verdicts` (request_item_verdicts): per-item Approve / Reject / Defer segmented
  buttons; reason required per `requireReasonOn`; supports partial submit (submitted items
  lock, remaining stay editable, card stays `pending`).

**Response authority path (normative):** the card's submit posts the typed response to the
package server; the **mock control plane stores the response before the runner receives it**,
and only then does the same Codex session resume with the typed result. The card's UI state
moves `pending → submitting → resolved` only on server acknowledgment (no optimistic
resolution). This is the *only* browser-initiated mock mutation; there is no other write path
from the page.

**State matrix (all states are required and visually distinct):**

| State | Store shape | Card treatment |
|-------|------------|----------------|
| `pending` | status `pending` | Accent left border (violet), controls enabled, `Waiting for you` chip, focus lands on first control when the card is the reason the composer is `waiting`. |
| `submitting` | in flight | Controls disabled, inline spinner. |
| `accepted` | status `accepted` | Green check chip `Accepted`, chosen values summarized inline, controls collapse to read-only summary. |
| `answered` | status `answered` | Same as accepted with `Answered` chip (questions / verdicts complete). |
| `rejected` | status `rejected` | Red chip `Changes requested`, reason quoted in the card. |
| `stale_target` | status `expired`, `result.outcome=stale_target` | Gray chip `Stale — plan moved to r5`, link to the superseding revision, controls removed, body dimmed (see revision 2). |
| `superseded_by_comment` | status `expired`, `result.outcome=superseded_by_comment` | Gray chip `Superseded by a later comment`, link to that comment. |
| `expired` | status `expired`, no outcome | Gray chip `Expired <relative time>`. |
| `withdrawn` | status `cancelled`, `result.outcome=withdrawn` | Gray chip `Withdrawn`, optional reason. |
| `issue_closed` | status `cancelled`/`expired`, `result.outcome=issue_closed` | Gray chip `Issue closed`. |

Resolved/expired cards are durable history: they stay in the thread at their chronological
position, are keyboard-reachable, and expose `View request evidence` linking the debug panel
to the related request, policy decision, mock mutation, wake, and resume events (the plan's
required debug linkage). Pending cards survive refresh and reconnect (§6) — rehydrated from
mock state, not from browser memory.

## 6. Session lifecycle behaviors

- **Refresh (F5)**: full restore from server state — same session, same turn ids, transcript,
  pending interaction cards, composer state, and mode chips. The session **never restarts
  because the browser reconnected**. Scroll restores to latest; a `Restored session` system
  notice (T11) is *not* emitted (silent restore) — the evidence panel's session record is the
  proof.
- **Reconnect**: on transport drop the composer enters `reconnecting`, a slim amber banner
  pins under the header (`Connection lost — retrying (attempt n)`), and streaming indicators
  freeze with a `paused` glyph. On reconnect, missed canonical events replay by ordinal (no
  duplicates, no gaps) and the banner resolves to a 3s `Reconnected` confirmation.
  `prefers-reduced-motion` replaces the banner slide with opacity.
- **Stop**: header Stop and composer Stop are the same action — bounded cancel of the active
  turn. Post-state: partial output retained + `Stopped by user` turn marker; session and
  pending interactions unaffected; composer returns to `ready`.
- **Reset**: destructive — always behind a confirm dialog (`Reset scenario? This clears the
  mock state and starts a clean session. The transcript will be lost.`; confirm button
  `Reset scenario`, destructive style; cancel is default focus). Reset re-seeds the fixture,
  rotates/clears session authority (Revision 4), and lands on a clean thread with a fresh
  `Turn 0` seeded context. Reset affects only the current browser session's scenario instance.
- **Replay**: mode `replay` re-renders a recorded run from canonical events. Composer
  `disabled` (`Replay is read-only`), identity chip row shows `Replay` + `Mock Paperclip`,
  and a top progress strip allows step/next-turn/play-all with a deterministic `?at=<ordinal>`
  deep-link parameter. Replay of a `fake` recording must still be labeled as fake-derived
  (chip `Replay · fake source`) so replay evidence can never satisfy a live criterion.
- **Stop/Reset/Replay/Scenario controls** live in the header on desktop; on mobile
  Replay/Reset/Scenario collapse into `⋯`, Stop stays exposed while a turn is active (§2.2).

## 7. Side debug panel (Evidence)

Named **Evidence** in UI copy. Content scope: a **turn selector** at the top (`Turn N ▾`,
default = latest; `All turns` option for the state and parity sections). Below it, eight
accordion sections in this order (accordion, not tabs — >7 categories, and multiple sections
must be open simultaneously for review):

1. **Tools exposed** — the turn's visible tool list grouped `Agent tool — always`, then
   `Agent tool — granted` (each with its grant, e.g. `rf:read_or_write`), then a separated
   muted list `Control plane (not exposed to the agent)` naming `control_plane_owned`
   operations relevant to the fixture. Negative evidence is first-class: the control-plane
   list exists precisely to show what the model *cannot* call.
2. **Calls & results** — chronological semantic calls: raw Codex request → dispatched command
   → typed result/denial, with operation id, version, and redaction annotations.
3. **Authorization** — one record per decision: operation, claims considered, allow/deny +
   reason, redactions applied, resulting state change ref. Deny records use the same red
   accent as T10.
4. **Control plane** — `runtime_decision_record` stream: checkout/lock, wake scheduling,
   budget, idempotency/retry, reconciliation, session lifecycle.
5. **Runner & events** — canonical PRP events and runnerd/Codex process diagnostics (session
   id, thread id, process state, cleanup evidence).
6. **State diff** — before/after per entity class (tasks, comments, documents, interactions,
   approvals, artifacts, blockers, workspace, budget, run). Per-turn by default; `All turns`
   shows fixture-seed → current. Rendered from immutable snapshots; the browser never
   computes a diff from its own bookkeeping.
7. **Traceability** — the fixture's 7A anchors: capability rows (id + `sourceAnchor`), eval
   case id/group/`browserEvidenceRecipe`, `expectedSemanticOperations`,
   `forbiddenOperations`, `requiredCapabilityGrants`.
8. **Parity** — assertion list with verdict chips (`pass` green / `fail` red /
   `intentional gap` gray + note), summarized as `n/m` in the section header.

Cross-linking contract: every T4 strip, T10 denial, and interaction card deep-links into the
matching Evidence record (`View in Evidence`), and every Evidence record links back to its
thread anchor. Deep-link target = section + record id, e.g. `?panel=authorization&rec=<id>`.

Mobile: the same eight sections render inside the `Evidence` segment, full-width accordions,
turn selector pinned under the segmented control.

## 8. Visual language

Follow the Paperclip design language without importing the product `ui/` package:

- Dark theme default, OKLCH neutral grays; semantic tokens only (background/card/muted/
  accent/destructive/border/ring equivalents defined package-locally). No raw hex in
  components.
- Type ramp: page title `text-xl font-bold`; card titles `text-sm font-medium`; body
  `text-sm`; metadata `text-xs text-muted-foreground`; identifiers and operation ids
  `font-mono text-xs`.
- Status/priority renders with StatusBadge/StatusIcon-equivalent components using the
  product's status hue table (todo blue, in_progress indigo, in_review violet, done green,
  blocked red, backlog/cancelled gray).
- Radii ≤ `rounded-xl`; shadows ≤ `shadow-sm`; density = product issue page, not a marketing
  layout.
- Interaction cards use the product interaction-card anatomy (title row + prompt + controls +
  state chip) so the mock thread reads as a Paperclip issue thread (Jakob's Law is the point
  of this phase's demo).

## 9. Accessibility acceptance (blocking)

7G is not acceptable until all of these pass; 7K re-verifies them clean-room:

1. **Keyboard tour** (documented, testable): Tab order = header controls → thread (each card
   is a focusable group; Enter expands) → composer → Evidence toggle → panel. The splitter is
   arrow-key resizable. Pending interaction controls are reachable without pointer; Escape
   closes the mobile `⋯` menu and the desktop overlay sheet.
2. **Focus management**: opening Evidence moves focus to its heading; resolving a card moves
   focus to the card's state chip; `waiting` composer's anchor link moves focus to the pending
   card's first control. Focus ring = 3px ring token, never suppressed.
3. **Live regions**: streaming agent text in `aria-live="polite"` chunk announcements (throttled
   ≥ 2s); turn completion, denial notices, and interaction resolution announce via a single
   polite status region; reconnect banner is `role="status"`, Stop confirmation `role="alert"`.
4. **Structure**: one `h1` (issue title), landmarks `header/main/complementary` (Evidence),
   `form` for composer; interaction cards are `section`s labeled by their prompt; tool strips
   are disclosure buttons with `aria-expanded`.
5. **Color independence**: every state chip pairs color with a glyph + text (`✓ Accepted`,
   `✕ Denied`, `⏳`); parity verdicts likewise. Contrast ≥ 4.5:1 for text, ≥ 3:1 for UI
   glyphs, verified in dark theme.
6. **Reduced motion**: `prefers-reduced-motion` disables pulse dots, banner slides, streaming
   shimmer, and smooth scrolling (instant jumps).
7. **Automated gate**: axe (or equivalent) run against every screenshot route in §10 with
   zero serious/critical violations, executed in CI alongside screenshot capture.

## 10. Deterministic screenshot contract

### 10.1 Route scheme

- Base route: `#/issue/<fixtureProfile>` (e.g. `#/issue/hb-baseline`). Scenario/fixture ids
  come from 7A `fixtureProfile`; per-case evidence uses the 7A `browserEvidenceRecipe` path
  (`<group>/<case-id>`) as the canonical evidence id.
- Screenshot state param: `?shot=<slug>` seeds the named deterministic state below in `fake`
  mode with: fixed clock (all timestamps render from fixture time), animations/caret/pulse
  disabled, network idle, fonts loaded.
- Panel/deep-link params: `?panel=<section>[&rec=<id>]`, `?at=<ordinal>` (replay),
  `?seg=thread|evidence` (mobile segment).
- Settle signal: the root element sets `data-thread-state="settled"` when hydration, fixture
  load, and auto-scroll are complete. Capture tooling waits for it — never for timeouts.

### 10.2 Required matrix (12 slugs × 2 viewports = 24 PNGs)

Viewports: desktop `1440×900`, mobile `390×844`. Output path:
`.paperclip-local/evidence/capability/ui/<slug>--<desktop|mobile>.png` (package-local). Every capture
also asserts `scrollWidth <= clientWidth` on the scrolling element at 390×844.

| Slug | Seeded state | Must be visible |
|------|--------------|-----------------|
| `thread-baseline` | settled 3-turn fake run on `hb-baseline` | header w/ 3 identity chips + mode; T1/T2/T3/T4 items; turn headers; composer `ready` |
| `turn-streaming` | mid-turn stream | streaming indicator, composer `streaming` w/ Stop, editable steer input |
| `interaction-question-pending` | `ix-questions-01` pending card | typed question form, `Waiting for you` chip, composer `waiting` w/ anchor helper |
| `interaction-confirmation-pending` | `ix-confirmation-plan-01` pending | revision-bound target (`plan · r4`) on card, Accept/Reject, reject-reason affordance |
| `interaction-resolved-mixed` | history incl. accepted + rejected + `stale_target` + `superseded_by_comment` | four visually distinct resolved/expired treatments per §5 |
| `denial-optional-tool` | denied `create_task` (missing `su:read_or_write`) | T10 denial strip w/ verbatim deny reason; Evidence badge increment |
| `document-revision` | `dp-plan-doc-01` after `write_document` | T6 card w/ revision chain `r3 → r4` + View diff |
| `deliverable-registered` | `ar-upload-before-done-01` | T7 deliverable card w/ kind + registered-by |
| `disposition-terminal` | `st-done-comment-01` finished | T9 terminal card, StatusBadge `done`, composer `disabled` w/ reason |
| `debug-panel-open` | baseline + `?panel=authorization` | desktop: panel open at 384px w/ 8 sections, authorization records; mobile: `Evidence` segment active |
| `reconnect-banner` | forced transport drop | amber reconnect banner, composer `reconnecting`, frozen stream glyph |
| `replay-mode` | replay of recorded fake run `?at=12` | `Replay · fake source` chip, read-only composer, progress strip |

Determinism rule: two captures of the same slug/viewport from a clean checkout must be
pixel-identical (the Scenario chat byte-identical bar). Anything time-, random-, or
locale-dependent renders from fixture data.

### 10.3 Evidence naming

Per-eval-case evidence (7F/7K scope) reuses `browserEvidenceRecipe` verbatim:
`.paperclip-local/evidence/capability/cases/<group>/<case-id>--<viewport>.png`. The §10.2 matrix is
the UI acceptance set; case evidence is additive and follows the same settle/determinism
rules.

## 11. Authority and safety rules (UI-side restatement)

- The browser renders mock-core records, snapshots, and canonical events. It computes no
  claim, policy, diff, or parity result client-side. UI-side state math is a defect.
- The only browser-initiated mock mutation is an interaction response (§5). Composer messages
  go to the runner session, not to mock state.
- No provider, runner, or control-plane credential ever reaches the browser; redactions render
  by rule name. Real Paperclip URLs/API paths never appear.
- Policy and state authority live in the package server + mock `ControlPlanePort`; refresh
  and reconnect re-derive everything from them.

## 12. 7G handoff checklist

Implementation acceptance (UXDesigner review) requires:

1. All §3 item types and all §5 interaction states implemented and reachable via fixtures.
2. All §4 composer states with `data-composer-state` hooks.
3. §6 behaviors demonstrated: refresh restore, reconnect replay, stop, reset confirm, replay
   read-only.
4. §7 Evidence panel with all eight sections, turn selector, and bidirectional deep links.
5. §10 matrix: 24 deterministic PNGs recorded at the named routes, byte-stable across two
   clean runs, plus the 390px no-horizontal-scroll assertion per capture.
6. §9 accessibility gate green (axe + documented keyboard tour).
7. Screenshot review posted to the 7G issue for UXDesigner acceptance before 7G closes.

Questions or gaps → comment on TASK-16940.

---

## Revisions

### Revision 2 — expired-family dimming (2026-08-10, written back by 7G)

Revision 1 specified a literal 60% opacity on the body of `stale_target` and the
other expired-family cards (§5). Measured against the card surface in the dark
theme, that renders the card's text at ~3.16:1, which fails §9.5's 4.5:1 bar and
the blocking axe gate in §9.7 — the two rules cannot both hold.

§9 wins because it is the blocking gate. "Dimmed" is now specified as a
**recessed treatment**: the card drops to the sunken surface token and its
secondary text drops to the muted-foreground token, both of which clear 4.5:1.
The gray state chip, removed controls, and neutral left border are unchanged, so
the card still reads as history at a glance.

Implemented in `devtools/issue-thread/src/issue-thread.css` and covered by the
axe gate on the `interaction-resolved-mixed` slug at both viewports.

### Revision 3 — `interaction-resolved-mixed` capture framing (2026-08-10, written by the contract owner during the 7G gate)

Revision 1's §10.2 row required four resolved/expired card treatments visible
in the `interaction-resolved-mixed` frame. Two of this contract's own rules
make that impossible in one capture: §10.1's settle signal ends with
auto-scroll to the latest thread item, and the §5/§8 card anatomy makes four
resolved cards ~1100px tall — taller than either viewport. The seeded history
(answered + accepted + rejected + `stale_target` + `superseded_by_comment`)
cannot fit one auto-scrolled frame.

The row now reads: the seeded state must contain **all five** treatments
(answered, accepted, rejected, `stale_target`, `superseded_by_comment`), the
frame shows the latest-scrolled portion with the expired-family chips
(`Stale …`, `Superseded …`) fully visible, and the visual distinctness of all
five treatments is asserted by the browser suite plus a scrolled review pass
at the gate. Splitting the slug into two frames was rejected because the
24-PNG matrix count is referenced by the 7F/7K evidence and the §9.7 axe gate.
