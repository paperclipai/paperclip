---
name: design-session
description: >
  Run a design-feedback session on Paperclip's UI: the user says what looks
  off, the agent makes token-first changes and proves them with live
  before/after screenshots on an isolated worktree instance (server + UI +
  own DB). Use to iterate on Paperclip's visual design; ship via pr-to-green.
---

# Paperclip design session

You are the hands for a design-feedback session. The user describes outcomes ("that amber is too loud", often with screenshots); you translate each one into the smallest correct change — a token edit or a shared-component edit, never a one-off style — and prove it visually before calling it done.

This skill assumes you are running inside a checkout of the Paperclip repo (usually a git worktree dedicated to the session).

## 0. Read the rules first

Before touching anything, read:

1. `DESIGN.md` (repo root) — design principles and the token-only rule.
2. `doc/design/CHANGING-THE-UI.md` — the field guide: tokens → components → screenshots, recipes, and the everyday verification loop.

Load alongside the repo's `design-guide` skill (component/token conventions). If your harness also ships a `frontend-design` skill (a Claude Code built-in, not part of this repo), load it too for visual quality; skip it if absent.

Non-negotiables from those docs: visual values live in `ui/src/index.css` tokens; one component per job (check `ui/src/components/ui/` and `doc/design/COMPONENT-INVENTORY.md` before creating anything); no hex / raw px / arbitrary Tailwind values in components; forbidden moves are `shadcn apply --preset`, hardcoding a value because a token "doesn't fit", and ad-hoc fixes to scheduled-debt areas (palette classes etc. — see `doc/design/DECISION-SHEET.md`).

## 1. Environment: full isolated instance, never UI-only

The session runs on a **complete Paperclip instance** (server + UI + its own seeded database) so nothing touches the user's real data.

1. `pnpm install` at the repo root.
2. **Only if `.paperclip/config.json` is missing in this checkout**, initialize the worktree instance:
   - Pick a free server/DB port pair first: check sibling worktrees' `.paperclip/.env` files and `lsof -nP -iTCP -sTCP:LISTEN` for what's claimed, then pass explicit `--server-port` / `--db-port`.
   - Normal path: `pnpm paperclipai worktree init --force --seed-mode minimal --name <worktree-name> --server-port <port> --db-port <port>`.
   - Gotcha: if `pnpm paperclipai` isn't wired up in the worktree, use the main checkout's CLI runner (same trick as `scripts/provision-worktree.sh`):
     `node <main-checkout>/cli/node_modules/tsx/dist/cli.mjs <main-checkout>/cli/src/index.ts worktree init --force --seed-mode minimal --name <worktree-name> --from-config ~/.paperclip/instances/default/config.json`
3. Start it with **`pnpm dev` from the repo root** — never `cd ui && pnpm dev`, which serves the UI only and proxies API calls to the user's primary instance (their real data). Gotcha: if tsx dies with pipe/EINVAL errors, set `TMPDIR=/tmp`.
4. **Prove isolation before accepting feedback:** open the instance in a browser and screenshot it. The striped **WORKTREE banner** across the top is the proof you're on the isolated instance. No banner → stop and fix the environment.

Keep the server running for the whole session; hot reload shows your edits live.

## 2. The per-change loop

For each piece of feedback:

1. **Screenshot the current state** of the affected screen(s) — the "before".
2. **Make one small, focused change.** Prefer, in order: existing token value → new token → shared component edit. Mechanical rewrites across many files go through an idempotent `scripts/codemod-*.mjs` script, not hand-edits.
3. **Verify — all of these, every time:**
   - `pnpm check:token-gates` → must report **3/3 CLEAN**
   - `pnpm typecheck` → green
   - `cd ui && pnpm vitest run` → all passing (a test asserting an old literal value updates to the token form in the same change, with an explanation)
4. **Screenshot the "after"** and show the user the before/after pair. For token changes, spot-check other surfaces the token drives (its inline comment in `index.css` tells you which).
5. **Report in plain language** — what changed, where it's visible, what you verified. No code talk unless asked. Numbers, not claims ("gates 3/3, typecheck green, 2098/2098 tests").
6. **Record real design decisions** (a mapping, an exception, a deferral — anything judgment-shaped) in `doc/design/DECISION-SHEET.md` with one line of rationale.

**Storybook snapshots are deliberately NOT part of this loop.** Per the DECISION-SHEET entry "Per-change snapshot verification demoted to dormant (Jul 13 2026)", short-term drift is accepted; live screenshots are the visual proof. Do not run `pnpm test:storybook-visual` per change, and never re-baseline snapshots without explicit user approval. Still add a Storybook story for any new visual surface — stories are the coverage map for when full-rigor mode returns.

## 3. Session rules

- **User controls permanence.** Show before/after and wait for their verdict before moving on; if they say it's off, iterate — don't defend.
- **No push, no PR, no publishing** until the user explicitly asks. When they do, invoke the **`pr-to-green`** skill (`skills/pr-to-green/`).
- Commit locally in small, per-change commits so any single change can be dropped.
- If a request conflicts with `DESIGN.md`, say so and propose the compliant version (or a `DESIGN.md` change) instead of quietly diverging.

## Installing this skill for Paperclip agents

Claude Code picks this skill up automatically via the committed symlink in `.claude/skills/`. To make it available to Paperclip's own agents: Skills page → "Scan project workspaces" (or `POST /api/companies/:companyId/skills/scan-projects`), then enable it per agent in the agent's Skills tab. Repo skills surface under two keys (project-scan `local/<hash>/...` plus adapter-native `paperclipai/paperclip/...`), so a bare slug is ambiguous when enabling via API — use the full key, e.g. `paperclipai/paperclip/design-session`.
