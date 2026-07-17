# cortex-beta — Deploy & Promotion Runbook

Status: Canonical operating runbook for the `cortex-beta` staging instance
Date: 2026-07-17
Issue: [NEO-530](/NEO/issues/NEO-530) (522e topology truth-up) · Supersedes the NEO-257 refresh runbook · Parent plan: [NEO-522](/NEO/issues/NEO-522#document-plan)

> **Branch hygiene (D8).** This document — and the deploy tooling, the `.gitmodules`
> plugin wiring, and the beta instance files it describes — lives on the **`cortex-beta`
> branch only**. `Neoreef/plugin-*` may be private and Paperclip's `master` is public-facing,
> so this wiring **must never be merged into public `master`**. See NEO-251 / D8.

> **What changed (2026-07-17, NEO-530).** The old runbook described a `pnpm beta:refresh`
> flow that built the **canonical agent-source tree** (`/home/ubuntu/.paperclip/instances/…/paperclip`)
> in place. That was wrong: beta has never run from that tree. It runs from
> **`/home/ubuntu/projects/cortex-beta`**, serves the server from **source** (`tsx`, no server
> build) and the UI from **`ui/dist`**. The stale `scripts/beta-refresh.sh` gated on a dead
> branch check and targeted the wrong tree — it never deployed beta. This runbook documents the
> verified reality and the pull-based **deploy agent** ([NEO-526](/NEO/issues/NEO-526), 522a)
> that replaces the manual refresh.

## 1. What cortex-beta is

`cortex-beta` is the **Staging** instance from `doc/DEV-PROCESS.md` §2: a longer-lived,
human-reachable instance for testing and guiding development of Cortex *and* its plugins
before changes are promoted to the live orchestrator. It is **not** the live control plane
and **not** a per-issue worktree.

| Property | Value |
|---|---|
| Public URL | `https://cortex-beta.neoreef.com` (Caddy → loopback) |
| Bind / port | `127.0.0.1:3200` (`HOST=127.0.0.1`, `PAPERCLIP_BIND=loopback`) — loopback/private, not internet-reachable except via Caddy |
| Supervision | `systemd` unit **`paperclip-beta.service`**, `WorkingDirectory=/home/ubuntu/projects/cortex-beta/server` |
| **Deploy tree** | runs **in place** from **`/home/ubuntu/projects/cortex-beta`** on branch **`cortex-beta`** (verified via `systemctl cat` + `/proc/<MainPID>/cwd`). **NOT** the canonical agent-source tree. |
| Server | runs from **source**: `ExecStart=pnpm exec tsx src/index.ts` — **no server build step** |
| UI | served **statically from `ui/dist`** (`server/app.ts` resolves `../../ui/dist`); rebuilt by `pnpm build` |
| Runtime env | `NODE_ENV=production` (⚠️ see caveat below) |
| Database | own embedded Postgres, **port 54330**, data under `~/.paperclip/instances/beta` |
| Auth | `PAPERCLIP_DEPLOYMENT_MODE=authenticated` + `PAPERCLIP_DEPLOYMENT_EXPOSURE=private` (login required) |
| Migrations | **auto-applied at boot** — `PAPERCLIP_MIGRATION_AUTO_APPLY=true`, `PAPERCLIP_MIGRATION_PROMPT=never` |
| Instance home | `PAPERCLIP_INSTANCE_ID=beta`, config under `~/.paperclip/instances/beta` |
| Plugin dir | isolated `~/.paperclip/instances/beta/plugins` (NOT live's `~/.paperclip/plugins`) (D6/D7) |
| MCP client | `PAPERCLIP_MCP_CLIENT_ENABLED=true` |

> **Load-bearing caveat — beta builds its own tree in place.** A deploy **rebuilds
> `/home/ubuntu/projects/cortex-beta` in place** (only `ui/dist` is a build product; the server
> runs from source). This is the single sanctioned exception to DEV-PROCESS Hard Rule #5, and
> the reason deploys run in **controlled windows** — the deploy agent serializes them. Because
> the unit exports `NODE_ENV=production`, `pnpm install` here **skips devDependencies**, and
> `NODE_ENV=production` also breaks Vitest's `act()` — **run any UI tests with `NODE_ENV=test`**,
> never in the deploy shell.

## 2. Deploy — the pull-based deploy agent (522a)

A deploy is **fast-forward `cortex-beta` to merged `origin/master` → build `ui/dist` →
restart → health-gate → content-verify**. It is performed by the **on-host deploy agent**
([NEO-526](/NEO/issues/NEO-526), 522a): `scripts/cortex-deploy.sh`, driven by a systemd timer
(`cortex-deploy.timer` → `cortex-deploy.service`, a `oneshot`) that polls `origin/master`.
It is **`journalctl`-observable** and needs no human in the loop for the merged-tip case.

The migrate step is performed by the **runtime at boot**: because the unit sets
`PAPERCLIP_MIGRATION_AUTO_APPLY=true`, every restart runs `applyPendingMigrations` against
beta's own DB (`:54330`). There is **no** separate `pnpm db:migrate` step, and (per the
hand-authored-migrations note, NEO-262) you do not run `drizzle-kit generate` here.

### What `scripts/cortex-deploy.sh` does, in order

1. `git -C /home/ubuntu/projects/cortex-beta fetch` and **fast-forward** the `cortex-beta`
   working tree to merged `origin/master` (**ff-only**; abort + alert on non-ff or a dirty tree).
2. `pnpm build` — produces **`ui/dist`** (the server runs from source via `tsx`, so there is no
   server build to consume).
3. `sudo systemctl restart paperclip-beta.service` — migrations auto-apply on boot.
4. **Health gate:** poll `http://127.0.0.1:3200/api/health` until `ok` (bounded); capture the
   last-known-good ref for rollback.
5. **Content-verify gate (522b):** run the tip's release probes via `scripts/verify-content.mjs`
   (see §5.2). **Green → keep. Red → auto-rollback** to the last-known-good ref, restart,
   re-verify, and alert.

### Observe / drive it manually

```bash
systemctl status  cortex-deploy.timer          # schedule + last run
systemctl start   cortex-deploy.service        # force a deploy now (oneshot)
journalctl -u cortex-deploy.service -n 200 --no-pager   # deploy logs
```

### Manual deploy (fallback if the agent is unavailable)

Deploy the same way the agent does, from the real tree. Do this only in a controlled window.

```bash
cd /home/ubuntu/projects/cortex-beta
git rev-parse --abbrev-ref HEAD               # expect cortex-beta (or the in-flight deploy branch)
git status --porcelain                        # must be clean — build is in-place
git fetch && git merge --ff-only origin/master
pnpm install                                  # NOTE: NODE_ENV=production skips devDeps in this shell
pnpm build                                    # rebuilds ui/dist (UI-only change: `cd ui && pnpm build`)
sudo systemctl restart paperclip-beta.service # migrations auto-apply on boot
curl -fsS http://127.0.0.1:3200/api/health    # expect {"status":"ok",...,"bootstrapStatus":"ready"}
node scripts/verify-content.mjs --base http://127.0.0.1:3200   # run the tip's probes (522b)
```

> **`scripts/beta-refresh.sh` is retired** — it targeted the canonical agent-source tree and
> gated on a dead branch check, so it never deployed beta. Its removal happens in
> [NEO-526](/NEO/issues/NEO-526) (522a); **do not** run `pnpm beta:refresh` / `beta-refresh.sh`.

## 3. Rollback

Rollback is built into the deploy agent: on a failed health or content-verify gate it
**auto-rolls-back** to the last-known-good ref, restarts, and re-verifies (§2 step 5). To roll
back manually to a chosen good ref:

```bash
cd /home/ubuntu/projects/cortex-beta
git stash            # or commit — checkout is non-forcing; clean the tree first
git checkout <last-good-ref>
pnpm install && pnpm build
sudo systemctl restart paperclip-beta.service
curl -fsS http://127.0.0.1:3200/api/health
node scripts/verify-content.mjs --base http://127.0.0.1:3200
```

If a **migration** (not just code) caused the failure, rolling code back does **not** undo an
applied migration: stop the service, restore the pre-deploy DB backup (below), then restart on
the rolled-back code.

```bash
# Point-in-time backup before a risky deploy (backups also run hourly via config, retention 30d):
PAPERCLIP_INSTANCE_ID=beta pnpm db:backup
```

## 4. Plugin-promotion procedure (validated submodule commit → live install bump)

Plugins are vendored as **git submodules** under `plugins/<name>` on the `cortex-beta` branch
(D6). Beta runs its *own* copies: `~/.paperclip/instances/beta/plugins/package.json` points
each plugin at the in-tree submodule folder via a `file:` dependency, fully decoupled from
the live install at `~/.paperclip/plugins`.

Promotion is the deliberate act of moving a **submodule commit you validated on beta** into
the **live** plugin install. It is **never an incidental side effect** of a deploy — it is a
governed, CTO-approved §5-style update, the same gate that governs promoting Paperclip itself.

### Procedure

1. **Validate on beta.** Bump the relevant submodule under `plugins/<name>` to the candidate
   commit on the `cortex-beta` branch, let the deploy agent (or a manual deploy, §2) pick it up,
   and exercise the plugin on `https://cortex-beta.neoreef.com`. Record the exact validated
   commit SHA (`git submodule status`).
2. **Open the governed update** (DEV-PROCESS §5 "Promotion to the live instance"): this is a
   discrete, CTO-approved operation, not a task side effect.
3. **Back up live first** — `npx paperclipai db:backup` against the live instance.
4. **Bump the live install ref** in `~/.paperclip/plugins/package.json` to the validated
   commit — a `github:Neoreef/plugin-<name>#<sha>` ref (or the live `file:` checkout advanced
   to that SHA). Use the **same SHA** validated on beta; never a moving branch ref.
5. Reinstall the live plugin dir and run the live promotion's `doctor --repair` + health
   check (DEV-PROCESS §5 / NEO-198 runbook).
6. **Rollback** = restore the previous `package.json` ref + backup, reinstall, health-check.

> Live and beta intentionally use different plugin-ref styles: live pins `github:…#<sha>`
> (public refs), beta uses `file:` into the in-tree submodules. Promotion translates a
> validated beta submodule SHA into the corresponding live `github:`/`file:` pin.

## 5. Verify — health + content probes

### 5.1 Health

```bash
systemctl is-active paperclip-beta.service                 # active
curl -fsS http://127.0.0.1:3200/api/health                 # loopback
curl -fsS https://cortex-beta.neoreef.com/api/health       # via Caddy
journalctl -u paperclip-beta.service -n 50 --no-pager      # boot + migration lines
```

A healthy response is `{"status":"ok","deploymentMode":"authenticated","deploymentExposure":"private","bootstrapStatus":"ready",...}`.

### 5.2 Content-verify probes — the per-issue probe convention (522b)

Health only proves the server is up; it does **not** prove your change is actually live. Beta
verifies **content/behavior, never SHA ancestry** — branches re-land the same work under new
SHAs, so commit lineage is meaningless. This is the guard that would have caught the Brand Kit
deploy gap (NEO-138 shipped code but never reached beta).

**Convention — add a probe with your PR.** Each issue that changes observable behavior on beta
ships a probe file at **`release-probes/<ISSUE>.yaml`** (e.g. `release-probes/NEO-521.yaml`).
A probe is one of three types, run by `scripts/verify-content.mjs` against the running instance
([NEO-527](/NEO/issues/NEO-527), 522b):

| Type | What it does |
|---|---|
| `bundle` | `curl <base>/…/<asset>` then grep for a required marker (e.g. `BrandKitPanel`) — proves the built UI carries your change. |
| `route`  | `curl <base>/api/<route>` and assert an expected shape/field — proves a server route is live. |
| `db`     | assert a migration/table/column/seed row **via the CLI** (never raw `psql` — Hard Rule #1) — proves a schema/data change applied. |

The deploy agent runs the full probe set as its post-deploy gate (§2 step 5); a red probe
triggers auto-rollback. To run probes by hand:

```bash
node scripts/verify-content.mjs --base http://127.0.0.1:3200            # all probes
node scripts/verify-content.mjs --base http://127.0.0.1:3200 --issue NEO-521   # one issue
```

Add your `release-probes/<ISSUE>.yaml` in the **same PR** as the behavior change so the pipeline
can prove your work landed. This is the contributor-facing half of the pipeline; the tooling is
introduced by [NEO-526](/NEO/issues/NEO-526) / [NEO-527](/NEO/issues/NEO-527).

## 6. Weekly canary + fleet train (522d / NEO-529) — supersedes ad-hoc promotion

The release model (NEO-522 plan §2.0) is: **review continuously on beta → once a week, promote
the approved+tested beta snapshot live.** The deploy agent (§2) keeps beta current; the **weekly
train** (`scripts/cortex-weekly-train.sh` + `cortex-weekly-train.timer`, fires `Mon 09:00`) cuts
the promotion. This is now the **only** sanctioned way a change reaches the live orchestrator —
one-off manual `git pull && build && migrate` on live is retired in favour of this governed,
rollback-wrapped train.

The train runs four stages, each independently rollback-capable:

1. **Preflight** — confirm the current beta snapshot is healthy + content-verified (reuses §5.2
   probes against `:3200`). A red beta aborts the train before anything else.
2. **CTO approval GATE** — nothing goes live without it. With no matching approval the train
   raises a `request_confirmation` to Werner and **halts**, changing nothing on live. Approval is
   materialized as a token holding the exact candidate SHA; it is **snapshot-scoped + single-use**
   (an approval for one snapshot can never promote a different one). The weekly timer re-raises the
   request on each un-approved firing until granted.
3. **canary** — promote the green snapshot onto **live** (`cortex.neoreef.com`, `:3100`) via the
   governed **DEV-PROCESS §5** path: `db:backup` **first** → checkout the exact snapshot SHA →
   `pnpm install && build` → `db:generate && db:migrate` → `doctor --repair` + health → content
   probes. Any failure auto-rolls-back the **code** (checkout last-known-good → rebuild → restart →
   health) and emits a first-class **ALERT** naming the pre-promotion backup for the DB restore
   (§5.4 / NEO-198 — code rollback alone does not undo an applied migration; there is no
   `db:restore` CLI, so DB restore stays the deliberate manual step).
4. **fleet** — cut stable npm `latest` (`scripts/release.sh stable`; publishes only when
   `CORTEX_FLEET_PUBLISH=1`, else `--dry-run`) and upgrade any remaining instances → verify →
   rollback on fail. With a single live instance today the ring is a **no-op**, but the machinery
   exists for future instances.

```bash
# Observe / drive manually (details: scripts/systemd/README.md)
scripts/cortex-weekly-train.sh --status      # candidate / approval / pending state
scripts/cortex-weekly-train.sh --preflight   # verify beta green; no live change
scripts/cortex-weekly-train.sh --dry-run     # full walk-through, no mutation
scripts/cortex-weekly-train.sh --request     # raise the CTO approval request; halt
# After Werner approves the specific snapshot SHA:
echo '<candidate-sha>' > /var/tmp/cortex-release-approval.token
scripts/cortex-weekly-train.sh --promote     # canary (§5 → live) + fleet
```

> **Guardrails.** The live orchestrator is never a direct build/migrate target: promotion only
> happens on the CTO-gated §5 path with a DB backup first, and the train refuses any live target
> that is non-loopback, a `*beta*` unit, or equal to the beta tree. Beta remains the single
> in-place-build exception (§2), owned by the deploy agent — never the train.

## 7. References

- `doc/DEV-PROCESS.md` — §2 Staging row points here; §5 governs the live promotion gate and
  cross-links this deploy agent as beta's single sanctioned in-place-build exception.
- Deploy tooling: [NEO-526](/NEO/issues/NEO-526) (522a `scripts/cortex-deploy.sh` +
  `cortex-deploy.timer`/`.service`; retires `beta-refresh.sh`).
- Content-verify gate: [NEO-527](/NEO/issues/NEO-527) (522b `release-probes/<ISSUE>.yaml` +
  `scripts/verify-content.mjs` + auto-rollback).
- Drift guard: [NEO-528](/NEO/issues/NEO-528) (522c done⇒on-beta reconciliation routine).
- Canary + fleet weekly train: [NEO-529](/NEO/issues/NEO-529) (522d — see §6; `scripts/cortex-weekly-train.sh` + `cortex-weekly-train.timer`/`.service`, §5-gated live promotion).
- Pipeline plan & decisions: [NEO-522](/NEO/issues/NEO-522#document-plan).
- Beta service topology: NEO-253 (systemd unit, isolated DB/plugins). Vendoring: NEO-251.
- Live promotion + rollback runbook: [NEO-198](/NEO/issues/NEO-198) (the §5 gate this reuses).
</content>
</invoke>
