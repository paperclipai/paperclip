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

# 1. Fetch upstream, then compute the delta from the LEDGER's last integrated tip — NOT git merge-base.
#    Our integration PRs are squash-merged, so upstream/master is not an ancestor of master and
#    `git merge-base` resolves to a STALE tip → phantom conflicts. The ledger is the source of truth.
#    (Rationale + the NEO-522 deploy-train assessment: see "Computing the delta" below. NEO-565.)
git remote get-url upstream >/dev/null 2>&1 || \
  git remote add upstream https://github.com/paperclipai/paperclip.git
git fetch upstream

BASE_RANGE="$(node scripts/upstream-delta-base.mjs --range)"   # e.g. f12bb27bc..upstream/master
node scripts/upstream-delta-base.mjs --check                    # loudly reports squash drift vs merge-base
git log --oneline "$BASE_RANGE"                                 # the true, un-inflated upstream delta to triage

# Merge upstream. Keep history; resolve non-branding conflicts normally. The merge itself can still be
# `git merge upstream/master` — only the DELTA COMPUTATION above must be ledger-driven, not merge-base.
git merge upstream/master        # or: git merge <upstream-tag>

# 2. Reconcile the lockfile without running installs/build scripts.
pnpm install --lockfile-only

# 3. Re-apply the branding rename over the guarded surface (idempotent).
node scripts/check-branding-no-paperclip.mjs --fix

# 4. Verify the guard is green (this is exactly what CI will gate on).
node scripts/check-branding-no-paperclip.mjs
node scripts/check-branding-no-paperclip.test.mjs   # self-test of the guard

# 5. Record the integrated tip in the ledger (this is what keeps the NEXT run squash-safe), review the
#    codemod diff, commit, push, open the PR. The "Upstream tip integrated" you append MUST be the
#    upstream SHA you merged (git rev-parse upstream/master), so upstream-delta-base.mjs picks it up.
$EDITOR doc/upstream-fork-delta-ledger.md   # append a new "Integrated points" row with the upstream tip
git add -A
git commit -m "Sync upstream + re-apply Cortex branding (NEO-436/W3 guard)"
git push -u origin HEAD
```

Open the PR against `master`. The `branding-guard` job runs on the PR; **do not merge while it is red.**
**Squash-merge the integration PR as usual** — see "Computing the delta" for why we keep squash merges
rather than switching to `--no-ff` true merges.

## Computing the delta (squash-resilient) — NEO-565

**The next delta always starts at the ledger's last "Upstream tip integrated", never at `git merge-base`.**
`scripts/upstream-delta-base.mjs` is the single source of truth for that base:

```bash
node scripts/upstream-delta-base.mjs           # → the base SHA (last recorded upstream tip)
node scripts/upstream-delta-base.mjs --range   # → "<base>..upstream/master" (feed straight to git log)
node scripts/upstream-delta-base.mjs --check    # → base + compares vs merge-base; shouts on squash drift
```

**Why not `git merge-base`?** Integration PRs are **squash-merged** (the repo's default and the PR gate's
merge mode), so each integration lands as a single-parent commit on `master`. `upstream/master`'s history
is therefore *not* an ancestor of `master`, and `git merge-base <fork-line> upstream/master` keeps
resolving to the *previous* upstream tip. Computing the delta from it re-detects every already-integrated
commit as a **phantom conflict** (exactly what bit the 2026-07-18 → 2026-07-19 handoff). The ledger tip is
immune by construction: it records what we actually integrated, independent of git ancestry.

**Why not record ancestry (`git merge -s ours upstream/master`) or switch to `--no-ff` true merges?**
Both were assessed against the **NEO-522 weekly deploy train** and rejected: both inject upstream's *entire*
ancestry into the `master` line, and the deploy train enumerates each cut with `git rev-list/log <LKG>..<candidate>`
(`scripts/cortex-release-handoff.sh`, `scripts/cortex-deploy.sh`). Making upstream reachable from the master
line would inflate the cut's commit count and changelog by the whole upstream history — a real, undesirable
side effect. **Squash merges keep the deploy-train changelog clean; the ledger keeps upstream tracking correct.**
So we keep squash merges and drive the delta from the ledger (NEO-565 option 2).

**Regression guard.** `scripts/upstream-delta-base.test.mjs` locks the parsing (last dated row wins; prose
SHAs and merge-base are never selected) and the `--range` / `--check` contract. It runs in the
`test:release-registry` suite, so a future change that silently reverts to merge-base or breaks the ledger
parse fails CI. When in doubt, run `node scripts/upstream-delta-base.mjs --check` — a `SQUASH DRIFT DETECTED`
line is normal and means the guard is doing its job; a matching merge-base just means no squash happened that week.

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
