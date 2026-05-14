#!/usr/bin/env python3
"""Dead-man's-switch monitor for the PaperClip backup pipeline.

Reads ``last-success.json`` from the PaperClip instance backup-state directory
and fires a Paperclip alert issue if the last successful backup exceeds the
threshold (interval + grace period).

Expected to run every 30 minutes via systemd timer (deploy/systemd/paperclip-backup-deadman-switch.{service,timer}).

Usage:
    python scripts/backup_deadman_switch.py              # normal run
    python scripts/backup_deadman_switch.py --dry-run     # log only, no alert
    python scripts/backup_deadman_switch.py --grace 6    # 6h grace period
    python scripts/backup_deadman_switch.py --json-summary # JSON summary output
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

BACKUP_STATE_FILE = (
    Path.home()
    / ".paperclip"
    / "instances"
    / "default"
    / "backup-state"
    / "last-success.json"
)
BACKUP_INTERVAL_HOURS = 4
DEFAULT_GRACE_HOURS = 4
DEADMAN_LOG = Path.home() / ".paperclip" / "backup_deadman_switch.log"
DEADMAN_STATE = Path.home() / ".paperclip" / "backup_deadman_switch_state.json"
MAX_LOG_BYTES = 1 * 1024 * 1024
ALERT_SEARCH_QUERY = "Backup dead-man triggered"
LINUX_SPECIALIST_AGENT_ID = "a1d7dba5-6b71-4fff-86cb-8ee1734a35c5"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(DEADMAN_LOG),
        logging.StreamHandler() if os.isatty(0) else logging.NullHandler(),
    ],
)
logger = logging.getLogger("backup_deadman_switch")


def _rotate_log_if_needed():
    if DEADMAN_LOG.exists() and DEADMAN_LOG.stat().st_size > MAX_LOG_BYTES:
        bak = DEADMAN_LOG.with_suffix(".log.1")
        bak.write_text(DEADMAN_LOG.read_text())
        DEADMAN_LOG.write_text("")
        logger.info("Rotated log (size exceeded %d bytes)", MAX_LOG_BYTES)


def _read_last_success() -> dict | None:
    if not BACKUP_STATE_FILE.exists():
        logger.warning("last-success.json not found at %s", BACKUP_STATE_FILE)
        return None
    try:
        return json.loads(BACKUP_STATE_FILE.read_text())
    except (json.JSONDecodeError, OSError) as exc:
        logger.error("Failed to read last-success.json: %s", exc)
        return None


def _get_backup_age_hours(state: dict) -> float | None:
    raw = state.get("lastSuccess")
    if not raw:
        logger.warning("last-success.json has no 'lastSuccess' field")
        return None
    try:
        ts = datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except (ValueError, TypeError):
        logger.warning("Unparseable lastSuccess timestamp: %s", raw)
        return None
    age = datetime.now(timezone.utc) - ts.astimezone(timezone.utc)
    return age.total_seconds() / 3600


def _load_self_state() -> dict:
    if DEADMAN_STATE.exists():
        try:
            return json.loads(DEADMAN_STATE.read_text())
        except (json.JSONDecodeError, OSError):
            pass
    return {}


def _save_self_state(state: dict):
    DEADMAN_STATE.parent.mkdir(parents=True, exist_ok=True)
    DEADMAN_STATE.write_text(json.dumps(state, indent=2))


def _find_existing_alert() -> dict | None:
    try:
        sess = _session()
        base_url = _base()
        company_id = _company()
    except (KeyError, OSError) as exc:
        logger.error("Failed to init Paperclip session for alert search: %s", exc)
        return None

    try:
        resp = sess.get(
            f"{base_url}/api/companies/{company_id}/issues",
            params={"status": "todo,in_progress", "q": ALERT_SEARCH_QUERY, "limit": 10},
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
    age_hours: float | None,
    grace_hours: int,
    dry_run: bool,
    last_dest: str = "",
) -> bool:
    try:
        sess = _session()
        base_url = _base()
        company_id = _company()
    except (KeyError, OSError) as exc:
        logger.error("Failed to init Paperclip session for alert creation: %s", exc)
        return False

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    threshold = BACKUP_INTERVAL_HOURS + grace_hours

    if age_hours is None:
        subject = "no backups ever succeeded"
        description = (
            f"**Backup dead-man triggered — no successful offsite push**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last success:** MISSING (no `last-success.json` found)\n"
            f"- **Action required:** Investigate backup routine immediately.\n"
            f"  Script at `/home/sirrus/.paperclip/scripts/backup-to-drive.sh`.\n"
            f"  State file path: `{BACKUP_STATE_FILE}`\n"
        )
    else:
        subject = f"{age_hours:.1f}h since last successful offsite push"
        description = (
            "**Backup dead-man triggered — no successful offsite push "
            f"in >{threshold}h**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last success:** {age_hours:.1f}h ago\n"
            f"- **Expected interval:** {BACKUP_INTERVAL_HOURS}h\n"
            f"- **Grace period:** {grace_hours}h\n"
            f"- **Total threshold:** {threshold}h\n"
            f"- **Last destination:** {last_dest or 'unknown'}\n"
            f"- **Action required:** Investigate backup routine immediately.\n"
            f"  Script at `/home/sirrus/.paperclip/scripts/backup-to-drive.sh`.\n"
            f"  State file path: `{BACKUP_STATE_FILE}`\n"
        )

    title = f"Backup dead-man triggered — {subject}"
    payload = {
        "title": title,
        "description": description,
        "assigneeAgentId": LINUX_SPECIALIST_AGENT_ID,
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
    age_hours: float | None,
    threshold: float,
    dry_run: bool,
) -> bool:
    """Post a re-check comment on an existing dead-man alert."""
    try:
        sess = _session()
        base_url = _base()
        company_id = _company()
    except (KeyError, OSError) as exc:
        logger.error("Failed to init Paperclip session for commenting: %s", exc)
        return False

    now_str = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    issue_id = issue.get("identifier", issue.get("id", "?"))

    if age_hours is None:
        age_line = "- **Last success:** MISSING (no last-success.json)"
    else:
        age_line = f"- **Last success:** {age_hours:.1f}h ago"

    body = (
        f"**Dead-man re-check — {now_str}**\n\n"
        f"- **Check time:** {now_str}\n"
        f"{age_line}\n"
        f"- **Threshold:** {threshold:.0f}h\n"
        f"- **Status:** backup still overdue, existing alert remains open"
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


def run(grace_hours: int = DEFAULT_GRACE_HOURS, dry_run: bool = False) -> dict:

    _rotate_log_if_needed()

    prev = _load_self_state()
    prev_runs = prev.get("total_runs", 0)
    prev_last = prev.get("last_run_utc", "never")

    api_available = True
    try:
        _session()
    except (KeyError, OSError):
        api_available = False
        logger.error(
            "Paperclip API session unavailable — alert creation will be skipped"
        )

    state = _read_last_success()
    age_hours = _get_backup_age_hours(state) if state else None
    threshold = BACKUP_INTERVAL_HOURS + grace_hours

    alert_fired = False
    alert_skipped = False
    alert_reason = ""

    if age_hours is None:
        logger.warning("No successful backup recorded — alert will fire")
        alert_reason = "no_success_ever"
    elif age_hours <= threshold:
        logger.info(
            "Backup current: %.1fh old (threshold %.1fh)",
            age_hours,
            threshold,
        )
    else:
        logger.warning(
            "Backup overdue: %.1fh old (threshold %.1fh) — alert will fire",
            age_hours,
            threshold,
        )
        alert_reason = "overdue"

    if alert_reason:
        existing = _find_existing_alert()
        if existing:
            logger.info(
                "Existing alert %s already open — commenting with re-check status",
                existing.get("identifier", existing["id"]),
            )
            _comment_on_existing_alert(existing, age_hours, threshold, dry_run)
            alert_skipped = True
        else:
            last_dest = state.get("destination", "") if state else ""
            ok = _create_alert(age_hours, grace_hours, dry_run, last_dest)
            if ok:
                alert_fired = True

    now_utc = datetime.now(timezone.utc).isoformat()
    _save_self_state(
        {
            "total_runs": prev_runs + 1,
            "last_run_utc": now_utc,
            "last_alert_utc": now_utc if alert_fired else prev.get("last_alert_utc"),
        }
    )

    if not api_available and alert_reason:
        status = "auth_error"
    elif not api_available:
        status = "healthy"
    elif alert_reason:
        status = "alert"
    else:
        status = "healthy"

    summary = {
        "status": status,
        "backup_age_hours": age_hours,
        "backup_interval_hours": BACKUP_INTERVAL_HOURS,
        "grace_hours": grace_hours,
        "threshold_hours": threshold,
        "alert_fired": alert_fired,
        "alert_skipped": alert_skipped,
        "alert_reason": alert_reason or "none",
        "commented": alert_skipped,
        "self_last_run_utc": now_utc,
        "self_prev_run_utc": prev_last,
        "self_total_runs": prev_runs + 1,
    }
    return summary


def main():
    parser = argparse.ArgumentParser(
        description="Dead-man's-switch monitor for Paperclip backup pipeline",
    )
    parser.add_argument(
        "--grace",
        type=int,
        default=DEFAULT_GRACE_HOURS,
        help=f"Grace period in hours (default: {DEFAULT_GRACE_HOURS})",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Log actions without creating alerts",
    )
    parser.add_argument(
        "--json-summary",
        action="store_true",
        help="Output JSON summary to stdout (for CI step summaries)",
    )
    args = parser.parse_args()

    summary = run(grace_hours=args.grace, dry_run=args.dry_run)

    if args.json_summary:
        print(json.dumps(summary, indent=2))  # noqa: T201

    # Exit 0 if backup state was successfully read (even if alert creation failed)
    # Exit 1 only if we couldn't read the backup state at all
    sys.exit(0)


if __name__ == "__main__":
    main()
