# Capability Interaction Map — Scenario Explorer and Screenshot Acceptance Spec

Status: **approved UX contract for 7F implementation** (TASK-16899, 2026-08-09).
Owner: UXDesigner. Implementer: 7F (browser scenario explorer), integrating
7C mock adapter output and 7E parity output.
Companion records: [Capability contract](../capability-contract.md),
`spec/capability/eval-traceability.yaml`, the Capability plan (TASK-16897),
[Live console interaction map](live-console-interaction-map.md),
[SDK component decisions](sdk-component-decisions.md).
(annotated desktop + mobile renders in `.paperclip-local/evidence/capability/`).

This map is the interaction contract for the Capability browser scenario
explorer. The explorer is a **read surface over records the runtime already
produced**. It renders scenario metadata from the generated 7A traceability
manifest, run artifacts from the 7C mock control-plane adapter, and parity
results from the 7E conformance suite. The UI never owns state, policy,
credentials, or execution decisions: it does not compute tool exposure, does
not evaluate claims, does not apply redaction, and holds no Paperclip or
provider credential. Every allow/deny, redaction, and state transition shown
on screen must arrive as a record emitted by the mock core.

## 0. Naming, vocabulary, and canonical labels

- Product name in the UI: **Scenario Explorer** (header: “Capability scenario
  explorer — mock control plane”).
- UI copy uses the canonical term **task** (`DESIGN.md` principle 7). Eval
  case IDs, fixture IDs, route paths, JSON payloads, and source anchors are
  machine values and stay verbatim (`issues`, `i-0102`, `MCK-102`) in
  monospace — never “translated.”
- The three dispositions render with exactly these labels, everywhere:
  **Control plane** (`control_plane_owned`), **Always tool**
  (`always_agent_tool`), **Optional tool** (`optional_agent_tool`). The
  traceability panel and all badges must use the 7A contract values as their
  source; no UI-local re-classification.
- The five assertion classes render as: **Invariant**
  (`control_plane_invariant`), **Tool contract** (`agent_tool_contract`),
  **Authorization** (`authorization_policy`), **Multi-hop**
  (`combined_multi_hop`), **Restraint** (`restraint_no_call`).
- Parity statuses: **Pass**, **Fail**, **Intentional gap**, **Not run**.
  Each has an icon + text label; color alone never encodes status (WCAG
  color-independence).

## 1. Shell and information architecture

Package-local Vite entry `examples/scenario-explorer/` with script
`demo:scenarios` (default port 4183; 4182 belongs to the Standalone demo). It runs
from static assets plus checked-in fixtures with **no Paperclip services and
no network dependency** in fake-agent mode. Reuse the frozen `0.1.2` SDK
surface (`@paperclipai/paperclip-runner/react` + `./styles.css`) through its
five approved extension points; do not fork the token layer.

Desktop layout (≥ 64rem), one React tree (SDK finding — never render two
trees):

- **Left rail (`--pcr-rail-width`, 17rem):** scenario picker — search,
  facet filters, case list grouped by eval group.
- **Center column (fluid, max `--pcr-center-width`, 48rem):** run view —
  the chronological scenario transcript and the run header (verdict banner,
  mode toggle, run/replay controls). Primary surface, strongest hierarchy.
- **Right rail (`--pcr-inspector-width`, 24rem):** inspector with four tabs
  — **Context · Authorization · State diff · Parity**. Open by default on
  desktop (unlike the 4b protocol inspector: here the inspector carries
  first-class acceptance evidence, not diagnostics).

Mobile (< 64rem): single column behind a segmented control
(`Scenarios · Run · Inspect`), same pattern as the Live console console. The
segmented control is sticky at the top; the Run segment is the default when
a case is selected via route. Touch targets ≥ `--pcr-touch-target` (2.75rem).

Density: diagnostic-console dense, like 4b. All spacing, color, type, radius,
motion from `--pcr-*` tokens only (`DESIGN.md` principles 2–4; `pnpm
check:token-gates` applies).

## 2. Scenario picker and filters (left rail)

**Source of truth:** the generated scenario index derived from
`spec/capability/eval-traceability.yaml` (all 106 cases, 16 groups) plus the
latest parity results artifact from 7E. The picker consumes these; it never
re-derives group membership or dispositions.

Contents, top to bottom:

1. **Search input** — substring match on case ID and title. Mono rendering
   of matched IDs. Debounce ≤ 150ms (Doherty).
2. **Facet filters** (collapsible group, `--pcr-facet-height` baseline):
   - **Group** — the 16 eval groups (`hb 5 · co 6 · st 8 · cm 6 · se 4 ·
     su 4 · bl 5 · dp 3 · ix 9 · ap 6 · ar 4 · er 9 · rf 22 · mh 4 · rs 3 ·
     wk 8`), each with its case count.
   - **Case** — direct case-ID picker (combobox) for jump-to-case.
   - **Disposition** — Control plane / Always tool / Optional tool, from
     `primaryDisposition`.
   - **Role** — actor role of the fixture (`ic`, `manager`, `reviewer`,
     `board_user`, …) from the scenario index (§9 data contract).
   - **Claim** — required grants from `requiredGrants` (e.g.
     `approval:read`), rendered mono.
   - **Parity status** — Pass / Fail / Intentional gap / Not run, from the
     parity artifact.
   Facets are AND-combined across facets, OR-combined within a facet. Every
   facet value shows its live result count; zero-count values stay visible
   but disabled (recognition over recall — the vocabulary stays learnable).
   An active-filter chip row with per-chip remove and one **Clear filters**
   affordance sits above the list (forgiveness).
3. **Case list** — grouped by eval group with sticky group headers. Each row:
   case ID (mono, `--pcr-font-size-xs`), title (one line, truncated with
   full text in a tooltip), disposition badge, parity status dot+icon.
   Selected row uses `--pcr-accent-surface` with a `--pcr-accent` left rule.

Keyboard: the list is a single-select listbox (`role="listbox"`,
`aria-activedescendant`); Up/Down move, type-ahead jumps, Enter selects and
moves focus to the run header. Facets are disclosure buttons +
checkbox groups. Filter state mirrors into the route (§7) so any filtered
view is linkable; filter state is never stored as protocol state.

Empty results: “No scenarios match these filters.” + Clear filters button —
never a bare void.

## 3. Run view (center column)

### 3.1 Run header

- Case ID (mono) + title, group badge, disposition badge, assertion-class
  badges.
- **Verdict banner** (SDK `Banner`): overall parity verdict for the last
  completed run — Pass (success surface), Fail (danger surface), Not run
  (muted). The banner names the assertion counts (“12 assertions · 12 pass”)
  and deep-links the Parity tab.
- **Mode control:** `Fake agent` (default) / `Codex (bounded)` segmented
  control. Fake mode is always available offline. Codex mode appears only
  when the local relay is reachable; otherwise the option renders disabled
  with the reason (“provider relay not running — see tutorial §4”). The
  browser never holds a provider credential; Codex traffic goes through the
  same server-side relay boundary proven in SDK.
- **Run / Re-run** button and replay controls (SDK `replay-controls`).
  Deterministic fixtures mean re-run in fake mode reproduces the identical
  timeline; state diffs and parity always describe the displayed run.

### 3.2 Scenario transcript

**Source of truth:** the ordered run artifact timeline emitted by the mock
core (§9). Items render in artifact order; the UI never reorders, merges, or
re-times entries.

The transcript interleaves two visually distinct channels (Similarity +
Common Region — a stranger must tell them apart in two seconds):

1. **Agent channel** — model turns and semantic tool calls/results. Aligned
   with the standard conversation layout (SDK `conversation`/`message`/
   `tool-item`). A semantic tool call renders collapsed by default with a
   one-line summary: operation ID (mono) + disposition badge + one-phrase
   outcome (“`finish_task` · Always tool · committed”). Expansion is the
   item-body / request-detail extension point (§8) and shows: operation ID
   and version, argument JSON, result JSON, idempotency behavior, claims the
   call required, and redaction chips (§5) — exactly the descriptor fields
   from the 7D catalog, never re-labeled.
2. **Control-plane channel** — actions the runtime performed with **no
   tool** (checkout, wake routing, budget stops, reconciliation, blocker
   wake scheduling…). These render full-width on a `--pcr-muted` surface
   with a “Control plane” badge and a gutter glyph distinct from tool items,
   and are indented from the agent lane. Copy states the actor plainly:
   “Control plane checked out task MCK-102 — no agent tool exists for this.”
   Each entry expands to the decision record (inputs considered, resulting
   state change, audit reference).

Failed/denied entries render in place on `--pcr-danger-surface` with the
exact typed denial (§5) — failures are part of the record, never toast-only.

Restraint/no-call scenarios (`rs-*`, `er-*` restraint cases) must remain
legible when the correct behavior is *absence*: after the final agent turn
the transcript appends a system note “No further operations — N forbidden
operations, none invoked” which deep-links the Parity tab’s forbidden list.
Restraint evidence must never depend on an empty screen.

PRP events stay behind a per-item “Protocol events” disclosure (same nested
pattern as SDK `debugEvents`) — the semantic view is primary; raw
protocol stays inspectable but secondary (progressive disclosure).

Auto-follow, jump-to-latest, streaming affordances, and reduced-motion rules
are inherited verbatim from the Live console map §1 — do not redesign them.

## 4. Inspector tabs (right rail)

All four tabs are SDK `Tabs`; the active tab mirrors into the route (§7).

### 4.1 Context

Answers “who ran, under what authority, with which tools” before any
transcript reading (mental model first):

- **Actor block:** actor role, task mode, fixture ID (mono), wake payload
  summary (reason + trigger), budget posture.
- **Capability grants:** the scenario’s `requiredGrants` plus every grant
  the fixture actually issued, rendered as mono chips.
- **Tool exposure list** — the acceptance-critical view. Three labeled
  sections, populated **only** from the mock core’s exposure record:
  1. **Always tools (N)** — always-catalog operations visible this run;
  2. **Optional tools (N)** — visible optional operations, each with the
     grant that unlocked it (“`decide_approval` — via `approval:decide`”);
  3. **Control plane — no tool (N)** — control-plane-owned capabilities
     relevant to this scenario, explicitly listed so reviewers can verify
     absence (negative evidence must be visible, not implied).
- **Traceability panel:** source anchor (file:line, mono), skill elements
  (file · section · lines), evidence IDs, legacy MCP mapping row if any —
  verbatim from the 7A contract.

### 4.2 Authorization

Chronological table of every authorization record the mock core emitted:
operation (mono), claims considered, decision (**Allow** / **Deny** with
icon + text), reason string, redactions applied, resulting state change
reference. Row expansion shows the full record JSON. Denied rows use
`--pcr-danger-surface`; a count chip on the tab surfaces denials without
opening it (“Authorization · 1 deny”). Selecting a row scrolls/flashes the
corresponding transcript entry (uniform connectedness across panels).

### 4.3 State diff

Before/after immutable snapshot diff for the displayed run, grouped by the
ten entity domains in the plan: **tasks, comments, documents, interactions,
approvals, artifacts, blockers, workspace, budget, run**. Each domain is a
collapsible section headed by a change summary (“tasks · 1 changed”,
“comments · 2 added”); unchanged domains collapse to a single muted row
(“unchanged”) so change carries the visual weight (Von Restorff). Rows show
entity ID (mono) + field-level changes as `field: before → after`, with
added/removed/changed markers as icon + label, not color alone. The diff is
computed by the runtime/test layer and delivered as data; the UI performs no
diffing of its own. A “final state” toggle shows the complete after-snapshot
JSON per domain behind a disclosure.

### 4.4 Parity

The eval acceptance surface:

- **Verdict header** repeating the banner verdict.
- **Assertion list:** one row per conformance assertion — assertion class
  badge, human-readable expectation, Pass/Fail, and on fail an expected vs
  observed block (mono, side-by-side at desktop, stacked at mobile).
- **Forbidden operations:** each `forbiddenSemantics` entry with “never
  invoked ✓” or the violating transcript reference.
- **Intentional gaps:** entries marked as intentional exclusions render
  under their own heading with the recorded rationale — visually distinct
  from Fail (a gap is a decision, not a defect).
- **Legacy baseline note:** the case’s skill-present/skill-absent reference
  note, verbatim, muted — labeled “reference baseline, not the pass
  condition.”

## 5. Credentials, redaction, and denial rendering

- Fake mode performs zero network I/O; Codex mode talks only to the local
  relay; no route, storage key, or bundle string may contain a Paperclip or
  provider credential. `localStorage` may hold UI preferences only
  (inspector tab, filter collapse state) — never run artifacts, grants, or
  anything from a fixture.
- Redacted values arrive pre-redacted from the mock core. The UI renders a
  redaction chip: `•••` + “redacted” label + the redaction-rule name in a
  tooltip. The UI must not receive-and-hide secrets; if a raw secret ever
  reaches the browser payload, that is a 7C/7D defect, and the explorer
  additionally fails closed by rendering nothing for fields flagged
  redacted.
- A **denied** tool call renders the typed policy denial: operation, the
  missing claim, and the denial reason — and never any protected state. An
  **absent** tool simply does not appear in exposure lists; the Context tab’s
  control-plane section is the affordance proving absence is intentional.
- The generic escape hatch (`paperclipApiRequest` successor), when a test
  scenario grants it, renders with a persistent `--pcr-warning-surface`
  “test-only escape hatch” banner on every call card (plan §4: visually
  flagged).

## 6. Accessibility, responsive, empty/error states

Accessibility (WCAG POUR; inherits all Live console/5 baseline rules):

- Landmarks: `nav` (picker), `main` (run view), `complementary`
  (inspector); one `h1`; group headers are `h2`/`h3` in order.
- Full keyboard operation: picker listbox (§2); `F6`/documented shortcut
  cycles the three regions; tabs follow the WAI-ARIA tabs pattern
  (arrow-key activation); every disclosure is a real `button`. Visible
  focus ring via `--pcr-ring` everywhere.
- Live regions: run progress announces via `aria-live="polite"`
  (“Scenario run settled — verdict pass”); denial entries announce
  assertively once.
- Reduced motion: with `prefers-reduced-motion`, streaming reveal, banner
  transitions, and scroll-flash connect cues render instantly/statically
  (SDK rule).
- Contrast from the existing token pairs only; parity/authorization
  statuses always icon + text.

Responsive: content-driven single breakpoint at 64rem (§1). At mobile the
inspector tabs become full-width stacked sections inside the Inspect
segment; expected-vs-observed blocks stack; the transcript keeps every
descendant intrinsically shrinkable (`min-w-0` discipline) so no horizontal
scrollbar appears at 390px (SDK finding).

States that must be designed, not defaulted:

| State | Surface | Rendering |
| --- | --- | --- |
| No scenario selected | Center + inspector | Explorer intro card: corpus stats (106 cases · 16 groups), “Pick a scenario” pointer at the rail, three example deep links. No dead panels. |
| Scenario selected, not run | Run view | Header + context render from the index; transcript area shows a primed empty state (“Run to produce the deterministic timeline”) with the Run button duplicated inline (Fitts). Diff/Parity tabs show “No run yet.” |
| Run in progress | All | Progress in the header (indeterminate, reduced-motion safe); transcript streams; tabs show live counts; controls disable with reasons. |
| Run failed (harness error) | Run view | Danger banner with the exact diagnostic + “Re-run”; partial timeline stays visible and labeled partial. Never silently reset. |
| Parity fail | Banner/Parity | Fail is a first-class rendered state (danger banner + failing assertion rows) — the explorer’s job is showing it, not avoiding it. |
| Denied/absent tool | Transcript/Context | Per §5. |
| Missing/invalid fixture or artifact | Shell | Error card naming the artifact path and the regenerate command (`pnpm generate:capability-inventory` / 7E command). No blank screen. |
| Codex relay unavailable | Mode control | Disabled option + reason; fake mode remains fully usable. |

## 7. Deterministic screenshot routes

Hash routing (static hosting, no server rewrites):

```
#/                                  explorer home (picker + intro)
#/case/<case-id>                    scenario selected, not run
#/case/<case-id>?run=fake           deterministic fake run, auto-executed
#/case/<case-id>?run=fake&view=<transcript|context|authorization|diff|parity>
#/?group=<g>&disposition=<d>&role=<r>&claim=<c>&parity=<p>&q=<text>   filtered picker
```

Determinism contract for screenshot/CI use:

- `run=fake` auto-runs the scenario to completion on load; when the run and
  all panels are settled the shell sets `data-run-state="settled"`
  (Playwright wait target). Until then it is `pending`.
- Fake runs render **fixture time only** — no wall-clock timestamps,
  durations, or locale-dependent formatting anywhere in fake mode; ordering
  is by artifact sequence. Two loads of the same route are pixel-identical
  at the same viewport (modulo font rasterization).
- `view=` selects the inspector tab (desktop) or segment+tab (mobile);
  `view=transcript` closes nothing — it just guarantees focus/scroll starts
  at the transcript top.
- Stable `data-testid`s (minimum set): `scenario-picker`, `facet-<name>`,
  `case-row-<id>`, `run-header`, `verdict-banner`, `mode-toggle`,
  `transcript`, `transcript-item-<seq>`, `cp-action-<seq>`,
  `inspector-tab-<name>`, `exposure-always`, `exposure-optional`,
  `exposure-control-plane`, `authorization-row-<seq>`, `diff-domain-<name>`,
  `parity-assertion-<n>`, `redaction-chip`.

## 8. Package-local implementation guidance (7F)

- **Reuse first.** Shell, transcript, and inspector compose the frozen SDK:
  `RunnerConsoleApp` is *not* the shell (this is not a chat console);
  compose `conversation`, `message`, `tool-item`, `tabs`, `card`, `badge`,
  `banner`, `menu`, `dialog`, `tooltip`, `replay-controls` from
  `@paperclipai/paperclip-runner/react`. Semantic call detail uses the
  item-body renderer (ext point 1); control-plane detail uses the
  request-detail renderer contract (ext point 2); theming via scoped
  `--pcr-*` overrides (ext point 4). Do not add SDK exports or break the
  `0.1.2` freeze — explorer-only components live in the explorer entry.
- **New explorer-local components** (system proposals, one job each):
  `ScenarioPicker` (search + facets + listbox), `ExposureList`,
  `AuthorizationTable`, `StateDiff` (domain sections + field rows),
  `ParityPanel`, `RedactionChip`, `ChannelEntry` (control-plane transcript
  entry). Each uses tokens only; any genuinely missing token (e.g. a
  `--pcr-diff-*` pair if muted/success/danger surfaces prove insufficient)
  is proposed in the 7F PR as a token addition, never inlined.
- **Data contract consumed (owned by 7C/7E, not the UI):**
  - *Scenario index* (generated from `eval-traceability.yaml`): `id`,
    `title`, `group`, `fixture`, `actorRole`, `taskMode`,
    `primaryDisposition`, `requiredGrants[]`, `assertionClasses[]`,
    `sourceAnchor`, `skillElements[]`, `evidenceIds[]`,
    `forbiddenSemantics[]`. If `actorRole`/`taskMode` are not yet in the
    manifest, 7C adds them to the index generator — the UI must not infer
    them from prose.
  - *Run artifact* (per scenario × mode): ordered `timeline[]` entries
    discriminated as `semantic_call` / `semantic_result` /
    `control_plane_action` / `protocol_event_ref`; `exposure` (always /
    optional-with-grant / control-plane lists); `authorizationRecords[]`
    (operation, claims considered, decision, reason, redactions, state-change
    ref); `snapshots.before` / `snapshots.after` per entity domain;
    `parity` (assertions with class/expected/observed/status, intentional
    gaps with rationale, legacy baseline note, verdict).
- **Authority rule (binding):** every rendered fact traces to one of those
  records. Grep-able heuristics, UI-side claim math, or re-deriving
  dispositions from case IDs are defects. If a view needs a fact the records
  lack, extend the record upstream.
- **`DESIGN.md` alignment:** tokens-only values; one component per job;
  hierarchy by structure not decoration (domain sections and channels use
  surface + position, minimal borders); status vocabulary systematic (§0
  labels everywhere); machine values (IDs, anchors, grants, JSON) in
  `--pcr-font-mono`; canonical copy “task.”
- **Testing hooks 7F must ship:** component tests for the four inspector
  tabs and both transcript channels; keyboard-path tests (listbox, tabs,
  region cycle); reduced-motion test; the §7 route determinism test
  (two loads → identical settled DOM); accessibility assertions (landmarks,
  names, contrast tokens); screenshot capture script for §9.

## 9. Screenshot acceptance matrix

Evidence lands in `.paperclip-local/evidence/capability/` as
`<slug>-<viewport>.png`, at both **1440×900** and **390×844**, captured from
the §7 routes after `data-run-state="settled"`. These twelve shots are the
UX acceptance set for 7F (they also cover the plan’s human-checkpoint
scenario families: heartbeat, planning, blockers, approvals, artifacts,
interactions, manager, multi-hop, restraint).

| # | Slug | Route | Expected visible evidence |
| --- | --- | --- | --- |
| 1 | `explorer-home` | `#/` | Picker with all 16 group facets and counts summing to 106; intro card with corpus stats; no dead panels. |
| 2 | `picker-filtered` | `#/?group=ix&disposition=always_agent_tool&parity=pass` | Active filter chips; filtered count visible; zero-count facet values disabled but legible; Clear filters affordance. |
| 3 | `hb-heartbeat` | `#/case/hb-scoped-wake-01?run=fake&view=transcript` | Control-plane channel entries for scoped-wake routing and checkout (“no agent tool exists for this”), then `get_task_context` agent call; pass banner. |
| 4 | `wk-planning` | `#/case/wk-plan-directive-01?run=fake&view=transcript` | `write_document` call with revision fields, revision-bound `request_human_input` (confirmation), review-parked disposition; no re-plan loop. |
| 5 | `bl-blockers-diff` | `#/case/bl-create-blocked-01?run=fake&view=diff` | State diff: tasks domain shows the new task created blocked; blockers domain shows first-class `blockedByIssueIds`; unchanged domains collapsed. |
| 6 | `ap-approval-denied` | `#/case/ap-mcp-gate-01?run=fake&view=authorization` | Authorization table with a Deny row (missing claim + reason, danger surface, no protected state); “Authorization · 1 deny” tab chip; transcript shows the typed denial card. |
| 7 | `ar-artifacts` | `#/case/ar-upload-before-done-01?run=fake&view=transcript` | `register_deliverable` completing **before** `finish_task` in artifact order; deliverable metadata in the expanded call card. |
| 8 | `ix-interaction` | `#/case/ix-checkbox-01?run=fake&view=transcript` | `request_human_input(kind=checkbox)` call card with options payload; control-plane wake/continuation entry; result inspection entry. |
| 9 | `rf-manager` | `#/case/rf-api-mgr-heartbeat-01?run=fake&view=context` | Context tab: manager role; optional discovery tools listed **with their unlocking grants**; control-plane “no tool” list populated; traceability panel showing source anchor + skill elements. |
| 10 | `mh-multihop` | `#/case/mh-subtask-tree-01?run=fake&view=parity` | Multi-hop assertion rows (child creation, chained blockers) all Pass; forbidden operations section showing “never invoked ✓”. |
| 11 | `rs-restraint` | `#/case/rs-question-only-01?run=fake&view=parity` | Restraint verdict: answer-only transcript with the “No further operations” note; parity forbidden list showing zero state writes; Pass banner. |
| 12 | `rs-secret-redaction` | `#/case/rs-secret-hygiene-01?run=fake&view=transcript` | Redaction chips (`•••` + rule name) in call/result cards; comment content free of the key; parity Pass. |

Mobile captures use the same routes; the segmented control must show the
correct active segment (`Run` for transcript shots, `Inspect` for tab shots)
and no horizontal scrollbar may be present.

Acceptance procedure: UXDesigner reviews all 24 images against this matrix
before 7F is accepted (plan §6: “UXDesigner supplies the interaction map and
reviews screenshots before implementation acceptance”). Any deviation is
either fixed or written into this document as a revision — silent divergence
fails the gate.

## 10. Out of scope / rejected

- No second app shell, no Tailwind/Radix, no dark mode, no markdown
  renderer, no command palette, no transcript virtualization — SDK
  rejections stand.
- No editing affordances of any kind: fixtures, grants, and policies are
  changed in code/YAML, not in the browser. The mode toggle and run/replay
  controls are the only mutating-looking controls, and they mutate only the
  in-browser demo run.
- No parity “re-judging” in the UI: the Parity tab renders 7E output; it
  never recomputes assertions.
- No live-Paperclip or ACPX affordances; the future binding boundary stays a
  docs note, not a UI surface.

## 11. Revisions recorded during 7F implementation

Per §9, deviations are written here rather than left silent. All of the
following were found while building the explorer (TASK-16904) and are now part
of the contract.

1. **Timeline entry kinds extended.** §8 listed `semantic_call`,
   `semantic_result`, `control_plane_action`, and `protocol_event_ref`. The
   agent channel also needs plain model turns and the restraint note §3.2
   requires, so the artifact adds `agent_message` and `system_note`. Protocol
   event references ride on `semantic_result.protocolEventRefs` rather than
   standing as their own entry, keeping the semantic view primary.

2. **Parity is computed by the runtime, not the browser.**
   §4.4 and §10 forbid the UI from judging assertions, and they do: the
   package-local scenario runner (`src/scenarios/scenario-parity.ts`) produces the
   verdict from the traceability expectations and the recorded artifact. The
   conformance suite's own per-case result is carried through verbatim in a separately
   labelled "Capability conformance suite" block and is never merged into, or
   used to overrule, the assertion list. When no conformance report is bundled the block
   reads **Not run**.

3. **Actor role, task mode, and scenario claims are declared, not inferred.**
   §8 assigned `actorRole`/`taskMode` to the scenario index generator; it shipped
   without them. They are now declared in `src/scenarios/scenario-index.ts` as an
   explicit fixture/case profile table, alongside the catalog claims each
   scenario grants. A claim that cannot unlock any operation in the scenario's
   task mode or for its actor role is dropped from the profile, so no scenario
   renders a grant chip that unlocks nothing.

4. **The mobile section switcher is a `radiogroup`, not a `tablist`.** §1 asked
   for the Live console segmented control. The Live console console renders it only in
   compact mode; the explorer keeps one CSS-driven tree, so a `tablist` would
   put two tablists in the document and model the three landmarks as tabpanels.
   The three regions stay `nav`/`main`/`complementary`, and the only `tablist`
   on the page is the inspector's.

5. **Two token-layer overrides, scoped to the explorer.** The SDK gives every
   direct `span` child of a disclosure summary `min-width: 0`; a `Badge` is
   also a `span` and sets `white-space: nowrap`, so at 390px badges were
   squeezed below their own content and pushed the page into horizontal scroll.
   The SDK badge also applies `text-transform: capitalize`, which renders
   "Optional Tool" and "Not Run" against the §0 vocabulary. Both are corrected
   in `examples/scenario-explorer/src/explorer.css` under `.pcr7-shell`; the
   frozen `0.1.2` sheet is unchanged. **These are SDK defects worth fixing at
   the next SDK revision, not explorer quirks.**

6. **Only the case list scrolls in its own box.** The rails are otherwise in
   page flow. §9 evidence is captured full-page, and an inner scroll container
   on the rail clipped exactly what the matrix asks to see (all 16 group facets
   and their counts). The 106-row case list keeps a bounded height so the page
   stays navigable.

7. **Shot 2's route uses `parity=not_run`.** §9 specified
   `#/?group=ix&disposition=always_agent_tool&parity=pass`. Parity status is a
   property of a *run*, and the picker route runs nothing, so `parity=pass`
   selects zero scenarios on a cold load. The recorded route filters on
   `not_run`, which is the honest cold-load state and still demonstrates
   chips, live counts, disabled zero-count values, and Clear filters.

The following revisions were recorded at the 7F UX gate (TASK-16905,
2026-08-09) after reviewing all 24 captures and a live keyboard/responsive
session at both viewports.

8. **Shot 8's continuation evidence is split across surfaces.** In
   `ix-checkbox-01` the continuation appears as the Context tab's
   control-plane exposure entry (`route_wake` — "Interaction continuations
   are routed by the control plane, not requested again") plus the parked-note
   system entry — not as transcript entries. No fixture in the corpus scripts
   the continuation-consuming side: only the ten §9 cases have bespoke
   fake-agent plans, `ix-checkbox-result-01` falls back to a generic script
   that re-raises `request_human_input` (contradicting its own premise), and
   `inspect_operation_result` is catalogued but never invoked corpus-wide.
   Accepted for 7F because the request side and routing authority are fully
   evidenced; the continuation-side fixture upgrade is a filed follow-up, not
   a silent gap.

9. **Forbidden-operations lists are empty corpus-wide.** All 106 cases record
   empty `forbiddenSemantics`, so §9 rows 10–11's "never invoked ✓" rows
   cannot render from real fixture data. Restraint is proven by state-diff
   absence plus the intentional-gap rationale, and the Parity tab says so
   explicitly ("This case records no forbidden operations; restraint is
   proven by the absence of state writes in the diff"). The populated-list
   path (`never invoked ✓` / violating transcript reference) exists in
   `inspector-panels.tsx` and is unit-tested; the explanatory empty state is
   accepted as the §9 rendering.

10. **Keyboard deltas, accepted as interim with a filed follow-up.** The
    picker listbox uses selection-follows-focus (arrows select immediately —
    a valid listbox pattern the map did not anticipate); type-ahead and
    Enter-moves-focus-to-run-header are not implemented; `F6` region cycling
    is replaced by a "Skip to run view" skip link plus landmark navigation;
    denial entries do not announce assertively (only a fail verdict does).
    §7's `inspector-tab-<name>` testids are absent (the frozen SDK `Tabs`
    exposes roles, not testids) — tests target tabs by accessible name.
    An unknown case ID in the route falls back silently to the home view
    rather than a named error card.

11. **Redaction chips render the rule name inline**, not in a tooltip:
    `••• redacted <rule>`. Inline beats hover-only disclosure (works on
    touch, visible in captures); recorded as the new §5 contract.

12. **Evidence captures expand disclosures.** The recorder opens every
    `main`/`aside` disclosure before capturing so argument payloads, decision
    records, and final-state JSON are visible in the §9 images. The live
    defaults are collapsed exactly as §4.3 specifies (verified in the gate's
    live session); the expanded captures are a deliberate evidence choice,
    not the default density.

13. **UX-gate keyboard follow-up.** The explorer handles `F6` for region
    cycling when the browser delivers that key to the page. Chromium reserves
    bare `F6` for browser chrome, so the documented in-page alternative is
    `Control+Period`; `aria-keyshortcuts` exposes both bindings. Either binding
    cycles picker (`nav`) → run (`main`) → inspector (`complementary`), with
    `Shift+F6` cycling in reverse where bare `F6` is available. The skip link
    remains unchanged.
