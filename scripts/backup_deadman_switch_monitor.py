#!/usr/bin/env python3
"""Backup dead-man's-switch monitor — watches the deadman-switch-monitor workflow.

Runs on the self-hosted machine (systemd timer) as a backup to the
GH Actions-based ``deadman-switch-monitor.yml``.  Uses ``gh run list``
to check the ``deadman-switch-monitor`` workflow and the local
``deadman_switch_monitor_state.json`` as a secondary signal.

This closes the monitoring loop: the backup-deadman-switch is watched
by the deadman-switch-monitor (ubuntu-latest); the deadman-switch-monitor
is watched by this backup monitor (self-hosted).

Usage:
    python scripts/backup_deadman_switch_monitor.py
    python scripts/backup_deadman_switch_monitor.py --dry-run
    python scripts/backup_deadman_switch_monitor.py --threshold 45
    python scripts/backup_deadman_switch_monitor.py --json-summary
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "src"))

from touch_index.paperclip_client import _session, _base, _company

MONITOR_LOG = Path.home() / ".paperclip" / "backup_deadman_switch_monitor.log"
MONITOR_STATE = Path.home() / ".paperclip" / "backup_deadman_switch_monitor_state.json"
PRIMARY_MONITOR_STATE = Path.home() / ".paperclip" / "deadman_switch_monitor_state.json"
MAX_LOG_BYTES = 1 * 1024 * 1024

TARGET_WORKFLOW = "deadman-switch-monitor.yml"
ALERT_SEARCH_QUERY = "Backup dead-man's-switch monitor alert"
CTO_AGENT_ID = "41b5ede6-e209-40ba-b923-dc969c722e6d"

MONITOR_INTERVAL_MINUTES = 30
MONITOR_THRESHOLD_MINUTES = 60

MONITOR_LOG.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(MONITOR_LOG),
        logging.StreamHandler() if os.isatty(0) else logging.NullHandler(),
    ],
)
logger = logging.getLogger("backup_deadman_switch_monitor")


def _rotate_log_if_needed():
    if MONITOR_LOG.exists() and MONITOR_LOG.stat().st_size > MAX_LOG_BYTES:
        bak = MONITOR_LOG.with_suffix(".log.1")
        bak.write_text(MONITOR_LOG.read_text())
        MONITOR_LOG.write_text("")
        logger.info("Rotated backup monitor log (size exceeded %d bytes)", MAX_LOG_BYTES)


_GH_AUTH_ERROR_PATTERNS = [
    "To get started with GitHub CLI, please run:  gh auth login",
    "no oauth token found",
    "populate the GH_TOKEN environment variable",
]


def _gh_run_list(workflow: str, limit: int = 10) -> list[dict] | None:
    try:
        result = subprocess.run(
            [
                "gh", "run", "list",
                "--repo", "Stack-Alerts/BTC-Trade-Engine-PaperClip",
                "--workflow", workflow,
                "--limit", str(limit),
                "--json", "status,conclusion,createdAt,databaseId,headSha",
            ],
            capture_output=True,
            text=True,
            timeout=30,
            cwd=str(REPO_ROOT),
        )
    except FileNotFoundError:
        logger.error("gh CLI not found in PATH — cannot query workflow runs")
        return None
    except subprocess.TimeoutExpired:
        logger.error("gh run list timed out — cannot query workflow runs")
        return None
    if result.returncode != 0:
        stderr_lower = result.stderr.lower() if result.stderr else ""
        for pattern in _GH_AUTH_ERROR_PATTERNS:
            if pattern.lower() in stderr_lower:
                logger.error(
                    "gh CLI not authenticated — cannot query workflow runs. "
                    "Run 'gh auth login' or set GH_TOKEN."
                )
                return None
        logger.error("gh run list failed (rc=%d): %s", result.returncode, result.stderr.strip())
        return None
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        logger.error("gh run list returned non-JSON: %s", result.stdout[:200])
        return None


def _get_latest_success_age_minutes(runs: list[dict]) -> float | None:
    successes = [r for r in runs if r.get("conclusion") == "success"]
    if not successes:
        logger.warning("No successful runs found for %s", TARGET_WORKFLOW)
        return None
    latest = successes[0]
    raw = latest.get("createdAt")
    if not raw:
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        logger.warning("Unparseable createdAt timestamp: %s", raw)
        return None
    age = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
    return age.total_seconds() / 60


def _has_any_recent_runs(runs: list[dict], minutes: int) -> bool:
    cutoff = datetime.now(timezone.utc) - timedelta(minutes=minutes)
    for r in runs:
        raw = r.get("createdAt")
        if not raw:
            continue
        try:
            ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
        except (ValueError, TypeError):
            continue
        if ts.astimezone(timezone.utc) > cutoff:
            return True
    return False


def _read_primary_monitor_state() -> dict | None:
    if not PRIMARY_MONITOR_STATE.exists():
        logger.warning("Primary monitor state file missing: %s", PRIMARY_MONITOR_STATE)
        return None
    try:
        return json.loads(PRIMARY_MONITOR_STATE.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("Failed to read primary monitor state: %s", exc)
        return None


def _get_primary_monitor_age_minutes(state: dict) -> float | None:
    raw = state.get("last_run_utc")
    if not raw:
        logger.warning("Primary monitor state has no 'last_run_utc' field")
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        logger.warning("Unparseable last_run_utc in primary monitor state: %s", raw)
        return None
    age = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
    return age.total_seconds() / 60


def _load_self_state() -> dict:
    if MONITOR_STATE.exists():
        try:
            return json.loads(MONITOR_STATE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_self_state(state: dict):
    MONITOR_STATE.parent.mkdir(parents=True, exist_ok=True)
    MONITOR_STATE.write_text(json.dumps(state, indent=2))


def _find_existing_alert() -> dict | None:
    try:
        sess = _session()
        base_url = _base()
        company_id = _company()
    except (KeyError, OSError) as exc:
        logger.error("Failed to init Paperclip session: %s", exc)
        return None

    try:
        resp = sess.get(
            f"{base_url}/api/companies/{company_id}/issues",
            params={
                "status": "todo,in_progress",
                "q": ALERT_SEARCH_QUERY,
                "limit": 10,
            },
            timeout=30,
        )
        resp.raise_for_status()
        issues = resp.json()
    except Exception as exc:
        logger.error("Failed to search for existing alerts: %s", exc)
        return None

    for issue in issues:
        if ALERT_SEARCH_QUERY in (issue.get("title") or ""):
            return issue
    return None


def _create_alert(
    age_minutes: float | None,
    threshold_minutes: int,
    dry_run: bool,
    extra_detail: str = "",
) -> bool:
    try:
        sess = _session()
        base_url = _base()
        company_id = _company()
    except (KeyError, OSError) as exc:
        logger.error("Failed to init Paperclip session: %s", exc)
        return False

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")

    if age_minutes is None:
        subject = "no successful runs found for deadman-switch-monitor"
        description = (
            f"**Backup dead-man's-switch monitor alert — "
            f"{TARGET_WORKFLOW} is dead**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last successful run:** NONE found\n"
            f"- **Target workflow:** `{TARGET_WORKFLOW}`\n"
            f"- **Expected interval:** {MONITOR_INTERVAL_MINUTES} min\n"
            f"- **Monitor threshold:** {threshold_minutes} min\n"
            f"- **Action required:** Check GitHub Actions workflow health.\n"
            f"  The deadman-switch-monitor has no successful runs.\n"
            f"  The workflow may be disabled or misconfigured.\n"
            f"{extra_detail}"
        )
    else:
        subject = f"{age_minutes:.0f} min since deadman-switch-monitor last success"
        description = (
            f"**Backup dead-man's-switch monitor alert — "
            f"{TARGET_WORKFLOW} may be stalled**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last successful run:** {age_minutes:.0f} min ago\n"
            f"- **Expected interval:** {MONITOR_INTERVAL_MINUTES} min\n"
            f"- **Monitor threshold:** {threshold_minutes} min\n"
            f"- **Action required:** Check GitHub Actions workflow health.\n"
            f"  The deadman-switch-monitor has no recent successful runs.\n"
            f"  The workflow may be stalled or the ubuntu-latest runner may be down.\n"
            f"{extra_detail}"
        )

    title = f"{ALERT_SEARCH_QUERY} — {subject}"
    payload = {
        "title": title,
        "description": description,
        "assigneeAgentId": CTO_AGENT_ID,
        "priority": "critical",
        "status": "todo",
    }

    if dry_run:
        logger.info("DRY RUN: would create alert issue '%s'", title)
        print(json.dumps(payload, indent=2))  # noqa: T201
        return True

    try:
        resp = sess.post(
            f"{base_url}/api/companies/{company_id}/issues",
            json=payload,
            timeout=30,
        )
        resp.raise_for_status()
        created = resp.json()
        logger.info(
            "Created alert issue %s: %s",
            created.get("identifier", created.get("id", "?")),
            title,
        )
        return True
    except Exception as exc:
        logger.error("Failed to create alert issue: %s", exc)
        return False



def _comment_on_existing_alert(
    issue: dict,
    age_minutes: float | None,
    threshold_minutes: int,
    dry_run: bool,
) -> bool:
    try:
        sess = _session()
        base_url = _base()
        company_id = _company()
    except (KeyError, OSError) as exc:
        logger.error("Failed to init Paperclip session for commenting: %s", exc)
        return False

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    issue_id = issue.get("identifier", issue.get("id", "?"))

    if age_minutes is None:
        age_line = "- **Last success:** NONE found (no successful runs)"
    else:
        age_line = f"- **Last success:** {age_minutes:.0f} min ago"

    body = (
        f"**Backup dead-man's-switch monitor re-check \u2014 {now_str}**\n\n"
        f"- **Check time:** {now_str}\n"
        f"{age_line}\n"
        f"- **Target workflow:** `{TARGET_WORKFLOW}`\n"
        f"- **Threshold:** {threshold_minutes} min\n"
        f"- **Status:** {TARGET_WORKFLOW} still overdue, existing alert remains open"
    )

    if dry_run:
        logger.info("DRY RUN: would comment on alert %s", issue_id)
        print(json.dumps({"issueId": issue_id, "body": body}, indent=2))  # noqa: T201
        return True

    try:
        resp = sess.post(
            f"{base_url}/api/issues/{issue_id}/comments",
            json={"body": body},
            timeout=30,
        )
        resp.raise_for_status()
        logger.info("Commented on existing alert %s", issue_id)
        return True
    except Exception as exc:
        logger.error("Failed to comment on alert %s: %s", issue_id, exc)
        return False

def run(
    threshold_minutes: int = MONITOR_THRESHOLD_MINUTES,
    dry_run: bool = False,
) -> dict:
    _rotate_log_if_needed()

    prev = _load_self_state()
    prev_runs = prev.get("total_runs", 0)
    prev_last = prev.get("last_run_utc", "never")

    runs = _gh_run_list(TARGET_WORKFLOW, limit=10)

    alert_fired = False
    alert_skipped = False
    alert_reason = ""
    status = "healthy"
    primary_state_age = None
    primary_state_status = "unknown"

    primary_state = _read_primary_monitor_state()
    if primary_state:
        primary_state_age = _get_primary_monitor_age_minutes(primary_state)
        primary_state_status = "available"

    if runs is None:
        logger.error(
            "gh CLI auth failure — cannot determine workflow health. "
            "Falling back to primary monitor state file."
        )
        age_minutes = None
        if primary_state_age is not None:
            age_minutes = primary_state_age
            logger.info(
                "Using primary monitor state file age: %.0f min", age_minutes
            )
        else:
            status = "auth_error"
    else:
        age_minutes = _get_latest_success_age_minutes(runs)

    if runs is None and primary_state_age is None:
        logger.warning("Cannot determine deadman-switch-monitor health at all")
        alert_reason = "cannot_determine_health"
        status = "alert"
    elif age_minutes is None:
        if not _has_any_recent_runs(runs, threshold_minutes) if runs else True:
            logger.warning(
                "Deadman-switch-monitor has no runs within %d min — alert will fire",
                threshold_minutes,
            )
            alert_reason = "no_runs_found"
            status = "alert"
        else:
            logger.warning(
                "Deadman-switch-monitor has runs but no successes (failing runs exist)"
            )
            alert_reason = "all_runs_failing"
            status = "alert"
    elif age_minutes <= threshold_minutes:
        logger.info(
            "Deadman-switch-monitor healthy: last success %.0f min ago "
            "(threshold %d min)",
            age_minutes,
            threshold_minutes,
        )
    else:
        logger.warning(
            "Deadman-switch-monitor stalled: last success %.0f min ago "
            "(threshold %d min) — alert will fire",
            age_minutes,
            threshold_minutes,
        )
        alert_reason = "overdue"
        status = "alert"

    if alert_reason:
        existing = _find_existing_alert()
        if existing:
            logger.info(
                "Existing alert %s already open — commenting with re-check status",
                existing.get("identifier", existing.get("id")),
            )
            _comment_on_existing_alert(existing, age_minutes, threshold_minutes, dry_run)
            alert_skipped = True
        else:
            extra = ""
            if primary_state_age is not None:
                extra = (
                    f"- **Primary monitor state file age:** "
                    f"{primary_state_age:.0f} min\n"
                )
            ok = _create_alert(age_minutes, threshold_minutes, dry_run, extra)
            if ok:
                alert_fired = True

    now_utc = datetime.now(timezone.utc).isoformat()
    _save_self_state({
        "total_runs": prev_runs + 1,
        "last_run_utc": now_utc,
        "last_alert_utc": now_utc if alert_fired else prev.get("last_alert_utc"),
    })

    summary = {
        "status": status,
        "target_workflow": TARGET_WORKFLOW,
        "monitor_interval_minutes": MONITOR_INTERVAL_MINUTES,
        "monitor_threshold_minutes": threshold_minutes,
        "last_success_age_minutes": age_minutes,
        "total_runs_checked": len(runs) if runs is not None else 0,
        "gh_cli_available": runs is not None,
        "primary_state_file": primary_state_status,
        "primary_state_age_minutes": primary_state_age,
        "alert_fired": alert_fired,
        "alert_skipped": alert_skipped,
        "commented": alert_skipped,
        "alert_reason": alert_reason or "none",
        "self_last_run_utc": now_utc,
        "self_prev_run_utc": prev_last,
        "self_total_runs": prev_runs + 1,
    }
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="Backup dead-man's-switch monitor — "
                    "watches the deadman-switch-monitor workflow",
    )
    parser.add_argument(
        "--threshold",
        type=int,
        default=MONITOR_THRESHOLD_MINUTES,
        help=f"Alert threshold in minutes (default: {MONITOR_THRESHOLD_MINUTES})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log actions without creating alerts",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Output JSON summary to stdout",
    )
    args = parser.parse_args()

    summary = run(threshold_minutes=args.threshold, dry_run=args.dry_run)

    if args.json_summary:
        print(json.dumps(summary, indent=2))  # noqa: T201

    detection_ok = summary["status"] != "auth_error"
    sys.exit(0 if detection_ok else 1)


if __name__ == "__main__":
    main()
