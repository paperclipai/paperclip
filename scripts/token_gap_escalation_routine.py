#!/usr/bin/env python3
"""Token-Gap Escalation Routine - Detects and escalates PR-merge issues blocked by GitHub API token gaps.

Sweeps blocked PR-merge issues every 30 minutes and escalates those blocked by GitHub-API
token gaps for >4h. Posts CEO escalation comment with idempotent deduplication.

Usage:
    python3 token_gap_escalation_routine.py
    python3 token_gap_escalation_routine.py --dry-run
    python3 token_gap_escalation_routine.py --issue-id <issue-id>

Environment variables:
    PAPERCLIP_API_URL: Paperclip API base URL
    PAPERCLIP_API_KEY: Paperclip API authentication key
    PAPERCLIP_COMPANY_ID: Paperclip company ID
"""

from __future__ import annotations

import argparse
import json
import logging
import os
import sys
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any, Optional

import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

REPO_ROOT = Path(__file__).resolve().parent.parent
STATE_FILE = REPO_ROOT / "data" / "token_gap_state.json"
LOG_FILE = Path.home() / ".paperclip" / "token_gap_escalation.log"

LOG_FILE.parent.mkdir(parents=True, exist_ok=True)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(message)s",
    handlers=[
        logging.FileHandler(LOG_FILE),
        logging.StreamHandler(),
    ],
)
logger = logging.getLogger("token_gap_escalation")

RETRY_STRATEGY = Retry(
    total=2,
    backoff_factor=0.5,
    status_forcelist=[408, 429, 500, 502, 503, 504],
    allowed_methods=["GET", "PATCH", "POST"],
)


def _http_session() -> requests.Session:
    """Create HTTP session with retries."""
    s = requests.Session()
    api_key = os.environ.get("PAPERCLIP_API_KEY", "")
    s.headers.update({
        "Authorization": f"Bearer {api_key}",
        "Content-Type": "application/json",
    })
    adapter = HTTPAdapter(max_retries=RETRY_STRATEGY)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def get_api_base() -> str:
    """Get Paperclip API base URL."""
    return os.environ.get("PAPERCLIP_API_URL", "http://localhost:3100")


def get_company_id() -> str:
    """Get Paperclip company ID."""
    return os.environ.get("PAPERCLIP_COMPANY_ID", "")


def load_state() -> dict[str, Any]:
    """Load escalation state file."""
    if not STATE_FILE.exists():
        return {"escalated": {}}

    try:
        with open(STATE_FILE, 'r') as f:
            return json.load(f)
    except (json.JSONDecodeError, IOError) as e:
        logger.warning("Failed to load state file: %s", e)
        return {"escalated": {}}


def save_state(state: dict[str, Any]) -> None:
    """Save escalation state file."""
    STATE_FILE.parent.mkdir(parents=True, exist_ok=True)
    with open(STATE_FILE, 'w') as f:
        json.dump(state, f, indent=2)


def should_escalate(issue_id: str) -> bool:
    """Check if an issue should be escalated based on 24h dedup."""
    state = load_state()
    escalated_dict = state.get("escalated", {})

    if issue_id not in escalated_dict:
        return True

    try:
        last_escalation_str = escalated_dict[issue_id]
        # Handle Z suffix properly
        if last_escalation_str.endswith("Z"):
            last_escalation_str = last_escalation_str[:-1] + "+00:00"
        # Remove any duplicate timezone info (e.g., +00:00Z -> +00:00)
        last_escalation_str = last_escalation_str.replace("+00:00Z", "+00:00").replace("Z", "+00:00")
        last_escalation = datetime.fromisoformat(last_escalation_str)
        now = datetime.now(timezone.utc)
        if now - last_escalation < timedelta(hours=24):
            return False
    except (ValueError, TypeError) as e:
        logger.warning("Failed to parse escalation timestamp for %s: %s", issue_id, e)

    return True


def record_escalation(issue_id: str) -> None:
    """Record an escalation in the state file."""
    state = load_state()
    escalated_dict = state.get("escalated", {})
    now = datetime.now(timezone.utc)
    # Store ISO format without Z suffix (will be reconstructed from +00:00)
    timestamp_str = now.isoformat()
    if not timestamp_str.endswith("Z"):
        timestamp_str = timestamp_str.split("+")[0] + "+00:00"
    escalated_dict[issue_id] = timestamp_str
    state["escalated"] = escalated_dict
    save_state(state)


def fetch_blocked_issues() -> list[dict[str, Any]]:
    """Fetch all blocked issues from Paperclip."""
    company_id = get_company_id()
    base_url = get_api_base()

    results: list[dict[str, Any]] = []
    params = {"status": "blocked", "limit": 100, "offset": 0}

    with _http_session() as sess:
        while True:
            try:
                resp = sess.get(
                    f"{base_url}/api/companies/{company_id}/issues",
                    params=params,
                    timeout=30,
                )
                resp.raise_for_status()
            except requests.RequestException as e:
                logger.error("Failed to fetch blocked issues: %s", e)
                return results

            data = resp.json()
            items = data if isinstance(data, list) else data.get("items", [])

            if not items:
                break

            results.extend(items)

            if len(items) < params["limit"]:
                break

            params["offset"] += params["limit"]

    return results


def is_token_gap_error(text: str) -> bool:
    """Check if text describes a GitHub API token gap error."""
    if not text:
        return False

    text_lower = text.lower()

    # Token gap patterns - improved to catch more variations
    patterns = [
        r"(?:api\.github\.com|github\.com/api|github\.com/api).*?(?:401|403)",
        r"(?:401|403).*?(?:api\.github\.com|github\.com/api|github\.com/api)",
        r"(?:401|403).*?(?:unauthorized|forbidden).*?(?:github|token)",
        r"github.*?(?:token|auth).*?(?:expired|invalid|revoked)",
        r"(?:401|403).*?(?:github|permission)",
    ]

    for pattern in patterns:
        if re.search(pattern, text_lower, re.IGNORECASE):
            return True

    return False


def get_issue_comments(issue_id: str) -> list[dict[str, Any]]:
    """Fetch comments for an issue."""
    company_id = get_company_id()
    base_url = get_api_base()

    try:
        with _http_session() as sess:
            resp = sess.get(
                f"{base_url}/api/issues/{issue_id}/comments",
                timeout=30,
            )
            resp.raise_for_status()
            data = resp.json()
            return data if isinstance(data, list) else data.get("items", [])
    except requests.RequestException as e:
        logger.warning("Failed to fetch comments for issue %s: %s", issue_id, e)
        return []


def has_token_gap_in_comments(issue_id: str) -> bool:
    """Check if issue comments contain token gap errors."""
    comments = get_issue_comments(issue_id)
    for comment in comments:
        body = comment.get("body", "")
        if is_token_gap_error(body):
            return True
    return False


def check_blocked_duration(issue: dict[str, Any]) -> float:
    """Check how long an issue has been blocked (in hours)."""
    # Try to get the time when it became blocked
    started_at = issue.get("startedAt")
    created_at = issue.get("createdAt")
    timestamp_str = started_at or created_at

    if not timestamp_str:
        return 0.0

    try:
        # Parse ISO timestamp
        if timestamp_str.endswith("Z"):
            timestamp_str = timestamp_str[:-1] + "+00:00"
        timestamp = datetime.fromisoformat(timestamp_str)
        now = datetime.now(timezone.utc)
        duration = (now - timestamp).total_seconds() / 3600.0
        return duration
    except (ValueError, TypeError) as e:
        logger.warning("Failed to parse timestamp %s: %s", timestamp_str, e)
        return 0.0


def create_escalation_issue(
    blocked_issue: dict[str, Any],
    dry_run: bool = False,
) -> Optional[str]:
    """Create an escalation issue for a token gap."""
    company_id = get_company_id()
    base_url = get_api_base()

    issue_id = blocked_issue.get("id")
    issue_identifier = blocked_issue.get("identifier", "?")
    issue_title = blocked_issue.get("title", "Unknown")
    blocked_duration = check_blocked_duration(blocked_issue)

    title = f"[ESCALATION] Token Gap: {issue_identifier} — {issue_title[:60]}"
    description = (
        f"## GitHub Token Gap Escalation\n\n"
        f"**Blocked Issue:** [{issue_identifier}](/{company_id[:8]}/issues/{issue_identifier})\n"
        f"**Title:** {issue_title}\n"
        f"**Duration Blocked:** {blocked_duration:.1f} hours\n"
        f"**Status:** Requires immediate attention — GitHub API token gap detected\n\n"
        f"The blocked issue contains error messages indicating a GitHub API token problem "
        f"(401/403 Unauthorized). The issue has been blocked for more than 4 hours.\n\n"
        f"**Action Required:** Verify and refresh the GitHub token credentials."
    )

    if dry_run:
        logger.info("[DRY-RUN] Would create escalation issue: %s", title)
        return None

    try:
        with _http_session() as sess:
            resp = sess.post(
                f"{base_url}/api/companies/{company_id}/issues",
                json={
                    "title": title[:200],
                    "description": description,
                    "priority": "critical",
                    "status": "todo",
                    "parentId": issue_id,
                    "blockedByIssueIds": [issue_id],
                    "labels": ["token-gap", "escalation"],
                },
                timeout=30,
            )
            resp.raise_for_status()
            created = resp.json()
            created_id = created.get("id")
            logger.info("Created escalation issue %s for %s", created.get("identifier"), issue_identifier)
            return created_id
    except requests.RequestException as e:
        logger.error("Failed to create escalation issue: %s", e)
        return None


def post_escalation_comment(
    issue_id: str,
    body: str,
    dry_run: bool = False,
) -> bool:
    """Post an escalation comment on the blocked issue."""
    base_url = get_api_base()

    if dry_run:
        logger.info("[DRY-RUN] Would post comment on issue %s", issue_id)
        return True

    try:
        with _http_session() as sess:
            resp = sess.post(
                f"{base_url}/api/issues/{issue_id}/comments",
                json={"body": body},
                timeout=30,
            )
            resp.raise_for_status()
            logger.info("Posted escalation comment on issue %s", issue_id)
            return True
    except requests.RequestException as e:
        logger.error("Failed to post comment: %s", e)
        return False


def process_blocked_issues(dry_run: bool = False) -> tuple[int, int]:
    """Process all blocked issues and escalate those with token gaps.

    Returns:
        (total_processed, total_escalated)
    """
    issues = fetch_blocked_issues()
    logger.info("Found %d blocked issues", len(issues))

    processed = 0
    escalated = 0

    for issue in issues:
        issue_id = issue.get("id")
        issue_identifier = issue.get("identifier", "?")

        if not issue_id:
            continue

        processed += 1

        # Check if this issue has a token gap error
        if not has_token_gap_in_comments(issue_id):
            logger.debug("No token gap found in %s", issue_identifier)
            continue

        # Check if blocked for more than 4 hours
        blocked_duration = check_blocked_duration(issue)
        if blocked_duration < 4.0:
            logger.debug(
                "%s blocked for %.1f hours (need 4+), skipping escalation",
                issue_identifier,
                blocked_duration,
            )
            continue

        # Check deduplication
        if not should_escalate(issue_id):
            logger.info("%s already escalated within 24h, skipping", issue_identifier)
            continue

        # Create escalation
        logger.info(
            "Escalating %s (blocked %.1f hours, token gap detected)",
            issue_identifier,
            blocked_duration,
        )

        escalation_id = create_escalation_issue(issue, dry_run=dry_run)
        if escalation_id or dry_run:
            comment_body = (
                "⚠️ **Escalation Posted**\n\n"
                "This issue has been blocked for >4 hours due to a GitHub API token gap. "
                "A CEO escalation has been created for immediate attention."
            )
            post_escalation_comment(issue_id, comment_body, dry_run=dry_run)

            if not dry_run:
                record_escalation(issue_id)

            escalated += 1

    return processed, escalated


def main() -> int:
    """Main entry point."""
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--dry-run", action="store_true",
                        help="Run in dry-run mode (no escalations)")
    parser.add_argument("--issue-id", help="Process specific issue ID only")
    args = parser.parse_args()

    api_key = os.environ.get("PAPERCLIP_API_KEY")
    if not api_key:
        logger.error("PAPERCLIP_API_KEY not set")
        return 1

    company_id = get_company_id()
    if not company_id:
        logger.error("PAPERCLIP_COMPANY_ID not set")
        return 1

    logger.info("Starting token-gap escalation routine (dry_run=%s)", args.dry_run)

    if args.issue_id:
        logger.info("Processing specific issue: %s", args.issue_id)
        # TODO: Fetch and process single issue
    else:
        processed, escalated = process_blocked_issues(dry_run=args.dry_run)
        logger.info(
            "Completed: processed %d issues, escalated %d",
            processed,
            escalated,
        )

    return 0


if __name__ == "__main__":
    sys.exit(main())
