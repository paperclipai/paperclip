"""Dünner, stdlib-only Client für die Paperclip Control-Plane (:3100)."""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request

DEFAULT_BASE = "http://localhost:3100"


class ApiError(RuntimeError):
    pass


def load_token(auth_path: str | None = None) -> str:
    auth_path = auth_path or os.path.expanduser("~/.paperclip/auth.json")
    try:
        with open(auth_path) as fh:
            data = json.load(fh)
    except (OSError, ValueError):
        return ""
    creds = (data or {}).get("credentials", {})
    entry = creds.get(DEFAULT_BASE) or creds.get("http://127.0.0.1:3100") or {}
    return entry.get("token", "")


def _post(url: str, token: str, payload: dict) -> dict:
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {token}"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            raw = r.read().decode("utf-8") or "{}"
            return json.loads(raw)
    except urllib.error.HTTPError as e:
        raise ApiError(f"HTTP {e.code} for {url}") from e
    except Exception as e:  # noqa: BLE001
        raise ApiError(f"request failed for {url}: {e}") from e


def create_issue(base: str, token: str, company_id: str, *, title: str,
                 description: str, assignee_agent_id: str | None,
                 priority: str = "medium", parent_id: str | None = None) -> str:
    payload = {"title": title, "description": description, "priority": priority}
    if assignee_agent_id:
        payload["assigneeAgentId"] = assignee_agent_id
    if parent_id:
        payload["parentId"] = parent_id
    out = _post(f"{base}/api/companies/{company_id}/issues", token, payload)
    return out.get("id", "")


def add_comment(base: str, token: str, issue_id: str, body: str) -> None:
    _post(f"{base}/api/issues/{issue_id}/comments", token, {"body": body})
