# Genesis Overlay — workflow

This is the Paperclip overlay for the Genesis Motion Design company (`instances/default/companies/4b7fd6fc-b920-430e-a3bd-defc09fc4326/`). It contains every Paperclip-side customization that Paperclip's `paperclipai/paperclip` upstream does not have: agent instruction bundles for the CEO/CTO/CMO/Coder/UXDesigner, the canonical Genesis safety guardrail, the deploy-gating safety library, and the regenerator script.

## TL;DR

Just say **"update paperclip"** and the agent loads `paperclip-overlay-update` and walks through the workflow.

| What you want to do | What to say |
|---|---|
| Update a Genesis safety rule / regenerate the overlay | "update paperclip" |
| Pull upstream Paperclip + rebase the overlay | "update paperclip — rebase onto upstream" |
| Verify the overlay is in sync | "update paperclip — check" |
| Add a new Genesis-touching agent | "update paperclip — add agent" |

For direct command-line work:

| What you want to do | Command |
|---|---|
| Update a Genesis safety rule | Edit `instances/default/companies/4b7fd6fc-b920-430e-a3bd-defc09fc4326/shared/GENESIS-WEBSITE-GUARDRAILS.md`, then `python3 scripts/sync-genesis-overlay.py --apply` |
| Edit a single agent's instruction file | Edit `instances/default/companies/4b7fd6fc-b920-430e-a3bd-defc09fc4326/agents/<agent-id>/instructions/AGENTS.md` (or `HEARTBEAT.md`, `BLOG-WORKFLOW.md`, etc.) directly. Don't re-run the sync script after — it would re-inline the canonical block (idempotent) but not your custom edits in the agent's role-specific section. |
| Add a new Genesis-touching agent | Add the agent's `instructions/AGENTS.md` with the BEGIN/END marker block, then re-run the sync script — it picks up new agents automatically. |
| Verify the overlay is in sync (CI gate) | `python3 scripts/sync-genesis-overlay.py --check` |
| Bring this branch up to date with upstream Paperclip | `git checkout master && git pull origin master && git checkout overlay/genesis && git rebase master` (resolve any conflicts in the `instances/` overlay by keeping the local overlay commit) |

## Branch layout

```
master                       ← tracks upstream paperclipai/paperclip exactly.
                               You rebase overlay/genesis onto this when upstream
                               moves. Local commits on master are merge-conflict bait.

overlay/genesis              ← every Genesis-side customization lives here.
                               One branch, one purpose. Rebased onto master.
                               Local-only — do not push upstream.

local-fixes-paperclip        ← historical branch from the JULY 21 incident
                               (orphan-FK activity_log fix). Surgical port is now on
                               master as a normal commit. Keep this branch as the
                               audit trail.
```

The `master` branch should **always** be byte-identical to `origin/master` (per the user's repo-hygiene rule — see Hermes `user` profile). Local Paperclip fixes that you want to keep get one commit on `master` (surgical port from `local-fixes-paperclip`), then you rebase `overlay/genesis` onto it.

## Layout under `instances/`

```
instances/default/companies/4b7fd6fc-b920-430e-a3bd-defc09fc4326/
├── shared/
│   └── GENESIS-WEBSITE-GUARDRAILS.md           ← CANONICAL source. Edit this.
├── agents/
│   ├── ee11ddca-…  ceo/
│   │   ├── instructions/
│   │   │   ├── AGENTS.md                       ← inlines canonical + CEO persona
│   │   │   ├── HEARTBEAT.md                    ← CEO oversight gates
│   │   │   ├── SOUL.md / TOOLS.md / VISION.md  ← CEO persona
│   │   │   └── PROJECT-INVENTORY.md
│   │   ├── life/      ← RUNTIME (gitignored)
│   │   └── memory/    ← RUNTIME (gitignored)
│   ├── 08c9660e-…  cto/
│   │   └── instructions/
│   │       ├── AGENTS.md
│   │       └── HEARTBEAT.md   ← Gates 1-11
│   ├── 2c367227-…  cmo/
│   │   └── instructions/
│   │       ├── AGENTS.md
│   │       └── BLOG-WORKFLOW.md   ← 10-item post-publish QA
│   ├── 190d1320-…  ux-designer/
│   ├── 11ec648f-…  coder/        (canonical AGENTS.md only)
│   ├── bacbeb57-…  coder/        (alternate, can drop if unused)
│   ├── 92587782-…  summarizer/   ← read-only built-in, no Genesis work
│   └── d4e904f7-…  reflection-coach/  ← read-only built-in, no Genesis work
```

## Canonical guardrail — how it reaches each agent

Every agent's `AGENTS.md` has a `<!-- BEGIN CANONICAL GENESIS GUARDRAILS -->` … `<!-- END CANONICAL GENESIS GUARDRAILS -->` block at the top. The block contains the full body of `shared/GENESIS-WEBSITE-GUARDRAILS.md`. **The Paperclip Hermes adapter reads the entry file (`AGENTS.md`) at run time and feeds it into the system prompt**, so the rules are physically present in every agent's prompt — the agent does not have to resolve a relative path to load them.

Editing model:
1. Edit `shared/GENESIS-WEBSITE-GUARDRAILS.md` (the canonical source).
2. Run `python3 scripts/sync-genesis-overlay.py --apply` — this copies the canonical body into every Genesis-touching agent's `AGENTS.md`, replacing only the marker block. The agent's role-specific section (READ-FIRST banner, gates, etc.) is preserved verbatim.
3. Commit the change: `git add shared/GENESIS-WEBSITE-GUARDRAILS.md agents/*/instructions/AGENTS.md && git commit -m "..."`.
4. `git push origin overlay/genesis` if you want it on the remote (this branch is local-only by default; you decide when to push).

For CI: add `python3 scripts/sync-genesis-overlay.py --check` to the pre-commit hook or the CI pipeline. Exit 1 means someone edited the canonical without re-syncing, or hand-edited an agent's AGENTS.md canonical block.

## Adding a new agent

1. Hire the agent through Paperclip's `paperclip-create-agent` skill.
2. Edit the agent's `instructions/AGENTS.md` and add the canonical marker block:
   ```
   <!-- BEGIN CANONICAL GENESIS GUARDRAILS (auto-prepended into this entry file by Hermes; canonical lives at ../shared/GENESIS-WEBSITE-GUARDRAILS.md) -->
   The rules below are loaded into your prompt as part of this agent entry file.
   They are the canonical source of truth for any task touching genesismotiondesign.com.
   If a rule below conflicts with anything else in this file, the canonical rules win.
   To change a rule, edit ../shared/GENESIS-WEBSITE-GUARDRAILS.md — DO NOT edit the inlined copy.

   ...full body of shared/GENESIS-WEBSITE-GUARDRAILS.md here...

   <!-- END CANONICAL GENESIS GUARDRAILS -->
   ```
3. Run `python3 scripts/sync-genesis-overlay.py --check` — it should report 1 more "unchanged" agent.
4. If the new agent is a read-only built-in (Summarizer, Reflection Coach) and does NOT touch Genesis, **do not** add the marker. Add the agent ID to the `SKIP_AGENTS` set in `scripts/sync-genesis-overlay.py`.

## Rebase onto upstream master

When `paperclipai/paperclip` ships new commits on `master`:

```bash
cd /volume2/Hailey/Hermes/workspace/paperclip
git fetch origin

# Update local master to track upstream exactly. If there are local
# commits on master (e.g., surgical ports), they should have been
# committed already as a regular commit before this step.
git checkout master
git pull --rebase origin master

# Rebase the overlay branch on top of fresh master.
git checkout overlay/genesis
git rebase master

# Most of the time the overlay commit applies cleanly because it only
# touches `instances/...` which is unique to us. If `AGENTS.md` or
# `HEARTBEAT.md` etc. diverged upstream, resolve by keeping the local
# overlay version and rerunning the sync script to verify it's still
# in sync with the canonical.
python3 scripts/sync-genesis-overlay.py --check
```

If the rebase produces conflicts in the overlay files:
- For `instances/...`: **always keep the local version**, then re-run the sync script.
- For `.gitignore`: review carefully — if upstream added a conflicting ignore rule for `instances/`, defer to upstream and re-tune locally.

## Touched files (canonical list)

Everything the overlay touches — keep this list updated when adding files:

| Path | Purpose |
|---|---|
| `.gitignore` | adds `instances/**/telemetry/`, `instances/**/data/workspace-operation-logs/`, `instances/**/agents/*/instructions/life/`, `instances/**/agents/*/instructions/memory/` so runtime data is never committed |
| `instances/default/companies/<id>/shared/GENESIS-WEBSITE-GUARDRAILS.md` | canonical safety guardrail |
| `instances/default/companies/<id>/agents/<id>/instructions/AGENTS.md` (×6) | per-agent instruction bundle |
| `instances/default/companies/<id>/agents/08c9660e/instructions/HEARTBEAT.md` | CTO 11 gates |
| `instances/default/companies/<id>/agents/ee11ddca/instructions/HEARTBEAT.md` | CEO oversight gates |
| `instances/default/companies/<id>/agents/ee11ddca/instructions/{SOUL,TOOLS,VISION,PROJECT-INVENTORY}.md` | CEO persona |
| `instances/default/companies/<id>/agents/2c367227/instructions/BLOG-WORKFLOW.md` | CMO publish + post-publish QA |
| `scripts/sync-genesis-overlay.py` | canonical → per-agent inlined copy regenerator |

## Sync script reference

```
$ python3 scripts/sync-genesis-overlay.py [--apply|--check]
```

Exit codes:
- `0` — all in sync (or dry-run)
- `1` — `--check` failed: at least one agent is out of sync OR missing the marker
- `2` — fatal: canonical file not found, or invalid args

Common workflow:
```bash
# After editing the canonical guardrail:
python3 scripts/sync-genesis-overlay.py            # preview the diff
python3 scripts/sync-genesis-overlay.py --apply    # write changes
git add -A && git commit -m "overlay: <what changed>"

# In CI / pre-commit:
python3 scripts/sync-genesis-overlay.py --check    # fails build if out of sync
```

## Skill (Hermes)

There is a Hermes skill at `~/.hermes/skills/devops/paperclip-overlay-update/` that captures this workflow as a step-by-step procedure. When you (the human or another agent) want to update the overlay, invoke that skill by name — `paperclip-overlay-update` — and it loads the operational workflow, the conflict-resolution playbook, and the one-shot wrapper script.

- `SKILL.md` — operational workflow (edit canonical → regenerate → verify → commit → rebase → push), 8 numbered steps
- `references/conflict-resolution.md` — rebase conflict playbook (6 scenarios with resolutions)
- `scripts/sync-and-deploy.sh` — one-shot wrapper that runs Steps 1-4

Companion skill (the underlying principle): `paperclip-agent-instruction-loading-model` at `~/.hermes/skills/devops/paperclip-agent-instruction-loading-model/`. That skill captures **why** the inline-canonical pattern works (only the entry file `AGENTS.md` is auto-loaded into the system prompt). This OVERLAY.md + the paperclip-overlay-update skill capture **how** to keep it working.

## Related server-side scripts (not in this repo)

These live on the Lightsail server at `/home/genesismotiondesign.com/lib/` and `/tmp/`. They are versioned by deployment, not by git:

- `/home/genesismotiondesign.com/lib/genesis-corruption-patterns.php` — single source of truth for the rn/xa0 corruption patterns. L1/L5 mu-plugins + fix-rn-corruption.php + install-rn-trigger.php all require_once this file.
- `/home/genesismotiondesign.com/lib/genesis-healthcheck-lib.sh` — shared bash helpers for the audit + healthcheck cron.
- `/tmp/fix-rn-corruption.php` — one-shot DB cleanup for rn/xa0 patterns.
- `/tmp/install-rn-trigger.php` — installs the L2 MySQL trigger.
- `/tmp/genesis-content-healthcheck.sh` — daily cron, runs L1+L2+L5+L6 checks.
- `/tmp/genesis-rn-audit.sh` — one-shot audit.
- `/tmp/genesis-safety.sh` — deploy guardrail library, sources from deploy scripts.
- `wp-content/mu-plugins/genesis-content-safety-guard.php` — L1 mu-plugin.
- `wp-content/mu-plugins/genesis-clean-blank-n.php` — L5 mu-plugin.
- `wp-content/mu-plugins/genesis-hide-broken-llm-boxes.php` — L6 LLM-box mu-plugin.

Reference skill (Hermes): `paperclip-genesis-incident-triage` — fast-triage decision tree for "site broken" reports.
