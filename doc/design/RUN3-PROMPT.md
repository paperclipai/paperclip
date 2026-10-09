# Run 3 — Component convergence: guide + /goal prompt

Executes the approved component-convergence scope from `DECISION-SHEET.md`: C5 (hand-rolled cards → `Card`, pills → `Badge`), C11 (sidebar agents rows → `SidebarNavItem`), C2/C3 (investigate-first items), plus the AgentDetail story coverage gap.

## Which directory?

**If PR #9134 has merged to master (preferred):** create a fresh worktree from the main checkout —

```bash
cd ~/Projects/DEV/paperclip
git fetch origin && git worktree add ../paperclip-run3 -b design/component-convergence origin/master
cd ../paperclip-run3 && pnpm install
```

**If #9134 is still open:** reuse the existing worktree (it has everything installed and the baselines present) on a stacked branch —

```bash
cd ~/Projects/DEV/paperclip-design-simplify
git checkout -b design/component-convergence
```

Either way: launch `claude` from inside that directory, type `/goal`, paste the block below. The session inherits DESIGN.md and these docs automatically.

## What to expect

- Mostly unattended, roughly a day. Unlike Run 1, small visible deltas are *expected* (a border tone here, 1px of padding there) — the guardrails force every one to be exported for your review and individually revertable.
- After the goal clears: open `doc/design/run3-review/` (before/after images for every story the run changed), skim, and revert any commit whose look you reject. Each conversion is its own commit.

## The /goal paste block

```
Converge Paperclip's duplicated hand-rolled UI onto the shared
primitives, per the approved scope in doc/design/DECISION-SHEET.md
items C2, C3, C5, C11. DESIGN.md is the source of truth; read
doc/design/CHANGING-THE-UI.md and doc/design/RUN3-PROMPT.md first.
Work only in this worktree/branch; never touch master. Small
reviewable commits: one component-conversion unit per commit.

SCOPE
1. C5a: every hand-rolled card container (rounded-* + border +
   bg-card pattern) in ui/src/components/** and ui/src/pages/**
   converts to the Card primitive, preserving layout and behavior.
2. C5b: every hand-rolled pill span converts to Badge (or the
   status-chip system where it encodes status), same preservation.
3. C11: SidebarAgents rows render via SidebarNavItem (keep agent
   status dot + wake affordances; dot uses --status-agent-running).
   Apply one collapsibility policy across sidebar sections and
   record it in DECISION-SHEET.md C11.
4. C2/C3: investigate (do not merge by default): C2 WorkspaceFileBrowser
   vs FileTree tree models; C3 the four entity pickers. Write verdicts
   with evidence into COMPONENT-INVENTORY.md. Execute a merge ONLY if
   the verdict is copy-paste drift with identical data shapes and the
   merge preserves behavior; otherwise document keep-as-is rationale.
5. Add a Storybook story for the AgentDetail page (realistic fixture,
   light+dark) so it joins the visual suite.

VERIFICATION DISCIPLINE (small visual deltas are EXPECTED)
- Before starting: run the suite once to confirm 510/510 green.
- Per conversion commit: run the affected stories; if pixels changed,
  copy each changed story's expected/actual/diff triplet into
  doc/design/run3-review/<story>/ and note the story ids + one-line
  justification in the commit message. Deltas must be small
  (primitive-level: borders, radii, padding) — a layout shift or
  color-meaning change means STOP that conversion, revert it, and
  record it under "Needs human decision" in DECISION-SHEET.md.
- A site that cannot adopt the primitive without breaking behavior:
  skip it, comment why inline, list it in the report.

DONE WHEN (all verified in this worktree)
1. rg finds no hand-rolled card-container or pill-span patterns in
   ui/src/components/** or ui/src/pages/** outside documented inline
   allowlist comments; converted sites import Card/Badge/SidebarNavItem.
2. C2/C3 verdicts written in COMPONENT-INVENTORY.md; C11 policy
   recorded in DECISION-SHEET.md.
3. AgentDetail story exists and renders in the suite.
4. pnpm check:token-gates 3/3 CLEAN; pnpm typecheck green;
   pnpm --filter @paperclipai/ui build exit 0.
5. Full visual suite passes against the updated baseline, and
   doc/design/run3-review/ contains the triplets for every story
   whose baseline changed, committed.
6. All vitest suites for touched components pass, assertions updated
   in lockstep where they referenced old markup/classes.

GUARDRAILS
- Preserve behavior exactly: props, handlers, a11y roles, test ids.
- No new dependencies. No palette-class conversions (Run 4's job).
- Never re-baseline a diff you cannot justify in the commit message.
- If a phase cannot complete, stop and report rather than partially
  applying it.
```

## After the run

1. Review `doc/design/run3-review/` — approve or `git revert` per commit.
2. Check the "Needs human decision" additions in DECISION-SHEET.md.
3. Merge (or stack the PR), then Run 4 (palette classes) and the ESLint ratchet are all that remain.
