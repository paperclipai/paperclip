# /goal Prompt — Design Language Simplification, Run 1 (v3)

Paste everything inside the code block below into Claude Code after typing `/goal`, from inside this worktree. Prerequisites already satisfied on this branch: DESIGN.md, PRIOR-ART.md, KNOWN-DUPLICATES.md at repo root; token-auditor + codemod-runner in `.claude/agents/`.

v3: condensed under the /goal 4,000-character limit (v2 was 4,648 and got rejected). The paste block now carries only mission + DONE-WHEN + guardrails; the full phase spec lives in the "Phase spec" section below, which the run reads from this file on disk.

```
Refactor Paperclip's UI so every visual value flows through the single
existing token layer, with provably zero visual change, working only in
this git worktree on branch design/token-extraction. Never touch master
or other working trees. DESIGN.md at the repo root is the source of
truth; follow it exactly. Read PRIOR-ART.md before auditing. Execute
Phases 0-2 exactly as specified in the "Phase spec" section of
GOAL-PROMPT.md at the repo root (Phase 0 external baseline archive,
Phase 1 audit, Phase 2 codemod extraction), delegating Phase 1 to the
token-auditor subagent and Phase 2 to the codemod-runner subagent.
Commit after each phase and in small reviewable steps.

DONE WHEN (all verified in this worktree):
1. The Storybook visual snapshot suite passes against a Phase 0
   baseline that was captured BEFORE any component change and pinned in
   tests/storybook-visual/baseline-manifest.json — zero visual change.
   Baseline scope: primitives in ui/src/components/ui/
   (add minimal stories only for those) plus the existing stories in
   ui/storybook/stories/. No stories for the ~277 feature components.
2. ui/src/index.css (plus any tokens.css it imports) is the only token
   source and components consume visual values only through it; no
   parallel token source exists; runtime-tunable tokens live in a
   NON-inline block.
3. rg gates pass: zero hex color literals, zero arbitrary px/bracket
   Tailwind values, zero raw font-size declarations in
   ui/src/components/** and ui/src/pages/** outside the documented
   allowlist in the token source.
4. TOKEN-AUDIT.md and COMPONENT-INVENTORY.md exist at the repo root,
   are current, and each contains a "Needs human decision" section.
5. pnpm build, pnpm typecheck, and pnpm build-storybook all exit 0.

GUARDRAILS
- Preserve rendered output exactly. Reuse an existing token only on
  EXACT value match; otherwise mint a new token with the value
  VERBATIM — no normalizing, rounding, or inventing a scale. If a
  replacement cannot be made without visual change, skip it and log it
  under "Needs human decision".
- All value rewrites happen via codemod scripts committed to scripts/,
  never file-by-file hand edits.
- No redesign, no layout changes, no new colors/typefaces, no component
  merges or deletions (consolidation and shadcn swaps are
  recommendations-only in COMPONENT-INVENTORY.md), no copy renames
  (issue->task is a separate later run), no new dependencies beyond
  snapshot tooling, no server or app-logic changes.
- If reality conflicts with DESIGN.md, record the conflict in
  TOKEN-AUDIT.md instead of guessing. If a phase cannot be completed,
  stop and report rather than partially applying it.
```

## Phase spec (referenced by the goal — the run reads this from disk)

**Phase 0 — Baseline (before changing ANY component):**
- Set up Storybook visual snapshot testing (Storybook test-runner with image snapshots, or equivalent already-compatible tooling; Storybook lives at `ui/storybook/`, launched via `pnpm storybook`).
- Coverage scope: the shared primitives in `ui/src/components/ui/` (add a minimal story for any of the ~24 that lack one) plus all existing stories under `ui/storybook/stories/`. Do NOT write stories for the ~277 feature components in this run.
- Pack and publish the passing baseline snapshots through the external
  Storybook visual baseline flow, then commit the manifest metadata. Every
  later phase must keep snapshots matching this baseline.

**Phase 1 — Audit (no code changes; delegate to token-auditor):**
- Produce `TOKEN-AUDIT.md` at the repo root: every hardcoded color/spacing/radius/type/shadow value in `ui/src/`, its frequency, file locations, and near-duplicate clusters (e.g. 13/14/15px used interchangeably). Flag clusters for human review — do NOT merge them. Cross-reference the ~80 existing tokens in `ui/src/index.css`: for each hardcoded value, note whether it exactly matches an existing token.
- Produce `COMPONENT-INVENTORY.md`: all components, their variants, and suspected duplicates with evidence (similar props, similar rendered output, copy-pasted origins). Include a "shadcn candidates" section: (a) custom components duplicating an available shadcn primitive, (b) installed shadcn components drifted from the registry (`npx shadcn@latest diff` where available), (c) raw Radix/plain elements where an installed shadcn wrapper exists. For each, state the recommended replacement and expected visual impact. ALL consolidation and swap items are RECOMMENDATIONS ONLY.

**Phase 2 — Extraction (mechanical, via codemod; delegate to codemod-runner):**
- Token destination is `ui/src/index.css` (Tailwind v4; optionally a `tokens.css` imported by index.css). Do NOT create a parallel token source. Tokens that must be runtime-tunable go in a NON-inline block (`@theme inline` bakes literals).
- Exact-match values → existing token reference; everything else → new verbatim token. Ugly values stay ugly; they are the audit.
- Codemod scripts committed to `scripts/` perform the replacements; run them; no hand-edits.
- Third-party overrides that cannot use tokens go on a documented allowlist in the token source, each with an inline comment saying why.

## After the run (human steps)

1. Eyeball pass: `pnpm storybook` here and in the master tree (`-p 6007`), flip between tabs.
2. Read TOKEN-AUDIT.md; choose the real spacing/radius scale (PRIOR-ART.md has drafted rules to start from).
3. Tune tokens; snapshots now fail intentionally — the diff folders are your design-review contact sheet. This is also where the ui.shadcn.com/create preset lands, as token-value edits.
4. Review COMPONENT-INVENTORY.md; approve a merge list and shadcn-swap list → those become Run 2 and Run 3, each its own /goal.
5. Merge to master when satisfied (rebase first if master moved). Scrap path: `git worktree remove ../paperclip-design-simplify --force`.
