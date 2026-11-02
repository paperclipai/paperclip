# Status and Attention Operator UX Reference

**Document status:** Approved Codex UX input (TASK-16712, approved by the board 2026-08-07)<br>
**Relationship to the runner architecture:** [`architecture.md`](../docs/architecture.md) and [`durable-recovery.md`](../docs/durable-recovery.md) define the runtime trust and recovery boundaries. This document is the normative operator-facing presentation of that contract: vocabulary, components, board flows, copy, and token mapping. Provider data contracts MUST satisfy the read requirements here; UI implementation tasks consume this document directly.<br>
**Codex binding:** spec §18.12 (TASK-16713) is the contract that joins the two documents — view types, read routes, client derivation rules, component data contracts, and the `OPX-1…OPX-10` presentation invariants with their `OPX-F1…OPX-F11` release gates. Every requirement in this document appears as a row in the §18.12.11 coverage matrix with its backing field, component, and gate. Implementation reads both documents; a requirement here with no §18.12 field is a spec bug, not an implementation decision.<br>
**Scope:** desktop board (1440×900) — task page, issues board, attention inbox. Mobile is deferred by the source ticket.<br>
**Mockups:** six flow screenshots and one inspectable single-file HTML mockup (per-flow rendering via `?only=a|b|c|d|e|board`) are attached to TASK-16712.

---

## 1. The layered-outcome model (vocabulary system)

The contract yields four independent facts. A single status badge collapses them into exactly the "agent succeeded" lie the parent issue names. Codex renders them as four distinct visual layers with a strict vocabulary, so a stranger can tell in two seconds *what happened to the process* versus *what Paperclip decided about the work* (Mental Models; Nielsen #1 visibility of system status; #2 match to the real world).

| Layer | Source of truth (spec §18.3 authority table) | Values | Vocabulary rule | Visual treatment |
|---|---|---|---|---|
| **Turn outcome** | Harness driver | completed / failed / interrupted / cancelled | "Turn completed" — always the noun *turn* | Tiny mono-caption chip on the run row; never colored green |
| **Run outcome** | Runner / finalizer | succeeded / failed / cancelled | "Run succeeded" — always the noun *run* | Small neutral chip on the run row (existing `IssueRunLedger` liveness copy) |
| **Agent report** | Model claim (`ReportedWorkDisposition`) | done / blocked / needs_review / yielded | "reported done", "claimed complete" — always claim verbs, never bare "done" | **Claim chip**: outlined, `border-dashed`, `text-muted-foreground`, quote glyph. Never status-colored fill |
| **Issue status** | Status arbiter only (`StatusDecision`) | backlog … done / cancelled | The only element allowed to say "Done" plainly | Existing `StatusBadge` / `StatusIcon`, unchanged — remains the single authoritative badge |

Copy laws (enforceable in review):

1. Never compose "agent" + a success verb. Banned: "Agent succeeded", "Agent completed the task". Allowed: "Run succeeded", "UXDesigner reported done".
2. A claim is always attributed and past-tense: "*UXDesigner reported done · 12m ago*".
3. The arbiter is always the subject of status sentences: "*Paperclip kept In Progress — evidence incomplete*".
4. Filled status colors (green done, violet review, red blocked) are reserved for arbiter output. Claims and process outcomes use neutral/outline treatments. This makes disagreement visible pre-attentively (Selective Attention; color-independence: shape differs too — dashed vs solid).

---

## 2. Components

Three new composites plus surgical extensions to existing ones. All live in `ui/src/components/`, get CVA variants, and must be added to `/design-guide`.

### 2.1 `OutcomeChipRow` (new)

One row of the three non-authoritative layers, rendered on every finalized native run in `IssueRunLedger` and in the Live Run Console terminal card (spec §23.5 "final result visually distinct"):

```
Turn completed · Run succeeded · “reported done”        [decision →]
```

- Turn/run chips: `text-xs text-muted-foreground`, plain text with mid-dots — they are metadata, not signals (Cognitive Load: don't chip-ify everything).
- Claim chip: `rounded-full border border-dashed border-border px-2 text-xs text-muted-foreground`, leading `MessageSquareQuote` (14px). Tooltip: "What the agent reported. Paperclip decides issue status separately."
- Run `failed` / turn `failed` use `text-red-400` text (not a red fill) — a failed run with preserved status must not look like a blocked issue.

### 2.2 `StatusDecisionCard` (new — the arbiter explanation)

Renders one `StatusDecision` plus its `WorkAssessment` summary from `GET /api/issues/:id/status-decisions` (spec §18.11). Placement: run ledger directly under the run that produced it; the latest decision also appears as a one-line property in the task properties panel ("Decision · Kept In Progress · 12m").

**Collapsed row (default, Progressive Disclosure):**

```
[glyph] Kept In Progress — completion claim not accepted: evidence incomplete
        by Paperclip arbiter · triggered by run finalization · 12m ago     [∨]
```

- Glyph encodes the decision class (see §5 tone map). "Kept/Moved to {Status}" is the verb: `transitionApplied ? "Moved to" : "Kept"`.
- Reason code renders as plain-language copy (table in §4); the raw code is available in the expanded audit footer.

**Expanded body, in order (Inverted Pyramid):**

1. **Claim vs decision strip** — two cells side by side: left `“UXDesigner reported done”` (claim chip style), right authoritative `StatusBadge` + reason sentence. Only rendered when they disagree; this is the Von Restorff element of the card.
2. **Criterion table** — one row per `criterionAssessments` entry: criterion description · claim (`satisfied`/`unknown`) · arbiter classification (`accepted` green check / `missing` amber dash / `rejected` red x / `unverifiable` slate ?) · reason code · evidence links. Reuses Cost-table styling (`text-xs`, `bg-accent/20` header).
3. **What happens next** — side-effects list as actionable links, one per `sideEffects` entry: "Queued continuation for UXDesigner", "Created review interaction → open", "Bound blocker PAP-XXXX". This is the liveness answer to "who owns the next move" (Goal-Gradient; Nielsen #1).
4. **Audit footer** — `text-xs font-mono text-muted-foreground`: reason code, decision id, policy version, contract revision, supersession chain ("superseded by decision …" links both directions).

### 2.3 `AttentionRequestCard` (new — canonical attention record)

Renders one `CanonicalAttentionRequest` (spec §18.3.1). Placement: task page thread (where interaction cards render today, as an `IssueThreadInteractionCard` sibling) and, for board-routed pending requests only, the attention inbox as a new `AttentionQueueRow` source.

Anatomy top-to-bottom:

1. **Header:** classification icon + request summary/question (`text-sm font-medium`) + state chip (`pending / routed / resolved / expired / superseded / rejected / exhausted`) + urgency flag (`high` = amber dot, never a red fill).
2. **Meta chip row** (the required operator fields, each a labeled chip, `text-xs`):
   - **Owner** — selected resolver: avatar + "Waiting on: Dotta (board)" / "Routed to: CodexCoder". Owner is always a named person/agent/system, never "someone".
   - **Authority** — derived `minimumAuthority` in plain words: "needs a board decision", "needs governed approval". When the agent asked for more authority than policy derived, show the correction inline: `asked: human → resolved as: expertise` with tooltip "Paperclip routes by policy, not by the agent's request" (trust signal; prevents learned helplessness about spurious escalations).
   - **Scope** — "blocks this turn only" / "blocks one track" / "blocks the whole task". When narrowed, strike the claim: `~~task-wide~~ → this turn` with the alternate live track linked.
   - **Attempts** — "attempt 2 of 6" from `AttentionResolutionBudget` (spec §18.3.3); expandable route history (context ✓ → retry ✗ → agent…) so a human landing here sees escalation was earned, not first-resort.
   - **Expiry** — relative countdown "expires in 3h 40m"; switches to amber text under 25% remaining; the expired state renders the card inert with "expired unanswered · one fallback wake sent".
3. **Resume line (always present, directly above the response control):** the exact consequence of responding, generated from the response binding (spec §18.3.6): "*Answering wakes UXDesigner and resumes this turn*" / "*Answer recorded; UXDesigner wakes on its next scheduled turn*" / "*Recorded for audit only — this request was superseded*". Fitts/forgiveness: the operator knows what the button fires before pressing it — which is why it precedes the control in DOM order (spec §18.12 `[OPX-4]`/OPX-F3; sequential reading order for screen-reader users, who must hear the consequence before reaching the button). The TASK-16712 mockups draw this line as a card footer; this list's order is normative, not the mockup.
4. **Response affordance** — only for `route: board` + state `pending/routed`: the existing typed interaction control (`AttentionInteractionResolver`) — answer / choose / approve / decline. All other routes render read-only.

### 2.4 Extensions to existing components

- **`IssueRunLedger`** — insert `OutcomeChipRow` + nested `StatusDecisionCard` per finalized native run. Legacy runs render exactly as today (Jakob's Law; spec §28.2 compatibility).
- **`AttentionQueueRow`** — new source kind for board-routed canonical attention requests; reuse `DecisionTriageStrip` actions; suppressed duplicates and agent-routed requests never enter the queue (see flows C/D).
- **Properties panel (`IssueDetail`)** — two added property rows: "Decision" (latest `StatusDecisionCard` collapsed line, click scrolls to card) and "Waiting on" (owner chip of the oldest pending board-routed attention/liveness path). No new panel.
- **Issues board rows** — no new column. A single secondary chip slot after the title (existing `BlockedReasonChip` pattern) for exactly two conditions: `Needs you` (pending board-routed attention, violet) and `Reconciliation` (finalization error, cyan). Everything else stays on the task page (Miller / Choice Overload — the board stays scannable).
- **`FinalizationErrorCard`** — small variant of `StatusDecisionCard` for `finalization_failed_claim_preserved` / `result_schema_rejected` / `attention_budget_exhausted`: cyan "recovery" tone; names the recovery owner and retry state from `GET /api/heartbeat-runs/:runId/finalization`.

---

## 3. Desktop board flows

### Flow A — Completion disagreement (`completion_evidence_incomplete`)

> Run succeeded, agent reported done, arbiter kept In Progress and queued a continuation.

1. Board: issue stays in **In Progress** column — no movement, no false "Done" flicker (system honesty beats optimistic UI here).
2. Task page: run row shows `Turn completed · Run succeeded · “reported done”`; directly beneath, collapsed decision card: **"Kept In Progress — completion claim not accepted: evidence incomplete"**.
3. Expanding shows the claim-vs-decision strip, the criterion table (e.g. `tests pass` → claim satisfied → **missing**: no persisted test record), and "Queued continuation for UXDesigner".
4. Operator actions: open evidence refs; add guidance comment; or use the normal board status override — copy on the override confirm: "Your change is recorded as a board decision and supersedes the arbiter's" (the override becomes a `board_user` trigger for a superseding decision; the old card shows the supersession chain).

**Anti-goal:** no red/error styling. Disagreement is a *normal governed outcome*, not a failure — amber "downgraded" tone only on the decision glyph.

### Flow B — Real human-needed interaction (`attention_requires_human_authority`)

> Subjective judgment routed to the board; issue in_progress with a response wake (or in_review for contract review).

1. Attention inbox: one `AttentionQueueRow` — "UXDesigner needs a decision on TASK-16712 · expires in 3h · attempt 1". Issues board shows the violet `Needs you` chip.
2. Task page card shows the full anatomy: owner **you**, authority "needs a board decision", scope "blocks this turn only", attempts history proving context/agent routes were tried or skipped-by-classification, expiry, and the typed answer control.
3. Resume line: "*Answering wakes UXDesigner and resumes this turn.*"
4. On answer: card flips to `resolved` with the response pinned; a system marker "UXDesigner woken · continuation queued" appears; the `Needs you` chip clears. Peak-End: the operator sees their answer take effect without refreshing (spec §23.9 item 7).

### Flow C — Agent-routed resolution (`attention_routed_to_agent`)

> Agent asked for a human; resolver reclassified to expertise and delegated in-company.

1. **Not** in the attention inbox, no `Needs you` chip — humans are only interrupted for human-authority work (the parent issue's core ask).
2. Task page renders the card read-only: authority chip shows the correction `asked: human → resolved as: expertise`; owner "Routed to: CodexCoder"; link to the delegated issue; resume line "*CodexCoder's answer resumes this track — no action needed from you.*"
3. If delegation later exhausts, the card's attempt history grows and only then can a human route appear (budget rules, spec §18.3.3) — the UI never shows a human affordance on an agent-routed card.

### Flow D — Duplicate suppression (`attention_duplicate_suppressed`)

> Repeated/paraphrased request, same equivalence family.

1. Exactly **one** canonical card ever renders. Duplicates render as a one-line collapsed link row under it: "↳ asked again (reworded) · 8m ago · merged — no new notification", and increment the visible attempts/budget counter.
2. The inbox row count does **not** increase; no re-notification (protects trust in the queue; alarm fatigue is the failure mode).
3. The counter doubles as agent-quality telemetry the operator can cite ("this agent re-asked 3×").

### Flow E — Finalization / reconciliation errors (`finalization_failed_claim_preserved`, `result_schema_rejected`)

> Turn completed, then workspace/transport/finalization failed — or the report was invalid.

1. Board: issue status unchanged; cyan `Reconciliation` chip on the row.
2. Task page run row: `Turn completed · Run failed` (run failure text in red-400) + `“reported done”` claim chip still visible — the work report is preserved and must not disappear (spec §18.5).
3. `FinalizationErrorCard`: "**Finalization failed — completion claim preserved, not accepted.** Reconciliation scheduled · owner: Paperclip recovery · retry 1 of 3." For `result_schema_rejected`: "Agent report couldn't be read — status unchanged" + preserved raw payload link.
4. Explicit anti-copy: never "Agent failed" (the agent may have done the work) and never auto-"Done" (the claim is unverified). This row is the clearest case for the four-layer vocabulary.

---

## 4. Reason-code copy table (complete v1 enum)

Plain-language, ≤ 70 chars, agent-name-free; raw code in the audit footer. (Plain Language / Recognition over recall.)

| Reason code | Operator copy | Tone |
|---|---|---|
| completion_contract_satisfied | All acceptance criteria verified | accepted |
| completion_claim_policy_accepted | Claim accepted under low-risk policy | accepted |
| completion_evidence_incomplete | Completion claim not accepted: evidence incomplete | downgraded |
| completion_review_required | Completion needs review before Done | review |
| governed_gate_pending | Waiting on a governed approval | review |
| live_continuation_registered | More work queued — continuing | progress |
| turn_waiting_other_track_live | One track waiting; another continues | progress |
| task_wide_blocker_bound | Blocked task-wide — unblock owner assigned | blocked |
| attention_resolved_from_context | Answered from existing context | progress |
| attention_routed_to_agent | Routed to a qualified agent | progress |
| attention_requires_human_authority | Needs a human decision | review |
| attention_duplicate_suppressed | Repeat request merged — no new ask | preserved |
| attention_budget_exhausted | Escalation budget exhausted — recovery recorded | recovery |
| run_failed_partial_evidence_preserved | Run failed — partial work preserved | recovery |
| finalization_failed_claim_preserved | Finalization failed — claim preserved, not accepted | recovery |
| result_schema_rejected | Agent report couldn't be read — status unchanged | recovery |
| cancellation_turn_only / _run_only | Turn/Run cancelled — task unaffected | preserved |
| cancellation_issue_authorized | Task cancelled by authorized decision | blocked-tone gray |
| prior_status_preserved_no_live_path | Status preserved — no live path could be created | recovery |
| authorized_resume / dependency_resolved | Resumed by authorization / dependency resolved | progress |
| decision_superseded_by_new_evidence | Superseded by newer evidence | preserved |

New reason codes added to the v1 enum after this document's approval MUST land with a row in this table before they can be emitted on a UI-visible surface.

---

## 5. Token-system notes

**No new raw values.** Everything maps to existing tokens; two small semantic proposals.

1. **Decision tone map** (CVA variant on `StatusDecisionCard` glyph/border) reuses the TASK-75 status palette + `BlockedReasonChip` variants: accepted → `--status-task-done` (#22c55e); review → `--status-task-in_review` (#7c3aed); progress → `--status-task-in_progress` (#2563eb); downgraded → amber-500 family (BlockedReasonChip `stalled`); recovery → cyan family (BlockedReasonChip `recovery_required`); preserved → slate family (`external_wait`); blocked → `--status-task-blocked` (#dc2626).
2. **Claim treatment is a pattern, not a color:** `border border-dashed border-border rounded-full text-muted-foreground` + quote glyph. Document it as a named pattern ("claim chip") in `/design-guide` so it is reused for any future agent-asserted-but-unverified value. Color-independent by construction (dashed ≠ solid).
3. **Proposed semantic tokens** (only if implementation finds repeated inline pairs): `--tone-recovery` → cyan-500-based bg/fg pair and `--tone-downgraded` → amber-500-based pair, defined like the existing `--status-*` vars with `.status-chip` color-mix derivation. If declined, components use the BlockedReasonChip literal classes, which already pass AA in both modes.
4. Typography/spacing: entirely from the existing scale — card title `text-sm font-medium`, meta `text-xs text-muted-foreground`, audit `text-xs font-mono`, chips `rounded-full`, cards `rounded-lg border-border`, `space-y-1` property rows. Shadows ≤ `shadow-sm`.
5. Accessibility: every tone pairs color with a distinct glyph (check/dash/x/?/arrow); countdown text never relies on color alone ("expires in 40m" text turns amber *and* gains a clock glyph); all chips ≥ 24px hit target when interactive; reduced-motion: no pulse on `Needs you`, static dot.

---

## 6. Codex acceptance criteria (UX)

1. On any finalized native run, a stranger can answer separately: did the turn finish, did the run succeed, what did the agent claim, what did Paperclip decide — without opening a drawer (spec §18.11 consistency gate, UI bullet).
2. The strings "agent succeeded/failed/completed" appear nowhere; claims are attributed and quoted.
3. Every non-terminal decision card names its live path owner as a link.
4. A board-routed attention card always shows owner, authority, scope, attempts, expiry, and the resume consequence before the answer control.
5. Duplicates never add inbox rows; agent-routed requests never show human affordances.
6. Finalization errors preserve and display the claim while keeping status unchanged.
7. All five flows verified at 1440×900 against the mockups attached to TASK-16712.
