# Pinned deploy worktree — operator runbook

Issue: TSMC-19813 / remediation TSMC-19815 / parent TSMC-19809  
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
- `scripts/pinned-deploy-snapshot-smoke.sh` — disposable DB, UQ fixture, and
  isolated disposable-port boot + `/api/health` + authenticated issue create/read
- Templates: `docs/launchd/ie.thinkstack.paperclip-deploy.plist.template`,
  `docs/launchd/ie.thinkstack.paperclip-source-coexist.plist.template`

## Mandatory gates (all must be green before pointer flip)

1. Candidate SHA is a committed object and ancestor of the approved branch (`live`).
2. Candidate has `.paperclip/.env` (linked worktree boot contract — intentionally empty defaults for deploy).
3. Candidate deps provisioned: `pnpm install --prefer-offline` plus
   `pnpm --filter @paperclipai/shared build` and
   `pnpm --filter @paperclipai/plugin-sdk build` (prevents missing-esbuild gate failures).
4. `plutil -lint` on rendered deploy + source coexist plists.
5. Unique-index duplicate fixture rejects on a **disposable** database
   (`uq-fixture`).
6. `server/scripts/dev-watch-gate.mjs` in the candidate worktree.
7. `pnpm --filter @paperclipai/server typecheck` in the candidate worktree.
8. **Window snapshot smoke** (when a dump is provided): restore into a disposable
   DB only → candidate migrate → migration-status → boot candidate on a
   **disposable port** (never `:3100`/`:3101`/`:13100`/`:13101`) → `GET /api/health`
   → authenticated issue create/read against that isolated candidate → drop
   **only** the disposable DB. Implemented by
   `./scripts/pinned-deploy-snapshot-smoke.sh restore-migrate`.

Failed gate ⇒ **no** deploy pointer change (`promote-pointer` refuses).

`prepare-candidate` writes the worktree env and runs the install/build steps
before gates. `promote-pointer` re-asserts `.paperclip/.env` on the staged tree
and again on `DEPLOY_ROOT` after the rename (TSMC-20021 cutover gaps).

### Receipt ordering (promotion)

`promote-pointer` writes transition metadata (`deployPointerMutated`,
`liveCutover`, `promotedAt`, receipt paths) onto the working receipt **before**
the durable receipt copy is finalized. The durable `receipt-<sha>-*.json` and
`current-receipt.json` both include the completed pointer-transition fields.

## Dry-run (safe anytime)

```bash
cd ~/paperclip
./scripts/pinned-deploy-verify.sh lint
./scripts/pinned-deploy-snapshot-smoke.sh uq-fixture
./scripts/pinned-deploy-promote.sh rollback-drill

# Optional: boot/API harness self-check with HTTP stub (no live ports, no dump)
PAPERCLIP_PINNED_DEPLOY_BOOT_STUB=1 \
  ./scripts/pinned-deploy-snapshot-smoke.sh boot-api

# Full dry-run against a committed SHA (creates candidate worktree; no live pointer):
./scripts/pinned-deploy-promote.sh full-dry-run <committed-sha>
```

## Live cutover sequence (authorized window only)

Prereqs: freeze source edits, active runs drained (default zero), CTO go/no-go.

```bash
export PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE=1   # dual control with CLI flag

# 1. Prepare + gates
./scripts/pinned-deploy-promote.sh full-dry-run <sha>

# 2. Production snapshot smoke (read-only dump + disposable restore + boot/API)
export PAPERCLIP_PINNED_DEPLOY_CANDIDATE_ROOT=$HOME/paperclip-deploy.candidate
export PAPERCLIP_PINNED_DEPLOY_ALLOW_LIVE_DUMP=1   # or set DUMP_PATH to existing -Fc
# Optional: PAPERCLIP_PINNED_DEPLOY_SMOKE_PORT=<free high port>
./scripts/pinned-deploy-snapshot-smoke.sh restore-migrate
# Expect receipts under ~/.paperclip/deploy/receipts/:
#   last-restore-migrate.json, last-boot-api-smoke.json, last-migration-status.json

# 3. Pointer only (still does NOT install launchd)
./scripts/pinned-deploy-promote.sh promote-pointer --allow-live-pointer
# Confirm durable receipt has deployPointerMutated=true and promotedAt set
# OR use the sanctioned single door (pointer + deploy LaunchAgent kickstart):
# ./scripts/pinned-deploy-promote.sh promote-and-restart --allow-live-pointer

# 4. Install/reload plists manually from rendered templates
# (skip if you used promote-and-restart and the deploy label was already loaded)
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

### Snapshot smoke details (step 2)

| Step | Behavior |
| --- | --- |
| DB name | `paperclip_promote_smoke_<ts>_<pid>` only |
| Dump | `PAPERCLIP_PINNED_DEPLOY_DUMP_PATH` or read-only `pg_dump` of live name when `ALLOW_LIVE_DUMP=1` |
| Migrate | candidate `packages/db` migrate + migration-status against disposable DB URL only |
| Boot | isolated `PAPERCLIP_HOME` + disposable `PORT`; banned live ports |
| Health | `GET /api/health` until `status=ok` or timeout |
| API | local_trusted board actor (or cookie session if deploymentMode=authenticated): create issue + read back |
| Cleanup | terminate smoke server; `DROP DATABASE` only for the disposable name; never `paperclip` |

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
- Snapshot smoke must never bind or kill `:3100`/`:3101`/runtime pair.

## Tests

```bash
cd ~/paperclip
node --test scripts/__tests__/pinned-deploy-promote.test.mjs
```

Covers: plist lint, fail-closed promote, successful temporary-pointer durable
receipt metadata, rollback drill, UQ fixture, missing-dump refusal, disposable
boot/API smoke (stub), restore-migrate+boot path (stub), cleanup safety contract.

## Independent audit

TSMC-19814 audited the initial implementation and requested the boot/API smoke
and receipt-ordering hardening delivered under TSMC-19815. Cutover remains a
separate CTO-authorized window on parent TSMC-19809.
