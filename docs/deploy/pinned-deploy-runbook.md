# Pinned deploy worktree — operator runbook

Issue: TSMC-19813 / parent TSMC-19809  
KB: TSKB0362, TSKB0019, TSKB0268

## Goal

Live control plane (`:3100`) runs from a **pinned** git worktree
`~/paperclip-deploy` at a recorded committed SHA. Agents continue editing
`~/paperclip` on `:3101` without reclaiming the primary port.

This runbook is for a **CTO-authorized maintenance window**. Implementation
tasks must not install launchd plists, reload agents, claim `:3100`, or migrate
the live database.

## Layout

| Surface | Path | Port |
| --- | --- | --- |
| Deploy (live) | `~/paperclip-deploy` | `3100` / runtime `13100` |
| Source (dev) | `~/paperclip` | `3101` / runtime `13101` |
| Receipts | `~/.paperclip/deploy/` | n/a |
| Deploy logs | `~/.paperclip/deploy/logs/` (outside replaceable tree) | n/a |

## Scripts (in source repo)

- `scripts/pinned-deploy-promote.sh` — fail-closed promotion + receipt
- `scripts/pinned-deploy-start.sh` — deploy launcher (not `launchd-start.sh`)
- `scripts/pinned-deploy-verify.sh` — `plutil` lint + port ownership report
- `scripts/pinned-deploy-snapshot-smoke.sh` — disposable DB / UQ fixture smoke
- Templates: `docs/launchd/ie.thinkstack.paperclip-deploy.plist.template`,
  `docs/launchd/ie.thinkstack.paperclip-source-coexist.plist.template`

## Mandatory gates (all must be green)

1. Candidate SHA is a committed object and ancestor of the approved branch (`live`).
2. `plutil -lint` on rendered deploy + source coexist plists.
3. Unique-index duplicate fixture rejects on a **disposable** database
   (`uq-fixture`).
4. `server/scripts/dev-watch-gate.mjs` in the candidate worktree.
5. `pnpm --filter @paperclipai/server typecheck` in the candidate worktree.
6. (Window) snapshot restore + migrate + boot + `/api/health` on disposable DB/port
   via `restore-migrate` when a dump path is provided.

Failed gate ⇒ **no** deploy pointer change (`promote-pointer` refuses).

## Dry-run (safe anytime)

```bash
cd ~/paperclip
./scripts/pinned-deploy-verify.sh lint
./scripts/pinned-deploy-snapshot-smoke.sh uq-fixture
./scripts/pinned-deploy-promote.sh rollback-drill

# Full dry-run against a committed SHA (creates candidate worktree; no live pointer):
./scripts/pinned-deploy-promote.sh full-dry-run <committed-sha>
```

## Live cutover sequence (authorized window only)

Prereqs: freeze source edits, active runs drained (default zero), CTO go/no-go.

```bash
export PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE=1   # dual control with CLI flag

# 1. Prepare + gates
./scripts/pinned-deploy-promote.sh full-dry-run <sha>

# 2. Optional production snapshot smoke (read-only dump + disposable restore)
export PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT=$HOME/paperclip-deploy.candidate
export PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP=1   # or set DUMP_PATH to existing -Fc
./scripts/pinned-deploy-snapshot-smoke.sh restore-migrate

# 3. Pointer only (still does NOT install launchd)
./scripts/pinned-deploy-promote.sh promote-pointer --allow-live-pointer

# 4. Install/reload plists manually from rendered templates
./scripts/pinned-deploy-verify.sh lint
# Render to a review dir:
PAPERCLIP_PINNED_DEPLOY_RENDER_DIR=/tmp/pinned-plists ./scripts/pinned-deploy-verify.sh lint
# Operator copies deploy plist + coexist source plist into ~/Library/LaunchAgents
# then bootstrap/kickstart deploy FIRST; only after :3100 healthy, reload source on :3101.

# 5. Acceptance
curl -fsS http://127.0.0.1:3100/api/health
./scripts/pinned-deploy-verify.sh ports
# Confirm receipt SHA == deploy HEAD == health version field when exposed
```

## Rollback

1. Stop deploy agent (do not leave :3100 empty longer than needed).
2. Move current `~/paperclip-deploy` aside; restore previous tree from
   `.paperclip-deploy.prev-*` or re-`worktree add` at `rollbackSha` from receipt.
3. Restore `~/.paperclip/deploy/current-receipt.json` to prior durable receipt.
4. Reload deploy LaunchAgent; verify `/api/health`.
5. Recover only documented affected runs.

Non-production rehearsal:

```bash
./scripts/pinned-deploy-promote.sh rollback-drill
# receipt: ~/.paperclip/deploy/drill/rollback-drill-receipt.json
```

## Hard prohibitions

- No `git pull` or moving branch tip as the live deploy tree.
- No `pnpm install` inside live deploy or source during the window
  (TSKB0362 worktree install hazard).
- No candidate migration against live DB name `paperclip`.
- No `PAPERCLIP_RECLAIM_PRIMARY` on the post-cutover source plist.
- Deploy launcher must refuse boot when HEAD ≠ receipt SHA.

## Independent audit

TSMC-19814 audits implementation + rollback drill evidence without performing
cutover.
