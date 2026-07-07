# Running an AI-agent session against the design system

A guide for the *human* driving the session. You don't need to know the codebase — the system briefs the agent for you (AGENTS.md → `DESIGN.md` → `doc/design/`). Your job is to say what you want, look at pictures, and say yes or no. This document tells you how to do that well.

## The golden rule

**Describe outcomes, not implementations.** The whole point of the token system is that intent maps to small, safe changes:

- ✅ "Make all the running indicators the same blue as the status chips."
- ✅ "The smallest text in the sidebar is hard to read — bump it one step."
- ✅ "Corners feel too sharp. Round everything slightly."
- ❌ "Edit line 1899 of IssueChatThread.tsx" (you'll be wrong, and it doesn't matter — the agent finds the sites)

If your ask names a *feeling* ("too loud", "cramped", "inconsistent"), that's fine — expect the agent to translate it into a token change and show you the before/after to confirm the translation.

## Pick the session size

**Small (minutes) — a value change.** Colors, sizes, spacing, radius, one component's look.
> "In the Paperclip repo: make X look like Y. Show me before/after screenshots from the visual suite before you re-baseline anything."

The agent should: edit token(s) → run `pnpm test:storybook-visual` → show you the diff images → only after your yes, run `test:storybook-visual:update`, publish the packed baseline archive from a trusted maintainer environment, and commit the code change + manifest update together.

**Medium (an afternoon) — a retheme or a component-family restyle.** Ask for a **git worktree** so main stays untouched:
> "Create a worktree off master, apply shadcn preset `<CODE>` as token values only (values-only — review the CLI's diff, revert scaffolding), reconcile the Paperclip status/agent color tiers, then build me a before/after gallery of the key surfaces."

Review the gallery, iterate ("the dark red is too soft", "two different greens on toggles — one green"), then tell it to re-baseline and merge when you're satisfied.

**Large (a day, unattended) — a bounded autonomous run.** Use `/goal` with a *measurable* finish line — the evaluator needs conditions a command can verify, not aspirations:
> Good conditions: "rg finds zero palette classes in ui/src/components", "the snapshot suite passes against the pinned external baseline", "pnpm check:token-gates reports 3/3 CLEAN".
> Bad conditions: "the UI feels cleaner", "design is more consistent".

See `doc/design/GOAL-PROMPT.md` for a complete worked example (the run that built this system), including the phase structure and guardrails worth copying: work in a worktree, commit per phase, never re-baseline without human review, stop-and-report over partial application.

## What to demand from the agent (your checklist)

Hold every session to these five, regardless of size:

1. **Pictures before permanence.** Never approve on description. The suite produces before/actual/diff images for every changed story — ask for them ("show me these visually before I decide"). For subtle changes, ask for full-resolution images, not compressed thumbnails.
2. **Proof commands, not claims.** "Done" means: `pnpm check:token-gates` 3/3 CLEAN, `pnpm typecheck` green, suite result stated as a number ("510/510" or "N intentional diffs pending your review"). If the agent says done without these, ask for the outputs.
3. **Baselines ride with the change.** Intentional visual change → updated manifest metadata in the same commit, after the packed archive is reviewed and published. An agent that updates baselines to silence a failure it can't explain is the one thing you never accept.
4. **Mechanical changes via scripts.** If it's touching 20+ files with the same rewrite, it should write an idempotent codemod in `scripts/` (existing `codemod-*.mjs` files are the pattern), not hand-edit.
5. **Decisions get written down.** Anything judgment-shaped (a mapping, an exception, a deferral) goes in `doc/design/DECISION-SHEET.md` with one line of rationale.

## Reviewing like a designer

- **Contact sheet**: the diff images under `tests/storybook-visual/test-results/` are your primary review surface; ask the agent to assemble them into a browsable before/after page (or use `npx playwright show-report` from `tests/storybook-visual/`).
- **Live test drive**: for big changes, ask for a running instance from the worktree — `pnpm paperclipai worktree init` once, then `PORT=3300 pnpm dev:once` gives an isolated Paperclip (own database, own config; your real instance is untouched). Click around; real use surfaces what screenshots can't.
- **Side-by-side Storybook**: old on one port, new on another (`pnpm storybook` in each checkout), flip tabs.
- Trust your eyes over the agent's summary. If something looks wrong, say so plainly ("the text in the red boxes is illegible") — vague feedback is fine, the screenshots give the agent the precision.

## Safety rails (and the forbidden moves)

- **Worktrees for anything nontrivial.** Master is never touched until an explicit merge; the scrap path is deleting the worktree.
- **Pushing is a separate, explicit step.** Nothing goes to GitHub until you say push.
- Forbidden, always: `shadcn apply --preset` (overwrites components); re-baselining snapshots to hide an unexplained diff; hardcoding a value because a token "doesn't fit" (add the token instead); "fixing" the scheduled-debt areas ad hoc (palette classes, card/pill consolidation — see DECISION-SHEET).

## When something goes wrong

- **Suite fails and the agent didn't change visuals** → it broke something; the diff image shows where. Don't let it re-baseline.
- **A test fails asserting an old literal value** → lockstep case: the assertion updates to the token form, in the same commit as an explanation.
- **A story flakes under full-suite load** → have it re-run that story in isolation before treating it as real (three known flakes are documented in DECISION-SHEET).
- **The agent is stuck or looping** → ask for a status report with the three proof commands; completed phases are committed, so restarting a session loses almost nothing.

## The short version

Say what you want in plain language → agent turns it into token/component edits → you review before/after screenshots → you say "ship it" or say what's off → repeat. Every round today's system was built with took under an hour. That loop *is* the design workflow now.
