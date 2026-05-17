"""Thin Paperclip API client for Touch Index ingestion workers.

Reads PAPERCLIP_API_URL and PAPERCLIP_API_KEY from environment.
All methods return plain dicts (no schema binding).
"""

from __future__ import annotations

import logging
import os
from datetime import datetime, timezone
from typing import Any

import requests
from requests.adapters import HTTPAdapter
from urllib3.util import Retry

logger = logging.getLogger(__name__)
_PLACEHOLDER_PATTERNS = (
    "your_",
    "example.com",
    "00000000-0000-0000-0000-000000000000",
)

_REQUIRED_ENV_VARS = {
    "PAPERCLIP_API_URL": "Paperclip API base URL",
    "PAPERCLIP_API_KEY": "API bearer token",
    "PAPERCLIP_COMPANY_ID": "Company UUID",
}


def check_paperclip_credentials() -> str | None:
    """Validate Paperclip credential env vars, returning an error message or None.

    Checks that required variables are set, non-empty, and don't contain
    placeholder values from the template .env.example.  Returns a
    human-readable error string on failure, or None when all checks pass.
    """
    missing: list[str] = []
    placeholders: list[str] = []
    for var, desc in _REQUIRED_ENV_VARS.items():
        val = os.environ.get(var, "")
        if not val:
            missing.append(f"{var} ({desc})")
        elif any(p in val.lower() for p in _PLACEHOLDER_PATTERNS):
            placeholders.append(f"{var}={val!r}")
    if missing:
        return (
            f"Missing Paperclip environment variable(s): {', '.join(missing)}. "
            "Set them in .env or export before running."
        )
    if placeholders:
        return (
            f"Paperclip environment variable(s) still contain placeholder values: "
            f"{'; '.join(placeholders)}. "
            "Replace them with real credentials in .env."
        )
    return None


# Retry strategy for Paperclip API calls — exponential backoff, 3 attempts
_RETRY_STRATEGY = Retry(
    total=3,
    backoff_factor=0.5,
    status_forcelist=[408, 429, 500, 502, 503, 504],
    allowed_methods=["GET", "PATCH", "POST"],
    raise_on_status=False,
)

# FDR label identifies Feature Design Requirements (FRs)
FDR_LABEL_ID = "d523cb2d-acd9-423d-b87a-bb79cee42c40"

# Bug title prefixes used by the team for formal bug issues
_BUG_TITLE_PREFIXES = ("bug:", "bug ")


def _parse_iso_ts(raw: str | None) -> datetime | None:
    """Parse an ISO timestamp string, returning None on malformed input."""
    if raw is None or raw == "":
        return None
    if not isinstance(raw, str):
        return None
    try:
        return datetime.fromisoformat(raw.replace("Z", "+00:00"))
    except ValueError:
        return None


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update(
        {
            "Authorization": f"Bearer {os.environ['PAPERCLIP_API_KEY']}",
            "Content-Type": "application/json",
        }
    )
    adapter = HTTPAdapter(max_retries=_RETRY_STRATEGY)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def _board_session() -> requests.Session:
    key = os.environ.get("PAPERCLIP_BOARD_API_KEY") or os.environ["PAPERCLIP_API_KEY"]
    s = requests.Session()
    s.headers.update(
        {
            "Authorization": f"Bearer {key}",
            "Content-Type": "application/json",
        }
    )
    adapter = HTTPAdapter(max_retries=_RETRY_STRATEGY)
    s.mount("https://", adapter)
    s.mount("http://", adapter)
    return s


def _base() -> str:
    return os.environ["PAPERCLIP_API_URL"]


def _company() -> str:
    return os.environ["PAPERCLIP_COMPANY_ID"]


def _paginate(
    path: str,
    params: dict[str, Any],
    *,
    page_size: int = 100,
) -> list[dict]:
    with _session() as sess:
        results: list[dict] = []
        params = {**params, "limit": page_size, "offset": 0}
        while True:
            resp = sess.get(f"{_base()}{path}", params=params, timeout=30)
            resp.raise_for_status()
            page = resp.json()
            if not page:
                break
            results.extend(page)
            if len(page) < page_size:
                break
            params["offset"] += page_size
        return results


def get_issue_by_id(issue_id: str) -> dict | None:
    """Fetch a single issue by its UUID."""
    with _session() as sess:
        resp = sess.get(f"{_base()}/api/issues/{issue_id}", timeout=30)
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


def get_issue_status(issue_id: str) -> str | None:
    """Fetch just the status field for an issue, or None on 404/error.

    Lighter than get_issue_by_id when only the status is needed (e.g. done-guard checks).
    """
    try:
        with _session() as sess:
            resp = sess.get(f"{_base()}/api/issues/{issue_id}", timeout=15)
            if resp.status_code == 404:
                return None
            resp.raise_for_status()
            return (resp.json() or {}).get("status")
    except Exception:
        return None


def is_issue_done(issue_id: str) -> bool:
    """Return True if the issue exists and has status 'done'."""
    return get_issue_status(issue_id) == "done"


def get_issue_by_identifier(identifier: str) -> dict | None:
    """Fetch a single issue by its identifier (e.g. 'BTCAAAAA-1085')."""
    issues = _paginate(
        f"/api/companies/{_company()}/issues",
        {"q": identifier, "limit": 5},
        page_size=5,
    )
    for i in issues:
        if i["identifier"] == identifier:
            return i
    return None


def get_fdr_issues(updated_after: datetime | None = None) -> list[dict]:
    """Return all FDR-labelled issues, optionally filtered by updatedAt."""
    params: dict[str, Any] = {
        "labelId": FDR_LABEL_ID,
        "status": "todo,in_progress,in_review,done",
    }
    issues = _paginate(f"/api/companies/{_company()}/issues", params)
    if updated_after:
        cutoff = updated_after.astimezone(timezone.utc)
        filtered: list[dict] = []
        for i in issues:
            ts = _parse_iso_ts(i.get("updatedAt"))
            if ts is None:
                filtered.append(i)
                continue
            if ts >= cutoff:
                filtered.append(i)
        issues = filtered
    return issues


def get_closed_bug_issues(closed_after: datetime | None = None) -> list[dict]:
    """Return done issues identified as bugs (title prefix 'Bug:'/'BUG:')."""
    params: dict[str, Any] = {"status": "done"}
    issues = _paginate(f"/api/companies/{_company()}/issues", params)
    bugs = [i for i in issues if _is_bug(i["title"])]
    if closed_after:
        cutoff = closed_after.astimezone(timezone.utc)
        filtered: list[dict] = []
        for b in bugs:
            ts = _parse_iso_ts(b.get("completedAt"))
            if ts is None:
                filtered.append(b)
                continue
            if ts >= cutoff:
                filtered.append(b)
        bugs = filtered
    return bugs


def get_closed_non_fdr_issues(closed_after: datetime | None = None) -> list[dict]:
    """Return done non-FDR issues, optionally filtered by completedAt.

    Broader than get_closed_bug_issues: captures any issue that has
    ``fix(BTCAAAAA-NNN)`` commits in git, regardless of title prefix.
    FDR-labelled issues are excluded (they are ingested by the FR worker).
    """
    params: dict[str, Any] = {"status": "done"}
    issues = _paginate(f"/api/companies/{_company()}/issues", params)
    issues = [i for i in issues if FDR_LABEL_ID not in (i.get("labelIds") or [])]
    if closed_after:
        cutoff = closed_after.astimezone(timezone.utc)
        filtered: list[dict] = []
        for i in issues:
            ts = _parse_iso_ts(i.get("completedAt"))
            if ts is None:
                filtered.append(i)
                continue
            if ts >= cutoff:
                filtered.append(i)
        issues = filtered
    return issues


def get_all_done_issues(completed_after: datetime | None = None) -> list[dict]:
    """Return ALL done issues, optionally filtered by completedAt.

    Used by the backfill to capture fix-type issues that don't carry a 'Bug:'
    title prefix but do have ``fix(BTCAAAAA-NNN)`` commits in git history.
    """
    params: dict[str, Any] = {"status": "done"}
    issues = _paginate(f"/api/companies/{_company()}/issues", params)
    if completed_after:
        cutoff = completed_after.astimezone(timezone.utc)
        filtered: list[dict] = []
        for i in issues:
            ts = _parse_iso_ts(i.get("completedAt"))
            if ts is None:
                filtered.append(i)
                continue
            if ts >= cutoff:
                filtered.append(i)
        issues = filtered
    return issues


def get_all_issue_ids() -> set[str]:
    """Fetch ALL issue IDs from Paperclip (paginated) and return as a set.

    Used by quality.check_consistency and check_bug_consistency to detect
    orphan rows in a single batch instead of O(n) individual API calls.
    """
    all_issues = _paginate(
        f"/api/companies/{_company()}/issues",
        {"limit": 200},
    )
    return {i["id"] for i in all_issues}


def transition_issue_status(issue_id: str, status: str) -> None:
    """Transition an issue to *status* via the Paperclip API.

    Args:
        issue_id: The Paperclip issue UUID.
        status:   Target status (e.g. "done").

    Raises:
        requests.RequestException on API error.
    """
    with _session() as sess:
        resp = sess.patch(
            f"{_base()}/api/issues/{issue_id}",
            json={"status": status},
            timeout=30,
        )
        resp.raise_for_status()


def get_issue_assignee(issue: dict) -> str | None:
    return issue.get("assigneeAgentId")


def _is_bug(title: str) -> bool:
    lower = title.lower()
    return any(lower.startswith(p) for p in _BUG_TITLE_PREFIXES)


def list_live_runs(
    min_count: int = 50,
    limit: int = 50,
) -> list[dict]:
    """List live (queued+running) heartbeat runs for the company.

    Each run dict includes an ``outputSilence`` field with staleness metadata:
      - level: "ok" | "suspicious" | "critical" | "snoozed" | "not_applicable"
      - silenceAgeMs: milliseconds since last output (None if never)
      - lastOutputAt: ISO timestamp or None
    """
    params: dict[str, Any] = {"minCount": str(min_count), "limit": str(limit)}
    with _session() as sess:
        resp = sess.get(
            f"{_base()}/api/companies/{_company()}/live-runs",
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


def cancel_heartbeat_run(run_id: str) -> dict | None:
    """Cancel a heartbeat run via the board-level admin endpoint.

    Requires ``PAPERCLIP_BOARD_API_KEY`` or a board-privileged
    ``PAPERCLIP_API_KEY``.  Returns the cancelled run dict or None if 404.
    """
    with _board_session() as sess:
        resp = sess.post(
            f"{_base()}/api/heartbeat-runs/{run_id}/cancel",
            timeout=30,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


def list_issues(
    status: str | None = None,
    limit: int = 200,
    offset: int = 0,
) -> list[dict]:
    """List issues for the company, optionally filtered by *status*.

    Status can be a single value ("in_progress") or comma-separated
    ("todo,in_progress,done").
    """
    params: dict[str, Any] = {"limit": str(limit), "offset": str(offset)}
    if status:
        params["status"] = status
    with _session() as sess:
        resp = sess.get(
            f"{_base()}/api/companies/{_company()}/issues",
            params=params,
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


def transition_issue_status_board(issue_id: str, status: str) -> None:
    """Transition an issue to *status* using the board-level API key.

    Bypasses the checkoutRunId validation that would block normal agent
    transitions for ``in_progress`` issues owned by a dead/ghost run.

    Includes a done-guard: refuses to transition a ``done`` issue to a
    non-``done`` status to prevent agent-comment-triggered reopen loops
    (BTCAAAAA-25832).  Transitioning TO ``done`` is always allowed.

    Requires ``PAPERCLIP_BOARD_API_KEY`` or a board-privileged key.
    """
    if status != "done" and is_issue_done(issue_id):
        logger.warning(
            "transition_issue_status_board: refusing to transition done "
            "issue %s to %r — done-guard active (BTCAAAAA-25832)",
            issue_id,
            status,
        )
        return

    with _board_session() as sess:
        resp = sess.patch(
            f"{_base()}/api/issues/{issue_id}",
            json={"status": status},
            timeout=30,
        )
        if resp.status_code == 403:
            logger.warning(
                "transition_issue_status_board: board-level transition not "
                "available for issue %s (status=%r) — insufficient permissions. "
                "Data ingestion already complete.",
                issue_id,
                status,
            )
            return
        resp.raise_for_status()


def force_release_issue(
    issue_id: str,
    clear_assignee: bool = False,
) -> dict | None:
    """Admin force-release an issue, clearing its checkout lock.

    Requires board-level API key.  Returns the release result dict
    or None if 404.
    """
    with _board_session() as sess:
        params = "?clearAssignee=true" if clear_assignee else ""
        resp = sess.post(
            f"{_base()}/api/issues/{issue_id}/admin/force-release{params}",
            timeout=30,
        )
        if resp.status_code == 404:
            return None
        resp.raise_for_status()
        return resp.json()


def fetch_issue_comments(issue_id: str) -> list[dict]:
    """Fetch all comments for an issue via the Paperclip API.

    Returns a list of comment dicts sorted by creation time (oldest first).
    Each comment dict includes at least ``id``, ``body``, ``createdAt``.
    """
    with _session() as sess:
        resp = sess.get(f"{_base()}/api/issues/{issue_id}/comments", timeout=30)
        resp.raise_for_status()
        return resp.json()


def post_issue_comment(issue_id: str, body: str, *, board_session: bool = False) -> dict:
    """Post a comment on an issue.

    Args:
        issue_id: The Paperclip issue UUID.
        body: Comment body (Markdown).
        board_session: Use board-level API key (bypasses checkoutRunId validation).

    Returns the created comment dict.
    """
    sess_factory = _board_session if board_session else _session
    with sess_factory() as sess:
        resp = sess.post(
            f"{_base()}/api/issues/{issue_id}/comments",
            json={"body": body},
            timeout=30,
        )
        resp.raise_for_status()
        return resp.json()


IMPACT_GATE_BYPASS_LABEL_ID = "impact-gate-bypass"
