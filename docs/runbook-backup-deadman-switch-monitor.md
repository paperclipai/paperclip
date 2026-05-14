# Runbook: Backup Dead-Man's-Switch Monitor

**Owner:** AutomationEngineer
**Audience:** Platform Engineers, On-call responders, CTO
**Last Updated:** 2026-05-14

## Overview

The Backup Dead-Man's-Switch Monitor closes the monitoring loop by watching the
`deadman-switch-monitor` GitHub Actions workflow for liveness. It runs on the
self-hosted machine so that a GitHub-hosted-runner outage on `ubuntu-latest`
(where the primary `deadman-switch-monitor` runs) does not go undetected.

### Monitoring Chain

```
backup-to-drive pipeline          rclone (systemd timer)
        ^
        |  monitored by
        |
backup-deadman-switch             self-hosted (systemd timer)
        ^                         writes backup_deadman_switch_state.json
        |                                |
        |  monitored by                  |  monitored by
        |                                |
deadman-switch-monitor           deadman-switch-local-monitor
ubuntu-latest (GH Actions)       self-hosted (GH Actions)
writes deadman_switch_monitor_   reads backup_deadman_switch_state.json
  state.json
        ^
        |  monitored by
        |
backup-deadman-switch-monitor    <-- this monitor
self-hosted (GH Actions +
  systemd timer)
dual-source: gh run list +
  deadman_switch_monitor_state.json
```

The backup monitor has **dual-source liveness checks**:

| Source | Method | Purpose |
|---|---|---|
| **Primary** | `gh run list` against `deadman-switch-monitor.yml` | Authoritative — checks GH Actions run history |
| **Fallback** | Reads `~/.paperclip/deadman_switch_monitor_state.json` | Used when `gh` CLI is unavailable (auth errors, missing token) |

## Architecture

```
GitHub Actions API        Backup Monitor               Paperclip API
      |                        |                            |
      |---gh run list--------->|                            |
      |                        |                            |
      |                        +--check success age---------|
      |                        +--read primary state file---|
      |                        |                            |
      |                        +--alert needed?---→         |
      |                        |                            |
      |                        |<--find existing alert------|
      |                        |                            |
      |                        +--create alert (or comment)→|
      |                        |                            |
      |                        +--persist state--→ ~/.paperclip/backup_deadman_switch_monitor_state.json
      |                        +--write log-------→ ~/.paperclip/backup_deadman_switch_monitor.log
```

### State file

Stored at `~/.paperclip/backup_deadman_switch_monitor_state.json`. Shape:

```json
{
  "total_runs": 42,
  "last_run_utc": "2026-05-14T12:38:00+00:00",
  "last_alert_utc": null
}
```

| Field | Description |
|---|---|
| `total_runs` | Cumulative invocations of this monitor |
| `last_run_utc` | ISO-8601 timestamp of the most recent run |
| `last_alert_utc` | ISO-8601 timestamp of the most recent alert creation |

### Log file

`~/.paperclip/backup_deadman_switch_monitor.log` — auto-rotated at 1 MB with
one backup (`backup_deadman_switch_monitor.log.1`).

## CLI Usage

### Run with default thresholds

```bash
python scripts/backup_deadman_switch_monitor.py
```

### Dry run (log only, no alerts created)

```bash
python scripts/backup_deadman_switch_monitor.py --dry-run
```

### Custom alert threshold

```bash
python scripts/backup_deadman_switch_monitor.py --threshold 45
```

### JSON summary for CI

```bash
python scripts/backup_deadman_switch_monitor.py --json-summary
```

### Flags

| Flag | Default | Description |
|---|---|---|
| `--threshold <min>` | `60` | Alert threshold in minutes. If the last successful `deadman-switch-monitor` run exceeds this age, an alert fires. |
| `--dry-run` | `false` | Log all actions without creating Paperclip API calls |
| `--json-summary` | `false` | Output structured JSON to stdout (used by CI step summaries) |

### Exit codes

| Code | Meaning |
|---|---|
| `0` | Detection OK (healthy or alert fired successfully) |
| `1` | Auth error — cannot reach GitHub or Paperclip API |

## JSON Summary Output

```json
{
  "status": "healthy|alert|auth_error",
  "target_workflow": "deadman-switch-monitor.yml",
  "monitor_interval_minutes": 30,
  "monitor_threshold_minutes": 60,
  "last_success_age_minutes": 12.5,
  "total_runs_checked": 10,
  "gh_cli_available": true,
  "primary_state_file": "available|unknown",
  "primary_state_age_minutes": 12.0,
  "alert_fired": false,
  "alert_skipped": false,
  "commented": false,
  "alert_reason": "none|overdue|no_runs_found|all_runs_failing|cannot_determine_health",
  "self_last_run_utc": "2026-05-14T12:38:00+00:00",
  "self_prev_run_utc": "2026-05-14T12:08:00+00:00",
  "self_total_runs": 42
}
```

## Alert Deduplication

The monitor avoids creating duplicate alert issues:

1. On each alert condition, it searches Paperclip for existing `todo` or
   `in_progress` issues whose title contains `"Backup dead-man's-switch monitor alert"`.
2. If an existing alert is found → **comments** with a re-check status update.
   No new issue is created.
3. If no existing alert is found → **creates** a new `critical`-priority issue
   assigned to the CTO.

This means alert volume is capped at one open issue per outage window.

## CI/CD Pipeline

Workflow: `.github/workflows/backup-deadman-switch-monitor.yml`

### Triggers

| Trigger | Schedule / Event |
|---|---|
| `schedule` | Every 30 minutes at `:12` and `:42` — offset 3 min before the deadman-switch-monitor's `:15`/`:45` schedule |
| `workflow_dispatch` | Manual trigger with `dry_run` and `threshold` inputs |

### Runner

`runs-on: self-hosted` — this is intentional. The backup monitor must not share
a runner with the workflow it monitors (`deadman-switch-monitor` runs on
`ubuntu-latest`).

### Step sequence

1. **Checkout** repo
2. **Set up Python** 3.12
3. **Install dependencies** (`requests`, `python-dotenv`)
4. **Ensure gh CLI in PATH** — prepends `/snap/bin` to `GITHUB_PATH`
5. **Run backup monitor** — writes `/tmp/backup-deadman-monitor-summary.json`
6. **Write step summary** — renders Markdown report to `$GITHUB_STEP_SUMMARY`
7. **Upload artifacts** (always, 7-day retention):
   - Monitor logs: `~/.paperclip/backup_deadman_switch_monitor.log`
   - Monitor state: `~/.paperclip/backup_deadman_switch_monitor_state.json`
   - Summary JSON: `/tmp/backup-deadman-monitor-summary.json`

### Environment Variables

| Variable | Source | Purpose |
|---|---|---|
| `PAPERCLIP_API_URL` | Secret | Paperclip API base URL |
| `PAPERCLIP_API_KEY` | Secret | API bearer token |
| `PAPERCLIP_COMPANY_ID` | Secret | Company UUID |
| `GH_TOKEN` | `github.token` | GitHub API token for `gh run list` |

## Systemd Integration (Local Execution)

The backup monitor also runs locally as a systemd timer, providing coverage
independent of GitHub Actions availability.

### Unit files

| File | Location |
|---|---|
| `paperclip-backup-deadman-monitor.service` | `deploy/systemd/` |
| `paperclip-backup-deadman-monitor.timer` | `deploy/systemd/` |
| `install-backup-deadman-monitor.sh` | `deploy/systemd/` |

### Timer schedule

Runs at `:08` and `:38` of every hour — offset 4 minutes before the GitHub
Actions schedule (`:12`/`:42`) and 7 minutes before the primary monitor's
schedule (`:15`/`:45`). This staggered offset means the backup check happens
before the primary check, so alerts about a stale primary monitor arrive early.

### Install

```bash
cd deploy/systemd
DRY_RUN=true bash install-backup-deadman-monitor.sh    # Verify
bash install-backup-deadman-monitor.sh                  # Install
```

### Verify

```bash
systemctl --user status paperclip-backup-deadman-monitor.timer
systemctl --user list-timers paperclip-backup-deadman-monitor.timer
journalctl --user -u paperclip-backup-deadman-monitor.service -n 20
```

### Trigger a manual run

```bash
systemctl --user start paperclip-backup-deadman-monitor.service
```

### Uninstall

```bash
systemctl --user stop paperclip-backup-deadman-monitor.timer
systemctl --user disable paperclip-backup-deadman-monitor.timer
rm ~/.config/systemd/user/paperclip-backup-deadman-monitor.{service,timer}
systemctl --user daemon-reload
```

### Linger check

The timer requires lingering to run when logged out:

```bash
loginctl show-user "$USER" --property=Linger
# If 'no':
sudo loginctl enable-linger "$USER"
```

## Dual-Source Liveness Check Logic

The monitor's decision tree:

```
gh run list available?
├── YES → check deadman-switch-monitor workflow runs
│   ├── No runs at all → ALERT (no_runs_found)
│   ├── Runs exist but no successes → ALERT (all_runs_failing)
│   ├── Last success age > threshold → ALERT (overdue)
│   └── Last success age ≤ threshold → HEALTHY
│
└── NO (auth error / gh not found)
    └── Is primary state file (~/.paperclip/deadman_switch_monitor_state.json) readable?
        ├── YES → use primary state file age as fallback
        │   ├── Age > threshold → ALERT (overdue)
        │   └── Age ≤ threshold → HEALTHY
        │
        └── NO → cannot determine health → ALERT (cannot_determine_health)
```

## Alert Comparison: Backup Monitor vs. Primary Monitor

| Feature | Backup Monitor (`backup_deadman_switch_monitor.py`) | Primary Monitor (`deadman_switch_monitor.py`) |
|---|---|---|
| **Watches** | `deadman-switch-monitor.yml` | `backup-deadman-switch.yml` |
| **Runner** | self-hosted | ubuntu-latest |
| **GH Actions schedule** | `12,42 * * * *` | `15,45 * * * *` |
| **Systemd schedule** | `:08, :38` | N/A |
| **Default threshold** | 60 min | 45 min |
| **Dual-source fallback** | Yes (primary state file + `gh run list`) | No (only `gh run list`) |
| **Existing alert comment** | Yes (re-check status comments) | No (only skip) |
| **Alert title prefix** | `Backup dead-man's-switch monitor alert — ` | `Dead-man's-switch monitor alert — ` |

## Rollback Procedure

If the monitor begins creating false alerts or spamming comments:

### 1. Disable both schedulers

GitHub Actions:
- Navigate to Actions → Backup Dead-Man's-Switch Monitor → ... → Disable workflow

Systemd:
```bash
systemctl --user stop paperclip-backup-deadman-monitor.timer
systemctl --user disable paperclip-backup-deadman-monitor.timer
```

### 2. Reset monitor state

```bash
rm ~/.paperclip/backup_deadman_switch_monitor_state.json
```

### 3. Revert code if a code change caused the issue

```bash
git log --oneline scripts/backup_deadman_switch_monitor.py | head -5
git revert <bad-commit-hash> --no-edit
git push origin main
```

### 4. Validate with dry-run

```bash
python scripts/backup_deadman_switch_monitor.py --dry-run --json-summary
```

### 5. Re-enable after fix

```bash
systemctl --user enable paperclip-backup-deadman-monitor.timer
systemctl --user start paperclip-backup-deadman-monitor.timer
```

Re-enable the GitHub Actions workflow from the Actions tab.

## Monitoring & Alerting

### Log file

`~/.paperclip/backup_deadman_switch_monitor.log` — auto-rotated at 1 MB with
one backup (`backup_deadman_switch_monitor.log.1`).

### Key log patterns

| Log pattern | Meaning |
|---|---|
| `Deadman-switch-monitor healthy: last success X min ago` | Primary monitor is running normally |
| `Deadman-switch-monitor stalled: last success X min ago` | Primary monitor overdue — alert will fire |
| `Deadman-switch-monitor has no runs within X min` | No workflow runs found in the threshold window |
| `Deadman-switch-monitor has runs but no successes` | Runs exist but all are failing |
| `Existing alert X already open — commenting` | Alert deduplication: re-check comment posted |
| `Created alert issue X: ...` | New alert issue created on Paperclip |
| `Commented on existing alert X` | Re-check status comment posted on existing alert |
| `gh CLI auth failure — cannot determine workflow health` | Auth issue, falling back to primary state file |
| `Using primary monitor state file age: X min` | Fallback in use — reading local state file |
| `Cannot determine deadman-switch-monitor health at all` | Both sources unavailable — critical |
| `Rotated backup monitor log` | Log rotation triggered |
| `DRY RUN: would create alert issue` | Dry-run mode: alert was suppressed |
| `Primary monitor state file missing` | Fallback source unavailable |

### Artifacts

Each GitHub Actions run uploads three artifacts (7-day retention):

| Artifact name | Content | Debug use |
|---|---|---|
| `backup-deadman-switch-monitor-logs` | `~/.paperclip/backup_deadman_switch_monitor.log` | Full operational log |
| `backup-deadman-switch-monitor-state` | `~/.paperclip/backup_deadman_switch_monitor_state.json` | Run counts and alert timestamps |
| `backup-deadman-switch-monitor-summary` | `/tmp/backup-deadman-monitor-summary.json` | Structured JSON summary |

Download artifacts for debugging:

```bash
gh run download <run-id> -n backup-deadman-switch-monitor-summary
cat backup-deadman-monitor-summary.json | python -m json.tool
```

## Troubleshooting

| Symptom | Likely Cause | Action |
|---|---|---|
| `gh_cli_available: false` | `gh` CLI not in PATH or not authenticated | Check `/snap/bin/gh` exists and `gh auth status` passes |
| `primary_state_file: unknown` | `deadman_switch_monitor_state.json` missing | Primary monitor may not have run yet (first-run state) or state file was deleted |
| Both sources unavailable (`cannot_determine_health`) | GH Actions API down AND local state file missing | Verify network; check if `deadman-switch-monitor.yml` has ever run successfully |
| `status: auth_error` | Paperclip API credentials invalid or expired | Check `PAPERCLIP_API_KEY` and `PAPERCLIP_COMPANY_ID` secrets |
| Alert created but no one acts | CTO agent may be paused | Verify CTO agent status in Paperclip; alerts are assigned to `CTO_AGENT_ID` |
| Timer not running when logged out | Linger not enabled | Run `sudo loginctl enable-linger <user>` |
| Log file not rotating | Permission issue on log file | Check file ownership: `ls -la ~/.paperclip/backup_deadman_switch_monitor.log` |
| `gh run list` returns empty | Workflow disabled or renamed | Verify `deadman-switch-monitor.yml` is enabled in Actions tab |
| `gh run list` timeout | GitHub API slow or network issue | Check connectivity; 30s timeout is hardcoded |

## Related Documents

- `scripts/backup_deadman_switch_monitor.py` — Monitor implementation
- `scripts/deadman_switch_monitor.py` — Primary monitor (the workflow being watched)
- `scripts/deadman_switch_local_monitor.py` — Local state-file monitor (independent backup)
- `.github/workflows/backup-deadman-switch-monitor.yml` — CI/CD workflow (this monitor)
- `.github/workflows/deadman-switch-monitor.yml` — CI/CD workflow (primary, being watched)
- `.github/workflows/deadman-switch-local-monitor.yml` — CI/CD workflow (local state-file backup)
- `tests/test_scripts/test_backup_deadman_switch_monitor.py` — Test suite (61 tests)
- `deploy/systemd/paperclip-backup-deadman-monitor.service` — Systemd service unit
- `deploy/systemd/paperclip-backup-deadman-monitor.timer` — Systemd timer unit
- `deploy/systemd/install-backup-deadman-monitor.sh` — Systemd install script
- `src/touch_index/paperclip_client.py` — Underlying API client (`_session`, `_base`, `_company`)
- `docs/runbook-incident-response.md` — Incident severity classification and response flow

## Design Notes

### Why dual-source?

The primary deadman-switch-monitor runs on `ubuntu-latest`. If GitHub's
`ubuntu-latest` runner fleet has an outage, the primary monitor can't fire. The
backup monitor runs on `self-hosted` and uses `gh run list` (a GitHub API call)
as its primary source. If GH CLI auth fails, it falls back to reading the local
state file that the primary monitor writes (`deadman_switch_monitor_state.json`).

The local state file fallback only works when the primary monitor recently ran
and wrote its state. If the local state file is missing (primary monitor never
ran), the backup monitor fires a `cannot_determine_health` alert to ensure the
gap is known.

### Why staggered schedule offsets?

All monitors in the chain use offset schedules to avoid simultaneous API calls:

| Component | GH Actions cron | Systemd timer | Offset from primary |
|---|---|---|---|
| backup-deadman-switch | N/A (systemd only) | `:03, :33` | N/A (leaf of chain) |
| deadman-switch-monitor | `15,45 * * * *` | N/A | Ref |
| **backup-deadman-switch-monitor** | `12,42 * * * *` | `:08, :38` | -3 min (GH), -7 min (systemd) |
| deadman-switch-local-monitor | `5,20,35,50 * * * *` | N/A | -10 min |

The backup monitor runs slightly before the primary monitor's expected runs
(`:12` before `:15`, `:42` before `:45`). This ensures the backup check arrives
in time to detect if the primary monitor's scheduled run at `:15`/`:45` fails.

### Alert comment strategy

Unlike the primary deadman-switch-monitor (which silently skips duplicate alerts),
the backup monitor posts a re-check status comment on existing alert issues.
This provides an audit trail of each re-check attempt and confirms the backup
monitor itself is running, even while the alert remains open.

### `commented` field

The summary JSON includes a `commented` field (mirrors `alert_skipped`). This
exists because the "skip" logic has two branches: skip-and-silent (primary
monitor) vs. skip-and-comment (backup monitor). The `commented` field makes the
difference visible in CI step summaries and artifacts.
