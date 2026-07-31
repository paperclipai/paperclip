# Changing Paperclip's UI — a field guide

How to make visual changes now that the design system exists. Written for everyone: designers, engineers, and AI agents (AGENTS.md points here via DESIGN.md).

## The one-minute mental model

Paperclip's look lives in **three layers**, and you almost always work in the first one:

1. **Tokens** — every color, text size, spacing, radius, and shadow is a named value in `ui/src/index.css`. Change a token, and every surface using it follows.
2. **Components** — consume tokens, never raw values. One component per job (one Button, one Card, one ToggleSwitch).
3. **Screenshots** — live before/after screenshots of the affected screens, taken on an isolated worktree instance, are the proof of what a change looks like. (A 510-image Storybook baseline system also exists but is currently dormant as a per-change gate — see "Full-rigor mode" below and the DECISION-SHEET entry of Jul 13 2026.)

The rules live in [`DESIGN.md`](../../DESIGN.md) (repo root). The reasoning behind past decisions lives in [`DECISION-SHEET.md`](DECISION-SHEET.md). If you disagree with a rule, change `DESIGN.md` first (with review) — don't quietly diverge in code.

## The everyday verification loop

Per-change proof for a design change (this is what the `design-session` skill runs):

```bash
pnpm check:token-gates        # am I allowed to write this? (no hardcoded values — must be 3/3 CLEAN)
pnpm typecheck                # nothing broke structurally
cd ui && pnpm vitest run      # unit tests still pass
```

…plus **live before/after screenshots** of the affected screens on the isolated worktree instance. Storybook snapshot runs are *not* part of the everyday loop — short-term drift is accepted by policy (DECISION-SHEET, Jul 13 2026) until the baseline archive publication flow exists.

## Recipe 1 — change how something looks everywhere

*"Make the corners rounder." "That amber is too loud." "Bump the smallest text size."*

1. Find the token in `ui/src/index.css` (they're named and commented: `--radius`, `--status-task-todo`, `--text-micro`, …).
2. Change the value.
3. Look at it live: screenshot the affected screens on your worktree instance before and after, and review the pair (the token's inline comments and `ui/src/lib/status-colors.ts` tell you which surfaces to check).
4. Happy? Run the everyday loop above and commit the token edit. (In full-rigor mode this step is where snapshot re-baselining happens — see below.)

Notable single-knob tokens: `--radius` drives the entire corner ladder (sm→4xl are derived); the `--status-task-*` / `--status-agent-*` family is the app-wide status vocabulary (chips, charts, bars, live dots all follow it).

## Recipe 2 — retheme the whole app

The core palette follows the shadcn token names, so a theme built at ui.shadcn.com/create applies as token values:

```bash
cd ui && pnpm dlx shadcn@latest init --preset <CODE> --force --no-reinstall
```

Then **review the git diff and keep only the CSS-variable value changes** — the CLI also tries to rewrite `components.json`, `lib/utils.ts`, and add dependencies; revert those (it once deleted 240 lines of our utils). Never use `shadcn apply --preset` (it overwrites component files). After the token diff is clean: Recipe 1 steps 3–4 (a retheme touches everything, so screenshot a representative sweep: dashboard, a task list, a task detail, settings — both themes), plus a sanity pass on the Paperclip-specific tiers (agent gradients, WCAG-tuned status hues) for clashes.

## Recipe 3 — build or style a component

- **Values**: tokens only. No hex, no `text-[11px]`, no `p-[13px]`. If no token fits, **add a token** — that's a feature, not a workaround.
- **Type**: use the named ladder — `--text-nano` (10px) / `--text-micro` (11px) / Tailwind `text-xs` (12) / `--text-compact` (13) / `text-sm` (14). Letter-spacing: `--tracking-label` / `--tracking-eyebrow` / `--tracking-caps`.
- **Status**: anything that means running/idle/paused/error/todo/done/blocked uses the status system (`ui/src/lib/status-colors.ts` helpers or `--status-*` tokens). Liveness is always blue.
- **Primitives**: check `ui/src/components/ui/` and `doc/design/COMPONENT-INVENTORY.md` before writing a new component. Switches are `ToggleSwitch`; badges/chips route through `brandChipBadge`.
- **Give it a story.** New visual surface = new Storybook story. Stories remain the coverage map for full-rigor mode (below), so keep writing them even while snapshot gating is dormant.
- `pnpm check:token-gates` before you push. If a value genuinely can't be a token (third-party config, canvas fills, intentional one-off decoration on demo pages), it goes on the allowlist **with an inline comment saying why**.

## Full-rigor mode (currently dormant)

A 510-snapshot Storybook verification system exists (255 stories × light/dark, pixel-exact against a pinned baseline). It is **dormant as a per-change gate**: the baseline archive publication flow was never built — `tests/storybook-visual/baseline-manifest.json` is a placeholder, so the suite cannot run from a fresh checkout. Nothing was deleted; when the archive is published, the suite returns as an on-demand pre-release sweep and as the label-gated CI run (`storybook-visual` PR label). Everything below is kept verbatim for that revival.

```bash
pnpm test:storybook-visual    # what does my change look like? (diff vs baseline)
pnpm test:storybook-visual:update   # accept my intentional changes as the new baseline
```

**Rigor-mode Recipe 1 (steps 3–4):** `pnpm test:storybook-visual` — it will "fail" on every affected story. That's the point: each failure writes a before/actual/diff image triplet into `tests/storybook-visual/test-results/`. Review them (or `npx playwright show-report` from `tests/storybook-visual/` for a browsable version). Happy? `pnpm test:storybook-visual:update`, review the generated bundle under `tests/storybook-visual/baseline-review/`, publish it from a trusted maintainer environment, then commit the token edit **and** the updated manifest metadata together.

**Rigor-mode Recipe: snapshots failed.** That's the system working. Two cases:

- **You meant it** → review the diffs (they're your design review), then `pnpm test:storybook-visual:update`, publish the packed baseline archive, and commit the manifest update with the change. A PR with visual changes but no baseline-manifest update is incomplete; baseline changes with no explanation are a red flag.
- **You didn't mean it** → you broke something. The diff images show you exactly where. Do not update the baseline to make it green.

Three stories are known to flake under full parallel load (they pass in isolation — see DECISION-SHEET). Re-run a single story with `npx playwright test --config tests/storybook-visual/playwright.config.ts -g "<story name>"` before assuming a real failure.

## For AI-agent sessions

(Running a session as the human? See [`AGENT-SESSIONS.md`](AGENT-SESSIONS.md) — this section is instructions for the agent itself.)

The full session workflow — isolated worktree instance, per-change verification loop, reporting rules — is codified as the **`design-session` skill** (`skills/design-session/SKILL.md`); shipping the result as a PR is the **`pr-to-green` skill** (`skills/pr-to-green/SKILL.md`). Prefer invoking those over improvising.

This system was built to be steered by instruction. "Make all running indicators blue" or "collapse these three grays into one" should land as a token edit or a small codemod plus a snapshot diff — not a manual hunt. If a change is mechanical and touches many files, write an idempotent script in `scripts/` (see `codemod-*.mjs` for the pattern) instead of hand-editing. DESIGN.md is loaded via AGENTS.md; follow it exactly, and record consequential choices in DECISION-SHEET.md.

## What's deliberately not done yet (don't fix ad hoc)

- **Tailwind palette classes** (`bg-red-500`, ~3,100 sites) — scheduled for a dedicated cluster-by-cluster conversion pass; piecemeal fixes will collide with it.
- **Hand-rolled cards/pills → `Card`/`Badge`**, sidebar agents-section unification — queued as a component-convergence pass with per-site snapshot verification.
- **ESLint ratchet** — will eventually enforce the token rules at lint time; until then `check:token-gates` is the gate.

See `DECISION-SHEET.md` for the full ledger.
