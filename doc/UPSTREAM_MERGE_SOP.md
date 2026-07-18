# Upstream Merge SOP — syncing `paperclipai/paperclip` into `Neoreef/paperclip` (Cortex)

**Owner:** Gene (DevOps/infra) · **Reviewer:** Werner (CTO) · **Approver:** Board
**Source:** NEO-436 (Phase 1 branding scrub) plan rev 6 `9d41d94c`, §6 · **Workstream:** W3 (NEO-440)

This SOP replaces the old manual *"branding sweep"* checklist line. Cortex is a fork of
`paperclipai/paperclip`: we keep every **internal contract** identical to upstream (env vars,
`@paperclipai/*` packages, filesystem/URL paths, wire headers, DB/namespace keys, code identifiers,
CSS classes, tests) so merges stay clean, and we rename only the **rendered / model-echoable brand
surface** (Buckets A/B/G/H-text) from *Paperclip* to *Cortex*. Every upstream sync re-introduces
brand text into that surface, so the rename is not a one-time event — it is a **standing merge step**,
enforced by the `branding-guard` CI job (`.github/workflows/pr.yml`).

## When to run

Any time you pull upstream into the fork: scheduled sync, cherry-pick of an upstream fix, or a
dependency bump that upstream authored.

## Procedure

```bash
# 0. Start from a clean fork checkout on an up-to-date main/master.
git switch -c sync/upstream-$(date +%Y%m%d) origin/master

# 1. Fetch + merge upstream. Keep history; resolve non-branding conflicts normally.
git remote get-url upstream >/dev/null 2>&1 || \
  git remote add upstream https://github.com/paperclipai/paperclip.git
git fetch upstream
git merge upstream/master        # or: git merge <upstream-tag>

# 2. Reconcile the lockfile without running installs/build scripts.
pnpm install --lockfile-only

# 3. Re-apply the branding rename over the guarded surface (idempotent).
node scripts/check-branding-no-paperclip.mjs --fix

# 4. Verify the guard is green (this is exactly what CI will gate on).
node scripts/check-branding-no-paperclip.mjs
node scripts/check-branding-no-paperclip.test.mjs   # self-test of the guard

# 5. Review the codemod diff, commit, push, open the PR.
git add -A
git commit -m "Sync upstream + re-apply Cortex branding (NEO-436/W3 guard)"
git push -u origin HEAD
```

Open the PR against `master`. The `branding-guard` job runs on the PR; **do not merge while it is red.**

## What the guard does / does not touch

| Reintroduced by upstream | Guard action |
|---|---|
| Rendered UI/CLI brand text (`ui/index.html`, `ui/src/**`, `cli/src/**`) — Bucket A | **rename** `Paperclip`→`Cortex` |
| Skill display names + bodies (`skills/**/SKILL.md`, `packages/skills-catalog/**/SKILL.md`) — B/G | **rename** |
| Agent onboarding / prompt templates (`server/src/onboarding-assets/**/AGENTS.md`, `packages/teams-catalog/**/AGENTS.md`, `evals/promptfoo/prompts/**`) — G | **rename** |
| PWA manifest name/description (`ui/public/site.webmanifest`) — H-text | **rename** |
| `PAPERCLIP_*` env, `@paperclipai/*` pkgs, `/paperclip` paths, `X-Paperclip-*` headers, `PaperclipConfig`/`usePaperclip*` identifiers, `.paperclip-*` CSS, `paperclip:` namespace/conn keys, test files | **frozen** — left byte-for-byte |

The rename is **case-preserving**: `Paperclip`→`Cortex`, `paperclip`→`cortex`, `PAPERCLIP`→`CORTEX`.
The detector is a **boundary-aware whole-word** match, so a brand word glued to any contract character
(`_ - / . @ ~`, or a letter/digit) is treated as a frozen contract and never rewritten. Two strong-contract
rules additionally freeze `paperclip:<key>` namespace keys and `…paperclip:paperclip@…` connection strings.

## Bucket H graphical assets (out of scope for `--fix`)

The codemod rewrites **text only**. Brand *glyphs* inside SVG/PNG icons and any asset whose **filename**
contains `paperclip` (e.g. `ui/public/paperclip-thinking.svg` → `cortex-thinking.svg`) are handled by
**W6 (NEO-443, Dieter)**, not this step. If an upstream sync changes those binary assets, flag W6.

## If the guard fails on something it should not

The guarded glob set and allowlist are the single source of truth in
`scripts/branding-guard-spec.mjs` (kept byte-identical to NEO-438/W1's `tools/guard-spec.mjs`). If a new
upstream file legitimately needs a different rule, do **not** hand-edit around the guard — update the spec
via a change to NEO-436/W1 so W1's inventory and this guard stay in lockstep, and get it reviewed by Werner.
