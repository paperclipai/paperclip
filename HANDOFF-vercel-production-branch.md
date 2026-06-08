# Handoff → runtime/infra session: set Vercel Production Branch (push-to-deploy is not wired)

**From:** design/UI session · **Updated:** 2026-06-07 · **Priority:** HIGH — production is currently un-updatable

## TL;DR
The team switched to a **push-to-deploy** policy ("a push to `rebrand/valadrien-os` is the
deploy; don't run `vercel promote` anymore"). But the Vercel project setting that makes that
true was **never applied**. So right now:
- A push to `rebrand/valadrien-os` builds a **preview** (`target: null`), not production.
- Production (`os.valadrien.dev`) only ever moved via `vercel promote`.
- With `promote` now banned by policy, **nothing can update production** — it's frozen on the
  last promoted deployment. Pushed work builds green and then silently never ships.

**One fix:** set the project's **Production Branch = `rebrand/valadrien-os`**. Then a push
targets production and auto-aliases `os.valadrien.dev`. No promotes, no race, no freeze.

## Confirmed evidence (today, read-only inspection)
Project `valadrien-os-server` · `prj_GQOzJ3SG1yje5ze67ILqM35qHpdx` · team `team_HxifZfm9qyYJXqg21ZR8V4yo`

| What | Deployment | Commit | target | Serves os.valadrien.dev? |
|---|---|---|---|---|
| **Live production now** | `dpl_62qdtPT7` | `35f2a524` (runtime "agent-face eyes" fix) | `production` (via `action: promote`) | **Yes** (bundle `DOfV32Fm`) |
| **My push of HEAD** | `dpl_99K79eHF` | `f2741930` (design reconciliation) | **`null` (PREVIEW)** | **No** — git-branch alias only |

- My push (`git push origin rebrand/valadrien-os`, HEAD `f2741930`) triggered a `source: "git"`
  build that went **READY** — but `target: null`, so it's a preview. `os.valadrien.dev` was
  never re-pointed.
- Watched the live domain for ~6.5 min after the build went READY: bundle stayed `DOfV32Fm`
  (i.e. commit `35f2a524`) the entire time. Production did not move.
- Conclusion: this is **not** a promote-race (the earlier issue). It's that **pushes don't
  target production at all** — the Production Branch isn't set.

## The fix (project setting — infra owns this)
**Dashboard:** Project `valadrien-os-server` → **Settings → Git → Production Branch** →
set to `rebrand/valadrien-os` → Save.

**Or API/CLI:** set `git.productionBranch = "rebrand/valadrien-os"` on
`prj_GQOzJ3SG1yje5ze67ILqM35qHpdx` (team `team_HxifZfm9qyYJXqg21ZR8V4yo`).

After saving, trigger one production build from current HEAD — either push a tiny commit, or
in the dashboard **Redeploy** the latest commit **with "Production" target** (one-time, to
adopt the setting). Every subsequent push to the branch is then production automatically.

## Verification checklist (how you'll know it worked)
1. New deployment for the push shows **`target: "production"`** (not `null`).
   `GET get_deployment(<id>)` → `meta.githubCommitSha` == your pushed HEAD, `target: "production"`.
2. That deployment's `alias` array **includes `os.valadrien.dev`**.
3. `curl -s https://os.valadrien.dev/ | grep assets/index` → bundle hash **changes** from
   `DOfV32Fm` to the new build.
4. From then on: drop `vercel promote` everywhere. `git push` is the whole deploy.

## Why it's safe
- Only changes *how* production is selected (push-from-HEAD vs manual promote). No code change. Reversible.
- `origin/rebrand/valadrien-os` HEAD = **`f2741930`** already contains **everything** from both
  sessions (linear shared history) — the GLASSHOUSE in-company sweep (chrome, Dashboard, Agents,
  Issues, Costs + reconciliation) AND all runtime fixes. The first production build after the
  setting lands ships all of it at once.

## Current frozen state (no design-session action; I will NOT promote)
- Live production: `dpl_62qdtPT7` = commit `35f2a524` (does **not** include the last 2 design
  commits `45c88aa5` + `f2741930`).
- Those commits are safe on `origin` HEAD; they go live on the **first production build from
  HEAD** after this setting is applied. Nothing is lost — it just can't ship until then.

## Interim workaround (only if production must move before the setting lands)
Whoever owns deploys runs **one** `vercel promote <preview-of-HEAD>` (e.g. promote `dpl_99K79eHF`,
which is HEAD `f2741930`). That ships everything on HEAD in one shot. Then apply the setting so
no further promotes are needed. (Design session is holding per the no-promote rule.)
