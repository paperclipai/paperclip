# Handoff — fincli.ai CEO / board.fincli.ai / micro.fincli.ai

Saved: 2026-06-21T11:17:52+02:00
Hermes session: `20260621_111716_80a8c0` (`Citadel Clone Trading Pods #8`)
Primary repo: `/root/paperclip`
CPS repo: `/root/cps`
Micro addon repo: `/root/cli/micro-addon`

## Resume command after Hermes update

From a shell:

```bash
hermes update
hermes --resume 20260621_111716_80a8c0
```

If the exact resume id is not available, use:

```bash
hermes --continue
```

## Last verified state

Paperclip live API was reachable on `127.0.0.1:3110` after the latest changes.

Latest committed Paperclip work:

- `6566682 Route watchdog loops to durable incidents`
- `838d4d5 Surface noisy routine loops in CEO control room`
- `db0484f Add micro board review gate`
- `a6c8b58 Document micro agent handoffs and gates`
- `1d0814d Show micro registry on CEO dashboard`

Latest committed CPS work:

- `8a5f5033 Fix worker reap dry-run flag handling`

Hermes version before update:

- `Hermes Agent v0.16.0 (2026.6.5)`
- Update available: 541 commits behind; `hermes update` recommended.

## What was completed this session

1. Built the CEO / Citadel-clone operating structure in Paperclip around board.fincli.ai and micro.fincli.ai.
2. Added micro experiment registry visibility on CEO dashboard.
3. Added `/micro-board-review` page and board-review API action.
4. Added safe board-review decisions that only update registry state and do not authorize execution.
5. Investigated inbox/watchdog inefficiency.
6. Found repeated watchdog treadmill pattern:
   - `Local worker liveness check`: ~37 issues in 24h
   - `Market data feed liveness check`: ~37 issues in 24h
   - `CPS active job and worker check`: ~29 issues in 24h
7. Added `operational_loop` category in CEO Control Room.
8. Added CEO Operations actions:
   - create/update durable operational incident
   - pause noisy routine
   - resolve incident and optionally re-enable routine
9. Added CEO Operations UI panel on dashboard.
10. Converted repeated watchdogs into durable blocked incidents.
11. Fixed CPS CLI dry-run flag handling for `worker reap --dry-run` after discovering it could mutate registry state.
12. Updated the Hermes `cps-control-plane` skill to warn not to run `cps worker reap` during read-only checks.

## Current important operational facts

CEO Control Room categories from live API:

- `blocked_by_human`: warning / 4
- `missing_secret`: ok / 0
- `worker_offline`: warning / 2
- `operational_loop`: critical / 3
- `spend_cap`: ok / 0
- `promotion_candidate`: ok / 0

Durable operational incidents:

- `MIC-135` — `Operational incident: Market data feed liveness check`
  - status: `blocked`
  - assignee: unassigned
  - execution_run_id: null

- `MIC-136` — `Operational incident: Local worker liveness check`
  - status: `blocked`
  - assignee: unassigned
  - execution_run_id: null

- `MIC-137` — `Operational incident: CPS active job and worker check`
  - status: `blocked`
  - assignee: unassigned
  - execution_run_id: null

Watchdog routines remain paused and triggers disabled:

- `CPS active job and worker check`
- `Local worker liveness check`
- `Market data feed liveness check`

Trigger last result for all three:

`Paused by CEO Operations: durable incident owns this watchdog loop`

Important design decision:

- Do not assign these durable incidents automatically.
- Assigning them caused agents to append repeated read-only checks, creating a new treadmill.
- Keep them blocked/unassigned until an operator explicitly chooses a real recovery action or a one-off recheck.

## Current micro experiment state

Live `/micro-registry` showed:

- `MEXP-PAPER-INTRADAY-REVERSAL-001`
  - lifecycleState: `approved_for_local_dry_run`
  - execution authorization fields were null/false-ish; verify before relying on them.

- `MEXP-FX-6E-EURUSD-LEADLAG-001`
  - lifecycleState: `ready_for_board_review`
  - this is the recommended next experiment to approve for local dry-run planning only.

Safety constraints still active conceptually:

- no Vast launch
- no paid compute
- no broker action
- no paper/live trading
- no job requeue or registry reconciliation without explicit operator approval

## Current open issues of interest

Open issue list from live API included:

- `MIC-137` blocked — CPS active job/worker durable incident
- `MIC-135` blocked — market data durable incident
- `MIC-136` blocked — local worker durable incident
- `MIC-132` todo — Tiktok stocks investing
- `MIC-8` backlog — Forex-to-MT4/MT5 productization feasibility pipeline
- `MIC-4` backlog — micro.fincli.ai experiment history and running-experiments pages
- `MIC-2` todo — Review productivity for MIC-1
- `MIC-65` backlog — MT4/MT5 packaging prerequisites for FX seed experiment
- `MIC-64` backlog — Broker-paper promotion intake contract for micro registry
- `MIC-1` blocked — Connectivity smoke: finance Hermes via SSH

## Known CPS state / caution

Last CPS state observed:

- worker registry: 0 workers
- job registry: 548 total
  - 448 completed
  - 48 running
  - 42 failed
  - 10 cancelled

The 48 `running` jobs are suspected stale registry rows, not proven live compute.

Do not requeue or delete them automatically.

Recommended reconciliation if explicitly approved:

- mark suspect running rows `failed` with audit reason:
  `operator stale registry reconciliation: no live worker/process/artifacts`
- preserve rows for audit
- do not restart compute or workers as part of reconciliation

CPS dry-run bug was fixed in `/root/cps`:

- commit `8a5f5033 Fix worker reap dry-run flag handling`
- test passed: `./.venv/bin/python -m pytest tests/cli/test_worker_reap_cli.py -q`

## Next recommended action

After Hermes update + resume:

1. Verify Paperclip service and no wake loops:

```bash
systemctl status paperclip --no-pager -n 40
python3 - <<'PY'
import json, urllib.request
BASE='http://127.0.0.1:3110/api'; C='c0af1e45-87d5-458f-93d0-996582bcf7b0'
with urllib.request.urlopen(BASE+f'/companies/{C}/ceo-control-room', timeout=30) as r:
    cr=json.load(r)
print([(c['key'], c['severity'], c['count']) for c in cr['categories']])
PY
docker exec paperclip-postgres psql -U paperclip -d paperclip -Atc "select status,count(*) from agent_wakeup_requests where status in ('pending','claimed','running','queued') group by status;"
```

2. Proceed with the FX seed experiment:

Approve `MEXP-FX-6E-EURUSD-LEADLAG-001` for `local dry-run planning` only.

This should create an exact local CPS command plan and artifact contract. It must still not execute CPS, Vast, broker, paid APIs, shadow trading, paper trading, or live trading until a separate approval gate exists.

## Do not

- Do not auto-assign `MIC-135`, `MIC-136`, or `MIC-137`; that restarts the comment/recheck treadmill.
- Do not run `cps worker reap` as a read-only health check.
- Do not run Vast or paid compute.
- Do not touch broker integrations or paper/live trading.
- Do not requeue the 48 stale CPS `running` jobs without explicit operator approval.
- Do not commit unrelated autonomous report files unless intentionally cleaning them up.

## Uncommitted/untracked files to be aware of

In `/root/paperclip`:

- `server/MIC-96-cps-active-job-worker-check.md`
- `server/MIC-97-local-worker-liveness-check.md`

In `/root/cps`:

- `var/` containing `var/vast-ownership.json`

These were left untouched as pre-existing/autonomous artifacts.

## Verification already done before handoff

Passed during the session:

- `pnpm --filter @paperclipai/server typecheck`
- `pnpm --filter @paperclipai/shared typecheck`
- `pnpm --filter @paperclipai/ui typecheck`
- `pnpm --filter @paperclipai/ui build`
- CPS targeted pytest: `./.venv/bin/python -m pytest tests/cli/test_worker_reap_cli.py -q`

Browser caveat:

- Direct navigation to `/dashboard` and `/F/dashboard` in the tool showed a company route mismatch / not-found in the local browser snapshot. API checks passed. If UI work continues, investigate route slug/current workspace handling separately; it was not blocking the backend/API state.
