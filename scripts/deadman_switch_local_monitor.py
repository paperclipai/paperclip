#!/usr/bin/env python3
"""Local dead-man's-switch backup monitor — watches the backup dead-man's-switch
via its state file, without depending on GitHub Actions API.

Runs on the self-hosted machine (systemd timer) as a fallback to the
GH Actions-based ``deadman-switch-monitor.yml``.  Checks the dead-man
switch's own ``backup_deadman_switch_state.json`` for ``last_run_utc``
and fires a Paperclip alert if it is stale.

Usage:
    python scripts/deadman_switch_local_monitor.py
    python scripts/deadman_switch_local_monitor.py --dry-run
    python scripts/deadman_switch_local_monitor.py --threshold 60
    python scripts/deadman_switch_local_monitor.py --json-summary
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO_ROOT))
sys.path.insert(0, str(REPO_ROOT / "src"))

from touch_index.paperclip_client import _session, _base, _company

DEADMAN_STATE = Path.home() / ".paperclip" / "backup_deadman_switch_state.json"
MONITOR_LOG = Path.home() / ".paperclip" / "deadman_switch_local_monitor.log"
MONITOR_STATE = Path.home() / ".paperclip" / "deadman_switch_local_monitor_state.json"
MAX_LOG_BYTES = 1 * 1024 * 1024

TARGET_WORKFLOW = "backup-deadman-switch.yml"
ALERT_SEARCH_QUERY = "Dead-man's-switch local monitor alert"
CTO_AGENT_ID = "41b5ede6-e209-40ba-b923-dc969c722e6d"

DEADMAN_INTERVAL_MINUTES = 30
MONITOR_THRESHOLD_MINUTES = 45

MONITOR_LOG.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(MONITOR_LOG),
        logging.StreamHandler() if os.isatty(0) else logging.NullHandler(),
    ],
)
logger = logging.getLogger("deadman_switch_local_monitor")


def _rotate_log_if_needed():
    if MONITOR_LOG.exists() and MONITOR_LOG.stat().st_size > MAX_LOG_BYTES:
        bak = MONITOR_LOG.with_suffix(".log.1")
        bak.write_text(MONITOR_LOG.read_text())
        MONITOR_LOG.write_text("")
        logger.info("Rotated local monitor log (size exceeded %d bytes)", MAX_LOG_BYTES)


def _read_deadman_state() -> dict | None:
    if not DEADMAN_STATE.exists():
        logger.warning("Dead-man switch state file missing: %s", DEADMAN_STATE)
        return None
    try:
        return json.loads(DEADMAN_STATE.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("Failed to read dead-man state: %s", exc)
        return None


def _get_deadman_age_minutes(state: dict) -> float | None:
    raw = state.get("last_run_utc")
    if not raw:
        logger.warning("Dead-man state has no 'last_run_utc' field")
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        logger.warning("Unparseable last_run_utc timestamp: %s", raw)
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
        subject = "dead-man state file missing or unreadable"
        description = (
            f"**Dead-man's-switch local monitor alert — "
            f"cannot determine dead-man switch liveness**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last run of dead-man switch:** UNKNOWN "
            f"(state file missing or unreadable)\n"
            f"- **State file path:** `{DEADMAN_STATE}`\n"
            f"- **Expected interval:** {DEADMAN_INTERVAL_MINUTES} min\n"
            f"- **Monitor threshold:** {threshold_minutes} min\n"
            f"- **Action required:** Check GitHub Actions workflow health "
            f"for `{TARGET_WORKFLOW}`.\n"
            f"  The dead-man switch state file cannot be read.\n"
            f"  The workflow may not have run yet, or the state file was\n"
            f"  deleted/corrupted.\n"
        )
    else:
        subject = f"{age_minutes:.0f} min since dead-man switch last ran"
        description = (
            f"**Dead-man's-switch local monitor alert — "
            f"{TARGET_WORKFLOW} may be stalled**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Dead-man switch last run:** {age_minutes:.0f} min ago\n"
            f"- **Expected interval:** {DEADMAN_INTERVAL_MINUTES} min\n"
            f"- **Monitor threshold:** {threshold_minutes} min\n"
            f"- **Action required:** Check GitHub Actions workflow health.\n"
            f"  The backup dead-man's-switch state file shows a stale\n"
            f"  last_run_utc. The workflow may be stalled or the self-hosted\n"
            f"  runner may be down.\n"
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


def run(
    threshold_minutes: int = MONITOR_THRESHOLD_MINUTES,
    dry_run: bool = False,
) -> dict:
    _rotate_log_if_needed()

    prev = _load_self_state()
    prev_runs = prev.get("total_runs", 0)
    prev_last = prev.get("last_run_utc", "never")

    state = _read_deadman_state()
    age_minutes = _get_deadman_age_minutes(state) if state else None

    alert_fired = False
    alert_skipped = False
    alert_reason = ""
    status = "healthy"

    if age_minutes is None:
        logger.warning("Cannot determine dead-man switch age — alert will fire")
        alert_reason = "state_unavailable"
        status = "alert"
    elif age_minutes <= threshold_minutes:
        logger.info(
            "Dead-man switch healthy (local check): last run %.0f min ago "
            "(threshold %d min)",
            age_minutes,
            threshold_minutes,
        )
    else:
        logger.warning(
            "Dead-man switch stalled (local check): last run %.0f min ago "
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
                "Existing alert %s already open — skipping duplicate creation",
                existing.get("identifier", existing.get("id")),
            )
            alert_skipped = True
        else:
            ok = _create_alert(age_minutes, threshold_minutes, dry_run)
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
        "monitor_type": "local",
        "target_workflow": TARGET_WORKFLOW,
        "deadman_interval_minutes": DEADMAN_INTERVAL_MINUTES,
        "monitor_threshold_minutes": threshold_minutes,
        "last_deadman_run_age_minutes": age_minutes,
        "alert_fired": alert_fired,
        "alert_skipped": alert_skipped,
        "alert_reason": alert_reason or "none",
        "self_last_run_utc": now_utc,
        "self_prev_run_utc": prev_last,
        "self_total_runs": prev_runs + 1,
    }
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="Local dead-man's-switch backup monitor — checks state file directly",
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
