# /goal Prompt — Design Language Simplification, Run 1 (v2)

Paste everything inside the code block below into Claude Code after typing `/goal`, from inside this worktree. Prerequisites already satisfied on this branch: DESIGN.md, PRIOR-ART.md, KNOWN-DUPLICATES.md at repo root; token-auditor + codemod-runner in `.claude/agents/`.

v2 changes vs v1: token destination corrected to `ui/src/index.css`; Phase 0 snapshot scope bounded; component consolidation (old Phase 3) and the issue→task rename REMOVED from this run (they become their own human-gated follow-up runs); DONE-WHEN expressed as runnable commands.

```
Refactor Paperclip's UI so every visual value flows through the single
existing token layer, with provably zero visual change, working in this
isolated git worktree. DESIGN.md at the repo root is the source of truth
for all design decisions; follow it exactly. Read PRIOR-ART.md before
auditing.

SETUP
You are already inside a dedicated git worktree on branch
design/token-extraction. All work happens here. Never touch master,
switch branches, create new worktrees, or modify other working trees.
Commit after each phase and in small, reviewable steps within phases,
with descriptive messages.

WORK IN PHASES, IN ORDER
Delegate Phase 1 to the token-auditor subagent and Phase 2 to the
codemod-runner subagent (defined in .claude/agents/). Handle Phase 0
yourself. Hand context between phases through the committed report
files, not conversation memory.

Phase 0 — Baseline (before changing ANY component):
- Set up Storybook visual snapshot testing (Storybook test-runner with
  image snapshots, or equivalent already-compatible tooling; Storybook
  lives at ui/storybook/, launched via `pnpm storybook`).
- Coverage scope: the shared primitives in ui/src/components/ui/ (add a
  minimal story for any of the ~24 that lack one) plus all existing
  stories under ui/storybook/stories/. Do NOT write stories for the
  ~277 feature components in this run.
- Commit passing baseline snapshots. Every later phase must keep
  snapshots matching this baseline.

Phase 1 — Audit (no code changes):
- Produce TOKEN-AUDIT.md at the repo root: every hardcoded
  color/spacing/radius/type/shadow value in ui/src/, its frequency,
  file locations, and near-duplicate clusters (e.g. 13/14/15px used
  interchangeably). Flag clusters for human review — do NOT merge them.
  Cross-reference the existing ~80 tokens in ui/src/index.css: for each
  hardcoded value, note whether it exactly matches an existing token.
- Produce COMPONENT-INVENTORY.md: all components, their variants, and
  suspected duplicates with evidence (similar props, similar rendered
  output, copy-pasted origins). Include a "shadcn candidates" section:
  (a) custom components duplicating an available shadcn primitive,
  (b) installed shadcn components drifted from the registry
  (npx shadcn@latest diff where available), (c) raw Radix/plain
  elements where an installed shadcn wrapper exists. For each, state
  the recommended replacement and expected visual impact.
  ALL consolidation and swap items are RECOMMENDATIONS ONLY — no
  merges, no swaps, no deletions in this run.

Phase 2 — Extraction (mechanical, via codemod):
- Token destination is ui/src/index.css (Tailwind v4; optionally a
  tokens.css imported by index.css). Do NOT create a parallel token
  source. Tokens that must be runtime-tunable go in a NON-inline
  @theme/:root block (inline @theme bakes literals).
- Where a hardcoded value EXACTLY matches an existing token, replace it
  with that token. Otherwise add a new token containing the audited
  value VERBATIM — no normalizing, rounding, or inventing a scale.
  Ugly values stay ugly; they are the audit.
- Write codemod scripts, committed to scripts/, that perform the
  replacements. Run them. Do not hand-edit values file-by-file.
- Third-party style overrides that cannot use tokens go on a documented
  allowlist in the token source, each with an inline comment saying why.

DONE WHEN (all verified in this worktree)
1. The snapshot suite passes against the Phase 0 baseline — zero
   visual change.
2. ui/src/index.css (plus any imported tokens.css) is the only token
   source; components consume values only through it.
3. rg gates pass: zero hex color literals, zero arbitrary
   px/bracket-value Tailwind classes, zero raw font-size declarations
   in ui/src/components/** and ui/src/pages/** outside the documented
   allowlist.
4. TOKEN-AUDIT.md and COMPONENT-INVENTORY.md exist, are current, and
   each has a "Needs human decision" section (even if empty).
5. pnpm build, pnpm typecheck, and pnpm build-storybook all exit 0.

GUARDRAILS
- Preserve rendered output exactly. If a replacement cannot be made
  without visual change, skip it and record it in TOKEN-AUDIT.md under
  "Needs human decision", and move on.
- No redesign, no layout changes, no new colors/typefaces, no component
  merges or deletions, no copy renames (including issue→task — that is
  a separate later run), no new dependencies beyond snapshot tooling,
  no server/app-logic changes.
- If reality conflicts with DESIGN.md, note the conflict in
  TOKEN-AUDIT.md instead of guessing.
- If a phase cannot be completed, stop and report rather than partially
  applying it.
```

## After the run (human steps)

1. Eyeball pass: `pnpm storybook` here and in the master tree (`-p 6007`), flip between tabs.
2. Read TOKEN-AUDIT.md; choose the real spacing/radius scale (PRIOR-ART.md has drafted rules to start from).
3. Tune tokens; snapshots now fail intentionally — the diff folders are your design-review contact sheet. This is also where the ui.shadcn.com/create preset lands, as token-value edits.
4. Review COMPONENT-INVENTORY.md; approve a merge list and shadcn-swap list → those become Run 2 and Run 3, each its own /goal.
5. Merge to master when satisfied (rebase first if master moved). Scrap path: `git worktree remove ../paperclip-design-simplify --force`.
