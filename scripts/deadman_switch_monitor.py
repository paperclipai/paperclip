#!/usr/bin/env python3
"""Dead-man's-switch self-monitor — watches the backup dead-man's-switch workflow.

Runs on ubuntu-latest (GitHub-hosted) to avoid being affected by the same
self-hosted runner failures it monitors.  Checks the backup-deadman-switch
workflow run history via ``gh run list`` and fires a Paperclip alert if the
dead-man's-switch has no successful runs within the expected window.

Usage:
    python scripts/deadman_switch_monitor.py
    python scripts/deadman_switch_monitor.py --dry-run
    python scripts/deadman_switch_monitor.py --json-summary
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

MONITOR_LOG = Path.home() / ".paperclip" / "deadman_switch_monitor.log"
MONITOR_STATE = Path.home() / ".paperclip" / "deadman_switch_monitor_state.json"
MAX_LOG_BYTES = 1 * 1024 * 1024

TARGET_WORKFLOW = "backup-deadman-switch.yml"
ALERT_SEARCH_QUERY = "Dead-man's-switch monitor alert"
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
logger = logging.getLogger("deadman_switch_monitor")


def _rotate_log_if_needed():
    if MONITOR_LOG.exists() and MONITOR_LOG.stat().st_size > MAX_LOG_BYTES:
        bak = MONITOR_LOG.with_suffix(".log.1")
        bak.write_text(MONITOR_LOG.read_text())
        MONITOR_LOG.write_text("")
        logger.info("Rotated monitor log (size exceeded %d bytes)", MAX_LOG_BYTES)


_GH_AUTH_ERROR_PATTERNS = [
    "To get started with GitHub CLI, please run:  gh auth login",
    "no oauth token found",
    "populate the GH_TOKEN environment variable",
]


def _gh_run_list(workflow: str, limit: int = 5) -> list[dict] | None:
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
                    "Run 'gh auth login' or set GH_TOKEN. Skipping alert."
                )
                return None
        logger.error("gh run list failed (rc=%d): %s", result.returncode, result.stderr.strip())
        return []
    try:
        return json.loads(result.stdout)
    except json.JSONDecodeError:
        logger.error("gh run list returned non-JSON: %s", result.stdout[:200])
        return []


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
        subject = "no successful runs found"
        description = (
            f"**Dead-man's-switch monitor alert — {TARGET_WORKFLOW} is dead**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last successful run:** NONE found\n"
            f"- **Target workflow:** `{TARGET_WORKFLOW}`\n"
            f"- **Expected interval:** {DEADMAN_INTERVAL_MINUTES} min\n"
            f"- **Monitor threshold:** {threshold_minutes} min\n"
            f"- **Action required:** Check GitHub Actions workflow health.\n"
            f"  The backup dead-man's-switch has no successful runs.\n"
            f"  The workflow may be disabled, misconfigured, or the self-hosted\n"
            f"  runner may be down.\n"
        )
    else:
        subject = f"{age_minutes:.0f} min since last successful run"
        description = (
            f"**Dead-man's-switch monitor alert — "
            f"{TARGET_WORKFLOW} may be stalled**\n\n"
            f"- **Check time:** {now_str}\n"
            f"- **Last successful run:** {age_minutes:.0f} min ago\n"
            f"- **Expected interval:** {DEADMAN_INTERVAL_MINUTES} min\n"
            f"- **Monitor threshold:** {threshold_minutes} min\n"
            f"- **Action required:** Check GitHub Actions workflow health.\n"
            f"  The backup dead-man's-switch has no recent successful runs.\n"
            f"  The workflow may be stalled or the self-hosted runner may be down.\n"
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

    runs = _gh_run_list(TARGET_WORKFLOW, limit=10)

    alert_fired = False
    alert_skipped = False
    alert_reason = ""
    status = "healthy"

    if runs is None:
        logger.error(
            "gh CLI auth failure — cannot determine workflow health. No alert fired."
        )
        age_minutes = None
        status = "auth_error"
    else:
        age_minutes = _get_latest_success_age_minutes(runs)

    if runs is None:
        pass
    elif age_minutes is None:
        if not _has_any_recent_runs(runs, threshold_minutes):
            logger.warning(
                "Dead-man's-switch workflow has no runs at all "
                "within %d min — alert will fire",
                threshold_minutes,
            )
            alert_reason = "no_runs_found"
            status = "alert"
        else:
            logger.warning(
                "Dead-man's-switch has runs but no successes "
                "(failing runs exist) — alert will fire",
            )
            alert_reason = "all_runs_failing"
            status = "alert"
    elif age_minutes <= threshold_minutes:
        logger.info(
            "Dead-man's-switch healthy: last success %.0f min ago (threshold %d min)",
            age_minutes,
            threshold_minutes,
        )
    else:
        logger.warning(
            "Dead-man's-switch stalled: last success %.0f min ago "
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
                existing.get("identifier", existing["id"]),
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
        "target_workflow": TARGET_WORKFLOW,
        "deadman_interval_minutes": DEADMAN_INTERVAL_MINUTES,
        "monitor_threshold_minutes": threshold_minutes,
        "last_success_age_minutes": age_minutes,
        "total_runs_checked": len(runs) if runs is not None else 0,
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
        description="Dead-man's-switch self-monitor — watches the backup dead-man's-switch workflow",
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
        help="Output JSON summary to stdout (for CI step summaries)",
    )
    args = parser.parse_args()

    summary = run(threshold_minutes=args.threshold, dry_run=args.dry_run)

    if args.json_summary:
        print(json.dumps(summary, indent=2))  # noqa: T201

    detection_ok = summary["status"] != "auth_error"
    sys.exit(0 if detection_ok else 1)


if __name__ == "__main__":
    main()
