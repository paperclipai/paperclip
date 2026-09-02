# DECISION-SHEET — Run 1 human review

Every open question from TOKEN-AUDIT.md §8 + batch logs and COMPONENT-INVENTORY.md §6, each with a recommendation, blast radius, and where it lands. Statuses: **PENDING** → APPROVED / OVERRIDDEN (with note) / DEFERRED.

## A. Quick wins — low risk, do in this review phase

| # | Decision | Recommendation | Blast radius | Status |
|---|---|---|---|---|
| A1 | `agentStatusBadge` vs `brandChipBadge` byte-identical maps (status-colors.ts) | Collapse to `brandChipBadge`, re-point imports | code dedup, zero pixels | APPROVED — done 5ecc0f9e4: `agentStatusBadge` had ZERO importing call sites, so it was deleted outright (no re-pointing, no alias needed); `brandChipBadge` is the single map, `AgentBadgeColor` kept (subset of `BrandChipColor`) |
| A2 | Contrast-pair triplication (color-contrast.ts / worktree-branding.ts / ThemeContext.tsx) | One shared constant IF values are truly identical; verify per-pair first, keep semantically distinct ones separate | 3 files, zero pixels if identical | APPROVED — done 383460bb2: only `#f8fafc`/`#111827` is byte-identical across files → exported as `READABLE_TEXT_LIGHT`/`READABLE_TEXT_DARK` from color-contrast.ts, imported by worktree-branding.ts; ThemeContext's `#18181b`/`#ffffff` meta-theme-color pair, the DARK_BG/LIGHT_BG rgb-object compositing backgrounds, and worktree-branding's `#000000` parse fallback are semantically distinct → untouched |
| A3 | Project-color fallbacks `#6366f1` / `#64748b` (14 sites) | Two semantic tokens (`--project-seed`, `--project-none`) — file pattern shows two intents | rename-only, zero pixels | APPROVED — done 7e3e59db2: pure rename `--hex-6366f1`→`--project-seed` (7 sites) and `--hex-64748b`→`--project-none` (9 sites incl. ActivityCharts 'backlog') + index.css definitions, values unchanged |
| A4 | Test-file hardcoded hex (56 sites) | Leave alone; update lockstep only when asserted values actually change | none | APPROVED — policy adopted, no code change |
| A5 | `FileViewerSheet` half-migrated `var(--paperclip-code-highlight-*, fallback)` | Mint the two vars in index.css at the fallback values (identical pixels today; makes the intended token real) | 1 file | APPROVED — done 7929aabeb: both vars minted in the extracted-tokens :root block at exactly the former fallback values; chose to SIMPLIFY the Batch 4 `--code-highlight-*-resolved` wrappers to plain `var(--x)` (fallbacks now redundant; nothing sets the vars at runtime); FileViewerSheet.tsx call sites unchanged |
| A6 | "Liveness blue" chat bubble reusing `--status-task-in_progress` (semantic coincidence) | Decouple: mint `--liveness-blue` with same value so a future status-hue change doesn't drag the chat bubble along | 2 sites, zero pixels | APPROVED — done b76a7955a: `--liveness-blue: #2563eb` minted; IssueChatThread.tsx bubble class + IssueChatThread.test.tsx lockstep assertion re-pointed |

## B. Policy calls

| # | Decision | Recommendation | Status |
|---|---|---|---|
| B1 | One-off decorative gradients/shadows (5 production + UxLab; 38 arbitrary shadows, no `--shadow-*` tokens existed) | Allowlist as documented "intentional one-off decoration" (extend allowlist criteria beyond third-party); DELETE the ~20 never-reused singleton `--gradient-extract-*` tokens back to inline, keep only reused ones. Spirit over letter of principle 2 | APPROVED — middle path, executed: 27 demo-only tokens reverted inline (19 gradients: --gradient-extract-5,6,8-24; 8 shadows: --shadow-extract-15,16,17,19-23 — all consumed solely by *UxLab.tsx pages), 35 call sites restored to original bracket literals, definitions deleted, 4 UxLab pages allowlisted + criteria doc-comment extended to first-party intentional decoration. KEPT 22 production tokens (gradients 1,2,3,4,7,25,26 + 15 shadows) — NOTE: --shadow-extract-4/5 kept contrary to the audit's first cut because ChatComposer.tsx and IssueChatThread.tsx (production) consume them, not just ChatComposer.test.tsx |
| B2 | Tailwind palette classes (`bg-red-500` etc.) — 3,115 sites / 145 files | Own future run (Run 4): cluster-by-cluster mapping to semantic tokens, starting with status-adjacent colors; NOT wholesale now, NOT permanent exemption. Update DESIGN.md principle 2 to name palette classes explicitly | APPROVED — own Run 4 later |
| B3 | Micro type cluster 9–15px (730 sites) + letter-spacing 9 values (202 sites) | Adopt PRIOR-ART named ladder (map 9→10 nano, keep 10/11/12/13/14; 15→14; tracking → 3 steps) via contact-sheet review — executed in the preset-tune session, decided now | EXECUTED (pending contact-sheet) — scripts/codemod-type-ladder.mjs (idempotent, committed): 730 font-size sites -> --text-nano (10px, incl. 9->10) / --text-micro (11px, incl. 0.7rem) / text-xs (12px) / --text-compact (13px) / text-sm (14px, incl. 15->14); 202 tracking sites -> --tracking-label (0.08em) / --tracking-eyebrow (0.14em) / --tracking-caps (0.2em); all --fs-* and --ls-* definitions deleted. NOTE: text-xs/text-sm sites also pick up Tailwind scale line-height (contact-sheet reviewable). PRIOR-ART "sm 13" tier renamed --text-compact (name collides with Tailwind text-sm=14px) |
| B4 | Radius conflict (`--radius-lg/xl` = 0px vs stock 2xl/3xl) | Defer to preset session — it's a brand question. Candidate: PRIOR-ART monotonic 6/8/10/14/16 | DEFERRED to preset session |
| B5 | Chart palette vs canonical status hues (ActivityCharts in_progress = violet, elsewhere blue) | Re-point charts at `--status-task-*` (operator learns one vocabulary — DESIGN.md P5). Visible change → contact sheet | APPROVED & CLOSED — user approved on before/after contact sheet (Jul 6); 2 chart snapshots re-baselined, suite 510/510 on new baseline. Known trade documented: To-Do amber vs priority-Medium amber adjacency, revisit at preset session |

## C. Component calls (from COMPONENT-INVENTORY.md §6)

| # | Decision | Recommendation | Status |
|---|---|---|---|
| C1 | ChatComposer vs MarkdownEditor split | Keep split; document as deliberate in COMPONENT-INVENTORY | APPROVED — keep split, documented deliberate (user re-confirmed after visual review) |
| C2 | FileTree vs WorkspaceFileBrowser parallel tree models | Investigate data-shape needs in Run 3; refactor onto FileTree only if shapes align | APPROVED — investigate data-shape needs in Run 3 prep |
| C3 | Entity-picker family (4 components) | Prop-by-prop diff as Run 3 prep task; no merge without it | APPROVED — prop-by-prop diff as Run 3 prep task; no merge without it |
| C4 | Finance card family (5 components) | Keep; revisit only if a 6th appears | APPROVED — keep all five; revisit only if a 6th appears |
| C5 | Hand-rolled cards (~26 files) → `Card`; pills (~34 files) → `Badge` | Run 3 shadcn-swap list, per-site snapshot verification | DONE (Run 3, Jul 7) — C5a: ~30 files converted (Card supplies skin, sites keep interior layout; interactive `<button>`/`<Link>` cards, `<li>` rows, string props, and the chart tooltip carry `design-allow(card-pattern)` comments). Deltas sub-pixelmatch-threshold; manual evidence in run3-review/c5a-card-conversions. **RESOLVED Jul 8**: Card now carries rounded-lg on the multiplicative ladder (see 'Radius scale codified'). C5b: 113 pill spans across ~45 files converted to Badge (+PropertyChip wraps Badge internally); StatusBadge/ExternalObjectStatusSummary/MatchSourceChip stay bespoke per C8/§5.1/domain-tokens with pointer comments. 22 stories re-baselined (+2px pill box, font-medium), triplets committed. |
| C6 | `plugins/launchers.tsx` overlay | Dedicated review task; exclude from Run 3 | APPROVED — dedicated review task, excluded from Run 3 |
| C7 | radio-card / toggle-switch custom primitives | Document as deliberate custom; skip swaps | APPROVED — documented as deliberate custom; skip swaps |
| C8 | StatusBadge not wrapping Badge primitive | Document as intentional exception (WCAG-tuned .status-chip mechanic) | APPROVED — documented as intentional exception (WCAG-tuned .status-chip mechanic) |
| C9 | Toast system (no shadcn primitive installed) | Keep custom toast; document as permanent choice (working tone/variant system; sonner migration = churn without user-visible gain) | DEFERRED to Run 4 — decide when toast palette colors get retokenized; sonner-behind-a-pushToast-facade is the alternative to evaluate |
| C10 | FeatureGate wrapper pattern (3 near-identical gates) | Nice-to-have shared primitive; backlog, not a run | APPROVED — backlog nice-to-have, not a run |
| C11 | Sidebar agents section: hand-rolled rows (own spacing/icon colors, palette-blue liveness dot) instead of `SidebarNavItem`; only section that is collapsible | Run 3 item: unify rows onto `SidebarNavItem`, settle collapsibility policy across sections, liveness dot → canonical status blue. Wholesale shadcn Sidebar adoption REJECTED for now (app already has equivalent machinery incl. icon-rail height trick; highest-regression chrome) — re-evaluate as a dedicated item after Run 3 only if its behaviors (kbd shortcut, persisted state, mobile sheet) are wanted | DONE (Run 3, Jul 7) — agent rows render via `SidebarNavItem` (new additive props: `iconNode`, `active`, `dense`, `trailing`, `liveAccessory`); all live dots (agents + nav rows, rail + expanded) now use `--status-agent-running` (#2563eb, was palette blue-500 #3b82f6 — small hue-darkening delta, per-C11 mandate; "N live" text keeps its palette classes for Run 4). **Collapsibility policy** (superseded Jul 8 by user review): EVERY labeled section (Work, Company, Projects, Agents) is collapsible, default-open, session-scoped state — one affordance everywhere. "See all agents" stays a plain muted Link on purpose (must not adopt active-route highlighting). 48 sidebar vitest assertions pass unchanged. |

## Gallery feedback round 1 (preset-tune session, Jul 6) — executed

User rulings from the tune-session gallery review; all intentionally visible, snapshots NOT re-baselined (fresh before/after triplets regenerated in tests/storybook-visual/test-results/ against the old baseline):

1. **Dark destructive red reverted** — `.dark --destructive` back to master's original `oklch(0.637 0.237 25.331)` (preset's softer `oklch(0.704 0.191 22.216)` rejected); light mode untouched.
2. **Budget/quota BAR FILLS reuse status colors** — moving-fill elements only: healthy → `bg-(--status-task-done)`, warning → `bg-(--status-task-todo)`, exceeded/hard-stop → `bg-(--status-task-blocked)` in BudgetPolicyCard.tsx, QuotaBar.tsx (feeds ProviderQuotaCard/BillerSpendCard pages), Costs.tsx, CodexSubscriptionPanel.tsx (escalation tiers only). Inspected and deliberately LEFT: Org.tsx status dot (not a bar), BudgetPolicyCard chip washes/notice borders (not fills), CodexSubscriptionPanel healthy `bg-primary/70` + null `bg-zinc-700` (healthy tier uses brand primary by design — flagged as ambiguous, not emerald).
3. **RUNNING = status blue, not cyan/teal** — IssueChatThread running chip now composes `brandChipBadge.blue` (layout classes unchanged); RunTranscriptView running label uses new `runningLabelText` export (`text-[#1D4ED8] dark:text-[#2563EB]`, hexes kept in lib/status-colors.ts for gate cleanliness); `statusBadge.running` + `agentStatusDot.running` maps and AgentDetail `runStatusIcons.running` re-pointed cyan→blue. Deliberately LEFT + flagged: `externalObjectStatusIcon/Badge.running` (same-map collision — `open` is already blue there; documented UX-spec tone system), and the cyan "Live" branding family (LiveRunWidget theme, AgentDetail live-card border + Live pulse dots, DesignGuide Live sample) — "Live" is a distinct motif from RUNNING chips; note AgentDetail's mobile Live pill is already blue, so a dedicated Live-color decision is recommended.

## Gallery feedback round 2 (preset-tune session, Jul 6) — executed

1. **BudgetIncidentCard light-mode legibility (pre-existing bug)** — the hard-stop card's eyebrow/title/description/banner used dark-tuned red-50/100/200 text with no light variants over the light pink gradient. Light mode now uses red-600..950-tier text (matching the app's existing `text-red-700 dark:text-red-300` light-red-surface pattern); dark classes preserved verbatim behind `dark:`. Sibling fix: BudgetPolicyCard statusTone chips (hard_stop/warning/ok) + its red banner had the same dark-only text — same treatment. Gradient backgrounds (kept B1 tokens) untouched.
2. **Bar fills, remaining stragglers → status hues** — ClaudeSubscriptionPanel fillClass ("Current week Opus only" salmon red) and ProviderQuotaCard quota-window fills: red-400→`bg-(--status-task-blocked)`, amber/yellow-400→`bg-(--status-task-todo)`, green-400→`bg-(--status-task-done)`. Healthy `bg-primary/70` + null `bg-zinc-700` tiers unchanged (r1 ruling). Inspected, NOT a bar: BudgetSidebarMarker circular icon badge (left).
3. **Systematic cyan→status-blue liveness sweep** (~50 sites / 20 files; supersedes r1's "Live family left" note per user ruling): running-status tones (CommentThread, interrupt-handoff, runRetryState, AgentDetail run chip + status maps), live dots/pings (AgentDetail, OnboardingChat, ArtifactsPanel generating, ActiveAgentsPanel, IssueDetail Live pill, RunTranscriptView, IssueRunLedger live chip, DesignGuide sample), Live surfaces (LiveRunWidget theme, ActiveAgentsPanel Live-now box, AgentDetail live-card border), scheduled-retry family (IssueScheduledRetryCard, runRetryState, IssueRunLedger retry-pending), externalObjectStatus icon/badge `running` (now shares blue with `open`; liveness pulse differentiates — flagged), timeline "now" marker `#2dd4bf`→`#2563eb` (1.5px line vs `#5b9bf6` delegated bars, shape differentiates — flagged), and the liveness glow shadow tokens `--shadow-extract-1/11/14` value-edited `rgba(6,182,212,0.08)`→`rgba(37,99,235,0.08)` (kept-token VALUES changed, call sites unchanged).
   Deliberately LEFT (non-liveness cyan, one-line reasons): xterm terminal cursor (CompanyEnvironments — terminal chrome); `on_demand` invocation-source chips (AgentDetail x2 + DesignGuide sample — source tag, not liveness); CompanySkills "Includes assets" chip (content-type tag); CompanyImport renamed-file mono text x2 (rename annotation); BlockedReasonChip `recovery_required` (blocked-reason category); IssueRunLedger "Advanced" outcome + "Silence snoozed" tones (outcome/pause semantics, not live); UxLab decorative gradients (B1 allowlisted decoration).

## Gallery feedback round 3 (preset-tune session, Jul 6) — executed

1+2. **Toggle unification** — hunt found exactly ONE second switch implementation: `ToggleField` in agent-config-primitives.tsx (hand-rolled h-5 w-9 pill, `bg-green-600` track — the "other green"). It now renders the canonical `ToggleSwitch` (3da1bbcc5 capsule, on = `var(--status-task-done)`), same props/behavior/testid. All other named suspects (AgentConfigForm, Instance*Settings, RoutineDetail, PipelineSettings, story fixtures) already used ToggleSwitch; remaining `bg-green-600` hits are buttons, not tracks. Every switch now renders the one capsule + one green.
3. **Agent-status chips → canonical colors** ("Org snippets and quick scan identity" = StatusBadge in control-plane-surfaces story): `statusBadge` agent keys now route through `brandChipBadge` families (bordered brand chips): running → blue, idle → GRAY (was yellow tint), paused → amber, **active → green (no canonical agent status exists — user-ruled mapping to the brand green/done family)**; error already rides the shared run-status red. brandChipBadge block moved above statusBadge in status-colors.ts (declaration order). Org.tsx's hand-rolled status-dot ternary now routes through `agentStatusDot` (same hues + gains the blue running dot). Left: Companies.tsx company-status chip (company entity, not agent), AgentConfigForm "current" model tag (not a status).
4. **Dark-text-on-light-wash sweep** — the flagged BudgetPolicyCard banner was already fixed in round 2 (screenshot predated it). Systematic sweep (bare `text-{red,amber,emerald,sky,green,yellow,cyan}-{50..300}` without dark: protection): **58 sites fixed across 14 files** (Dashboard budget alert, BudgetPolicyCard remaining-amount, AgentConfigForm banners x3, AgentDetail banners/chips x9, ProjectDetail x3, CompanyAccess, IssueDocumentsSection x6, RoutineHistoryTab x11, DocumentDiffModal x2, PipelineItemBodyDocument x2, RoutineSaveBar, DocumentFrameHeader, OutputFileTile x3, CompanySkills x10) — pattern: 50→950, 100→900, 200→800, 300→700 in light + original behind `dark:`, opacity suffixes preserved. Verified-safe leftovers: InviteLanding x4 (dark-styled standalone page), SidebarNavItem badge + DocumentAnnotationLayer tail + DevRestartBanner (solid dark/colored bg or dark:-protected).

## Verification status (this review)

- `pnpm check:token-gates` — re-run independently: 3/3 CLEAN (468 files, 31 allowlist entries).
- `pnpm typecheck` + full `pnpm test:storybook-visual` — re-running independently (in progress).
- Eyeball-pass note: the Phase 0 baseline was captured at the master fork point before any change, and the suite compares current rendering to it at `maxDiffPixels: 0` — pixel-equality with master-at-fork is machine-proven; side-by-side Storybook remains available on request (`pnpm storybook` here + `-p 6007` on master).

## List-interaction parity policy (Run 3 follow-up, Jul 9 2026)

**Policy (human-directed):** the inbox and tasks lists render the same material (task rows, status icons, parent/child trees, workspace groups), so their interactivity is the same by default — hover treatment (rounded `bg-accent/50` band), hover-follows-selection with the pointer-moved guard, j/k + arrow-key traversal that includes group headers, ArrowLeft/ArrowRight collapse/expand on both group headers and parent tasks, and Enter to open. View-specific capabilities stay view-specific (inbox: archive/read shortcuts on the archivable tab; tasks: kanban view). New list surfaces should adopt this contract rather than invent their own.

## Baseline reconcile — Run 3 setup (Jul 7, 2026)

Fresh worktree from origin/master (3b16ac380) on `design/component-convergence`. The baseline-manifest archive is still unpublished (placeholder URL), so the 510 local baselines were seeded from the Run 1 worktree (`~/Projects/DEV/paperclip-design-simplify`, `tests/storybook-visual/__snapshots__/`, branch head 44ab1ad17) into gitignored `tests/storybook-visual/.snapshots/`. First run: 497/510 green; 6 stories (12 snapshots, both themes) diffed, each verified against a specific master commit that postdates the baselines, then re-baselined — nothing else touched:

- `pages-work-timeline--hour-zoom` / `--day-zoom` / `--with-human-activity` ← 59092e85d "[codex] Fix work timeline actor avatars (#9152)" (diff = actor avatar column only)
- `product-navigation-layout--board-chrome-matrix` / `--sidebar-icon-alignment` ← 83f5f5984 "[codex] Hide goals sidebar link behind experiment (#9189)" (diff = one sidebar row removed, rows below shift up)
- `ux-labs-converted-test-pages--issue-chat-review-surface` ← 6d103b835 (system-comment attribution), 696c694a5 + 4f5abf600 (IssueChatThread reply composer / recovery card) (diff = attribution rows + inline reply composer)

Post-reconcile verification: full suite 509 passed clean + 1 known-pattern parallel-load flake (`product-dialogs-modals--new-agent-external-invite [light]`, passed on retry), exit 0. Snapshot PNGs remain outside git by design; this entry is the durable record until the baseline archive publication flow exists.

## Status glyph size reverted to md (Run 3 review feedback, Jul 8 2026)

**Reverses PAP-243/PAP-245.** Task-row status glyphs in the inbox and tasks list standardize on md (16px); the lg (20px) enlargement is withdrawn after user review. IssueRow fallbacks and both lists' slots (the PAP-246 slot-override gotcha) now agree on md; the size tests that documented the lg decision were updated in lockstep. 10 stories re-baselined (run3-review/feedback-round-6).

## Radius scale codified (Run 3 review feedback, Jul 8 2026)

**Multiplicative shadcn ladder adopted, closing B4.** `--radius: 0.5rem` (8px) is the single anchor; sm/md/lg/xl/2xl/3xl/4xl = 0.6/0.8/1.0/1.4/1.8/2.2/2.6 x anchor (rounded-lg IS the anchor). Card now carries `rounded-lg`, and all card surfaces are unified on it: artifact cards (was 8px literal --rad-8, token deleted), skills tiles (was md), chart cards (already lg), the chat plan/interaction card shell (was sm — the "purple border follows the knob but isn't 8px" finding). Inputs/buttons stay at md (6.4px) — controls one step tighter than containers. Shadow decision still open (Design lab).

## Interactive-card pattern (Run 3 review feedback, Jul 7 2026)

**One Card, two modes.** The Card primitive is a static container by default; when the whole card is a click target it takes the `interactive` prop (ui/src/components/ui/card.tsx): `cursor-pointer` + quiet hover (border darkens to foreground/20, shadow lifts to md) + keyboard focus ring. Non-Card interactive cards (skills tiles in CompanySkills, artifact Link-cards) carry the same class recipe verbatim. Chosen over the louder accent-border/tint hover after user review. Cards whose *rows* are the click targets (Costs "By agent") keep the card boundary static — the affordance belongs to the row.

## Run 3 — component convergence — DONE pending review (Jul 7, 2026)

Executed on `design/component-convergence` (worktree focused-agnesi). Scope C2/C3/C5/C11 + AgentDetail story, per RUN3-PROMPT. Verification at close: token gates 3/3 CLEAN (also fixed the master regression in IssueRecoveryActionCard from 4f5abf600); `pnpm typecheck` green; `pnpm --filter @paperclipai/ui build` exit 0; ui vitest 2098/2098; visual suite 512/512 (510 prior + AgentDetail light/dark) against the updated local baseline. Remaining card/pill pattern matches all carry `design-allow(...)` inline comments (audited). Review materials: `doc/design/run3-review/` (C11 dot recolor, C5a corner/shadow pairs, 43 C5b triplets). Two sub-threshold facts a reviewer should know: (1) Playwright pixelmatch's 0.2 per-pixel color threshold means `maxDiffPixels: 0` tolerates low-contrast changes — the C11 dot recolor and C5a corner-squaring pass the suite without re-baselining; manual evidence committed instead. (2) The Card primitive has no rounded-* (square-era survivor) — converted cards render square; one `rounded-*` on card.tsx + re-baseline restores roundness everywhere if wanted.

## Tune session — CLOSED (Jul 6, 2026)

User approved the complete new design language via gallery v4 + live test drive on the :3300 worktree instance ("ship it"). Merged origin/master (12 commits; one conflict — upstream deliberately removed the Wakes-on-confirm chip, deletion accepted). 296 snapshots re-baselined; gates 3/3 CLEAN; typecheck green; final suite verification run against the new baseline. Remaining roadmap: Run 3 (cards/pills/C11 sidebar + investigations + AgentDetail story), issue→task rename run, Run 4 (palette classes + toast), ESLint ratchet.

## Decision cards flattened to two types (design session, Jul 29 2026)

**Five colour/icon vocabularies collapse to two, borrowed from the task status system.** User feedback on `/decisions`: the card types carried "several visual and categorizing inconsistencies". Figma reference — current `1148-1253`, proposed `1148-2169` (PCLP-Core). Every row now resolves to `blocking` (failed run, agent error, blocked dependency, recovery, budget) or `review` (approval, confirmation, review, join request), and each borrows a task status rather than declaring its own palette: blocking → `blocked` (red `CircleMinus`), review → `in_review` (violet `CircleDot`), rendered through `<StatusGlyph>` off `--status-task-icon-*`. `attentionTone`/`attentionToneStyle`/`TONE_STYLE` and the per-source `SourceMeta.icon` are deleted; source kinds keep their own *wording* only. Zero new tokens — the point is that the queue and the task list now share one vocabulary by construction (principle 5).

Also in the same change, per the proposed mock: the 4px left accent rail is gone (colour lives in the glyph); rows became `rounded-xl` cards spaced 16px apart; issue key + project moved up into a `/`-separated meta breadcrumb; the expand affordance became a bottom-left "See more"/"See less" button; and the expanded state lost its separately tinted/bordered drawer — note, gallery and resolver now flow in the card's own column.

Three deliberate deviations from the mock, each flagged to the user:

- **The card border stays.** The mock drops it, which reads correctly in dark mode (`--card` 0.205 on `--background` 0.145) but is fatal in light mode, where both tokens are `oklch(1 0 0)` — a borderless card would be invisible white-on-white. Kept `border border-border`; in dark mode it is `oklch(1 0 0 / 10%)` and barely perceptible, so the intended look survives.
- **Radius is `rounded-xl` (11.2px), not the mock's literal 12px.** 12 is off the multiplicative ladder codified Jul 8; minting a one-off token for a 0.8px delta would reopen B4 for nothing.
- **`IssueThreadInteractionCard` keeps its action bar internally.** The mock hoists those buttons out into the card footer beside "See less". That component is shared with the issue-thread surface, so hoisting would silently restyle the chat thread too — out of scope for a decisions-card change, and a separate call.

**Severity is no longer chrome.** The Critical/High badge (`severityBadge`, deleted) was a third colour vocabulary competing with the type colour — an orange HIGH chip next to a red error icon was exactly the reported inconsistency. Severity survives as a filter/group dimension in the toolbar, so nothing is lost, only relocated. `severityStyle` is left in place (dead but pre-existing; not this change's scope).

**Verb order is now fixed across states.** Collapsed and expanded rows both order verbs outline → destructive → affirmative, right-aligned, so the affirmative button sits in the same place whether or not a row is expanded (previously collapsed rows ran Approve/Reject/Request revision left-to-right and expanded rows ran Approve/Request revision/Reject, left-aligned). Per-row training moved from a header icon button into the row's overflow menu, matching the mock's header (recency + overflow only); the inline "Trained ✓" badge stays and remains the tested `onTrain` path, since Radix menu items are portal-mounted and this repo does not open them in jsdom.

## Decision-card follow-ups: task keys, self-blocking, stuck quicklook (design session, Jul 29 2026)

Three defects surfaced by the flattened cards, each fixed at its own layer.

**Task key missing on the rows most obviously about a task.** The meta breadcrumb read only `relatedIssue`, but the feed stores the task in two shapes: when the subject IS the task (review, blocked dependency) the identifier sits on `subject` and `relatedIssue` is null; when the subject hangs off a task (thread interaction) the task arrives as `relatedIssue`. `attentionTaskRef` (ui/src/lib/attention.ts) resolves both with one rule, preferring `relatedIssue` when both exist — it is the record the subject alone cannot describe — and returning null for rows genuinely unattached (hire approval, agent error) so they stay blank rather than borrowing a key. 1 of 17 seeded rows → 13. Still open, needs a server change: an approval can carry `subject.metadata.issueId` while `relatedIssue` is null, which reaches the client as a bare UUID with no key or href.

**Every blocked row claimed it was blocked by itself.** Both `blocker_attention` call sites in server/src/services/attention.ts fell back to the blocked task's own identity when no `blocks` relation was loaded — one hardcoded `{ id: issue.id, identifier: issue.identifier }` outright — so the UI rendered "PAP-23 — Blocked by PAP-23" for all eleven seeded rows. `resolveBlockingIssue` prefers the loaded relation, then a blockerAttention sample identifier, then null (the row falls back to its `whyNow` line, which is honest about not knowing). It also rejects a self-referential relation row as corrupt. The dedup key deliberately keeps its original fallback chain including the issue's own identifier: it is the identity dismissals are recorded against, and narrowing it would resurrect dismissed rows.

**Quicklook stuck open after expanding a row.** Reported as "the hover task card gets stuck and keeps displaying even when I hover off". Root cause is a self-sustaining loop in the shared `IssueLinkQuicklook`, not in the decision card: Radix returns focus to the trigger when a popover closes, and that link opens the quicklook `onFocus` — so every dismissal refocused the trigger, which reopened the card. Fixed by declining the focus hand-back (`onCloseAutoFocus` prevented, symmetric with the existing `onOpenAutoFocus`): a preview must not move focus in either direction. Added alongside it, a pointer-escape guard that closes on any pointer move clear of both boxes, since the only other close paths were `mouseleave` on trigger/content and no leave fires when the layout shifts an element out from under a stationary pointer. The guard needs both `:hover` and geometry to agree the pointer is gone before closing, so a resting pointer is never dropped, and exempts focus-opened quicklooks for keyboard users.

Separately, evidence thumbnails in an expanded card no longer carry a task quicklook at all (`disableIssueQuicklook`): `Link` upgrades any /issues/ href into a hover preview, which here popped a text card over the very screenshot being examined, and expanding a row mounts that gallery directly under the pointer.

## Card-level selection ring is keyboard-only (design session, Jul 29 2026)

User: "it seems weird that only cards with see more/less have a focus state and not the rest… disable focus state for decision cards but retain the focus state for each interactive component (within cards) for accessibility purposes."

The card-wide stroke was never a focus state — it is the **keyboard cursor**, marking the row that j/k, e, x and s act on. It leaked into mouse use because `handleToggleExpand` set the selection as a side effect of a click, and only expandable rows have a See more/less toggle to click. Hence the reported inconsistency: clicking one kind of card ringed it, and no other card could ever be ringed.

Fixed by tracking how the selection was made and drawing the ring only for a keyboard-driven one. Clicking still sets the selection, so keyboard actions continue to target the row you just used — it simply draws nothing.

**The ring is deliberately kept for j/k navigation** rather than removed outright, which the literal request would imply. Those keys dismiss and snooze the selected row; with no indicator an operator would be firing destructive actions at an invisible target. Flagged to the user as the one place the card-level state survives, and it is theirs to remove if they want it gone there too.

Focus states on everything inside a card are untouched: the See more/less toggle, decision verbs, the task key, the project link, evidence thumbnails and the row menu all keep their `focus-visible` rings.

## Decision card eyebrow: project dropped, "·" separator (design session, Jul 29 2026)

Per the proposed mock, the decision card eyebrow is now **decision kind · task key** and nothing else.

**Project identity left the card.** It cost the eyebrow's width on every row to repeat a fact the operator has usually just chosen — the queue filters and groups by project from the toolbar — and it competed with the task key, which is the identifier an operator actually navigates by. The project is still one click away on the task itself.

**The separator changed from "/" to "·".** The eyebrow started as a breadcrumb (kind / key / project), but with the project gone it is a flat list of two facts, not a hierarchy. A slash implies containment those two segments do not have; a middle dot just separates. `ProjectMeta` and its `ProjectTile` import were deleted from the row rather than left unused.

## Standard task preview card (design session, Jul 29 2026)

**`IssueQuicklookCard` restructured to the proposed mock, and this is now the app-wide standard** — every hover preview of a task renders it, so the same three rows appear in the same order everywhere:

1. meta — status glyph · task key [· project] …………… last activity
2. title
3. summary — first lines of the description

The meta row splits: identity left, recency pinned right. Identity leads because a preview answers "which task is this?", and a title alone does not. The status glyph switches from `StatusIcon` to `StatusGlyph`, so a preview speaks the same status vocabulary as the flattened decision cards and the task list.

**Status carries no word of its own.** An earlier revision of this card gave status a line under the title ("In review · 1d ago", in `foreground`); the final mock removes it and moves the timestamp up into the meta row, leaving the glyph to be the status — which is what the glyph already is on task rows and decision cards. That leaves shape and colour as the only visual signal, so the glyph is passed a `title`, rendering as `role="img"` with the status as its accessible name. The status stays available to a screen reader without spending a line, and a test pins that (the glyph must carry it and the visible text must not).

Three shapes the meta row holds, all specified by the mock:

1. **no project** — glyph, key, timestamp hard right; no separator is rendered
2. **project** — a "·", the tile and the name join the left group
3. **truncation** — a long project name ellipsizes; the key and the timestamp are `shrink-0`, so the two facts that identify the task survive at any width. Verified live: with a 47-character project name the key and timestamp hold their exact widths (39.7px / 36.1px) and only the name clips.

Two judgment calls:

- **The project tile is untinted.** `ProjectTile` supports a colour, and the decision card's old chip used it, but a preview is a quiet surface and the project colour would be the loudest thing on it. The mock shows a neutral tile, and `IssueAncestorProject` carries neither colour nor icon — so following the mock costs nothing and needs no new data. If the tile should ever tint, that is a server-side field addition first.
- **11px via `--text-micro`** for the meta row, matching the mock, rather than minting a token for the mock's literal values.

The other consumer, `IssuesQuicklook` (project workspace linked issues), inherits the new card automatically — which is the point of standardising it.

## Quicklook aligns to the trigger's text, not its box (design session, Jul 29 2026)

Radix aligns box to box, so `align="start"` put the preview's *left edge* on the trigger's left edge — leaving the card's text pushed right by the card's own border and padding, and visibly out of line with the task key that opened it.

`quicklookAlignOffset()` cancels that inset: **13px** — `p-3` (12px) plus the 1px border `PopoverContent` draws. Measured on the live card afterwards, the trigger's text sits at 353.61px and the card's glyph, title and description all sit at 353.50px — a 0.11px residual from the trigger's own sub-pixel position, i.e. aligned.

The offset follows the align prop (`start` negative, `end` the mirror, `center` zero) rather than being hardcoded to one direction, and both surfaces that render the standard card — `IssueLinkQuicklook` and `IssuesQuicklook` — now share `QUICKLOOK_CONTENT_CLASS` and this helper, so the preview is positioned identically wherever it opens.

The 13px is a derived constant with the border and padding written out as `12 + 1`, and a test asserts the shell still carries `p-3`, so the two cannot drift apart silently.

## First motion tokens, and the inert animate-in finding (design session, Jul 29 2026)

**Motion tokens minted.** Durations and easings were previously written inline at each call site in `index.css`. Four named values now exist, and both new animations consume them:

- `--motion-duration-enter: 160ms` / `--motion-duration-exit: 110ms` — exit is deliberately shorter: a thing appearing wants to be followed, a thing leaving just needs to get out of the way.
- `--motion-ease-out: cubic-bezier(0.16, 1, 0.3, 1)` — the curve the dialog max-width transition already used, promoted to the system. It decelerates hard at the end, which is what reads as "snappy" rather than "slow start".
- `--motion-ease-in: cubic-bezier(0.4, 0, 1, 1)` for exits.

**Decision-card disclosure.** See more / See less now animates height through Radix `Collapsible`, which measures the panel and publishes `--radix-collapsible-content-height`, so the card grows and shrinks to a real number instead of snapping. Measured on the live card: 0 → 65 → 98 → 114 → 121 → 125 → 128px over ~136ms. The Root carries `contents` so a collapsed row pays no flex gap for an empty wrapper, and Radix keeps the panel an empty `hidden` shell when closed — verified all 17 closed panels hold zero children, so no row runs a resolver behind a collapsed card.

**`animate-in` is dead CSS in this repo.** Chasing the quicklook's scale turned up that the shadcn `PopoverContent` class string (`animate-in`, `zoom-in-95`, `fade-in-0`, `slide-in-from-*`) resolves to nothing: those utilities ship with the `tailwindcss-animate` plugin, which is not a dependency and is not imported in `index.css`. A stylesheet scan found no `enter`/`exit` keyframes in the build. **This affects every shadcn surface in the app** — dialogs, dropdowns, tooltips, sheets all carry the same inert classes and have never animated.

Rather than add the plugin for one surface — which would newly animate every one of those surfaces at once, an app-wide visual change nobody has reviewed — the quicklook defines its own `quicklook-open` / `quicklook-close` keyframes. Adopting the plugin properly is worth its own run.

**Quicklook motion.** A shallow scale (0.96 → 1) plus opacity, anchored to `--radix-popover-content-transform-origin` so the card grows out of the task key that opened it rather than swelling in place. Verified live: `quicklook-open`, running, 160ms, ease-out, origin `0px 0px`.

Both animations are disabled under `prefers-reduced-motion: reduce`.

## Task eyebrow project reads as tile + name (design session, Jul 29 2026)

The task detail eyebrow showed a bare `Hexagon` outline glyph next to the project name — a shape used nowhere else for projects. It now renders `ProjectTile` at `xs`, matching the sidebar and Projects list.

Measured against the mock, every value matches and all of it resolves through tokens: 16×16 tile, 4.8px radius, `bg-muted` (`oklch(0.269 0 0)`, the mock's `#313131`), 10px folder icon, 4px gap, 2px/4px padding, 4px link radius, 12px `text-muted-foreground` (the mock's `#a1a1a1`).

**The tile stays neutral rather than taking the project colour**, which `ProjectTile` would do if passed one. The eyebrow already carries the status glyph's colour, and a second tinted swatch beside it competes with the one mark that means something. Project colour still identifies the project on project-native surfaces. This matches the direction #9574 took for the Decisions feed.

The seeded header (rendered from `headerSeed` while the issue loads) was updated in lockstep, so the eyebrow does not change shape when the real issue arrives.

## Collapsed-only content crossfades against the panel (design session, Jul 29 2026)

Adding the disclosure animation left a seam: the panel grew smoothly, but the content it *replaces* still popped out of existence in one frame. Two things never carry across the two states — the thumbnail strip, whose counterpart is the full gallery; and an inline row's footer, which the resolver takes over once expanded.

Both now ride an **inverse disclosure** (`open={!expanded}`) using the same keyframes and tokens as the panel, so the collapsed cluster shrinks and fades out while the panel grows and fades in. Verified live during a toggle: `decision-disclosure-close` running at 110ms on the cluster and `decision-disclosure-open` running at 160ms on the panel, in the same frame.

Exit being shorter than enter is what makes it read as a handoff rather than a blend — the outgoing content clears slightly ahead of the incoming.

**Only genuine swaps crossfade.** A non-inline row keeps one standing footer: its Open or Restore button and its toggle are the same control in both states, so it stays put rather than crossfading with itself. The inverse cluster is skipped entirely when a row has neither images nor an inline resolver (`hasCollapsedOnlyContent`), because an always-open empty wrapper would otherwise charge the card a 16px flex gap for nothing — the closed panel avoids this for free, since Radix marks it `hidden` and it drops out of flex layout.

`renderFooter({ compact })` renders the bar in either position. `compact` is false for the standing copy, so an expanded non-inline row does not show collapsed verbs beside the panel's own.
