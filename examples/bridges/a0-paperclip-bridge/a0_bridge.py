#!/usr/bin/env python3
"""Paperclip ↔ Agent Zero bridge.

This bridge accepts Paperclip's fire-and-forget HTTP handoff and performs the
rest of the heartbeat protocol asynchronously:

1. Resolve the target issue from the payload.
2. Checkout the issue in Paperclip with `X-Paperclip-Run-Id`.
3. Load compact task context from `/issues/{id}/heartbeat-context`.
4. Forward the task message to Agent Zero.
5. Update the Paperclip issue with a final status + comment.
"""

from __future__ import annotations

import logging
import os
import signal
import threading
import time
from typing import Any

import requests
from flask import Flask, jsonify, request

app = Flask(__name__)
logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] %(message)s")
log = logging.getLogger("paperclip_a0_bridge")

A0_URL = os.environ.get("A0_URL", "http://localhost:5090/api/api_message")
A0_API_KEY = os.environ.get("A0_API_KEY", "")
A0_TIMEOUT = int(os.environ.get("A0_TIMEOUT", "600"))
PAPERCLIP_API = os.environ.get("PAPERCLIP_API", "http://localhost:3100/api").rstrip("/")
PAPERCLIP_API_KEY = os.environ.get("PAPERCLIP_API_KEY", "")
BRIDGE_PORT = int(os.environ.get("BRIDGE_PORT", "8090"))
PC_RETRY_ATTEMPTS = max(1, int(os.environ.get("PC_RETRY_ATTEMPTS", "3")))
PC_RETRY_BASE_DELAY = max(1, int(os.environ.get("PC_RETRY_BASE_DELAY", "2")))

_shutdown_event = threading.Event()
_issue_locks: dict[str, threading.Lock] = {}
_locks_mutex = threading.Lock()
_active_workers = 0
_active_workers_mutex = threading.Lock()


def _paperclip_headers(run_id: str | None = None) -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if PAPERCLIP_API_KEY:
        headers["Authorization"] = f"Bearer {PAPERCLIP_API_KEY}"
    if run_id:
        headers["X-Paperclip-Run-Id"] = run_id
    return headers


def _agent_zero_headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if A0_API_KEY:
        headers["X-API-KEY"] = A0_API_KEY
    return headers


def _pc_url(path: str) -> str:
    return f"{PAPERCLIP_API}/{path.lstrip('/')}"


def _get_issue_lock(issue_id: str) -> threading.Lock:
    with _locks_mutex:
        if issue_id not in _issue_locks:
            _issue_locks[issue_id] = threading.Lock()
        return _issue_locks[issue_id]


def _cleanup_issue_lock(issue_id: str) -> None:
    with _locks_mutex:
        lock = _issue_locks.get(issue_id)
        if lock and not lock.locked():
            del _issue_locks[issue_id]


def _track_worker(active: bool) -> None:
    global _active_workers
    with _active_workers_mutex:
        if active:
            _active_workers += 1
        else:
            _active_workers = max(0, _active_workers - 1)


def _retry_delay(attempt: int) -> int:
    return PC_RETRY_BASE_DELAY ** attempt


def pc_get_issue(issue_id: str) -> dict[str, Any] | None:
    try:
        response = requests.get(_pc_url(f"issues/{issue_id}"), headers=_paperclip_headers(), timeout=10)
        if response.ok:
            return response.json()
        log.warning("Paperclip issue GET failed for %s: HTTP %s", issue_id, response.status_code)
    except Exception as exc:  # pragma: no cover - defensive runtime path
        log.warning("Paperclip issue GET error for %s: %s", issue_id, exc)
    return None


def pc_get_heartbeat_context(issue_id: str) -> dict[str, Any] | None:
    try:
        response = requests.get(
            _pc_url(f"issues/{issue_id}/heartbeat-context"),
            headers=_paperclip_headers(),
            timeout=10,
        )
        if response.ok:
            return response.json()
        log.warning("Heartbeat context failed for %s: HTTP %s", issue_id, response.status_code)
    except Exception as exc:  # pragma: no cover - defensive runtime path
        log.warning("Heartbeat context error for %s: %s", issue_id, exc)
    return None


def pc_checkout(issue_id: str, agent_id: str, run_id: str) -> tuple[bool, dict[str, Any] | None]:
    try:
        response = requests.post(
            _pc_url(f"issues/{issue_id}/checkout"),
            headers=_paperclip_headers(run_id),
            json={
                "agentId": agent_id,
                "expectedStatuses": ["todo", "backlog", "blocked", "in_progress"],
            },
            timeout=10,
        )
        if response.status_code in (200, 201):
            return True, None
        if response.status_code == 409:
            issue = pc_get_issue(issue_id)
            if issue and issue.get("status") == "in_progress" and issue.get("assigneeAgentId") == agent_id:
                log.info("Checkout conflict for %s but issue is already assigned to %s; continuing", issue_id, agent_id)
                return True, issue
            log.warning("Checkout conflict for %s and issue is not assigned to %s", issue_id, agent_id)
            return False, None
        issue = pc_get_issue(issue_id)
        if issue and issue.get("status") == "in_progress" and issue.get("assigneeAgentId") == agent_id:
            log.info(
                "Checkout returned HTTP %s for %s but issue is already in progress and assigned to %s",
                response.status_code,
                issue_id,
                agent_id,
            )
            return True, issue
        log.warning("Checkout failed for %s: HTTP %s", issue_id, response.status_code)
    except Exception as exc:  # pragma: no cover - defensive runtime path
        log.error("Checkout error for %s: %s", issue_id, exc)
    return False, None


def pc_add_comment(issue_id: str, body: str) -> bool:
    for attempt in range(1, PC_RETRY_ATTEMPTS + 1):
        try:
            response = requests.post(
                _pc_url(f"issues/{issue_id}/comments"),
                headers=_paperclip_headers(),
                json={"body": body},
                timeout=10,
            )
            if response.ok:
                return True
            log.warning(
                "Comment attempt %s failed for %s: HTTP %s",
                attempt,
                issue_id,
                response.status_code,
            )
        except Exception as exc:  # pragma: no cover - defensive runtime path
            log.warning("Comment attempt %s errored for %s: %s", attempt, issue_id, exc)
        if attempt < PC_RETRY_ATTEMPTS:
            time.sleep(_retry_delay(attempt))
    return False


def pc_update_issue(issue_id: str, run_id: str, status: str, comment: str) -> bool:
    for attempt in range(1, PC_RETRY_ATTEMPTS + 1):
        try:
            response = requests.patch(
                _pc_url(f"issues/{issue_id}"),
                headers=_paperclip_headers(run_id),
                json={"status": status, "comment": comment},
                timeout=10,
            )
            if response.ok:
                return True
            verified = pc_get_issue(issue_id)
            if verified and verified.get("status") == status:
                log.info(
                    "Issue %s verified as %s even though PATCH returned HTTP %s",
                    issue_id,
                    status,
                    response.status_code,
                )
                return True
            log.warning(
                "Issue update attempt %s failed for %s: HTTP %s",
                attempt,
                issue_id,
                response.status_code,
            )
        except Exception as exc:  # pragma: no cover - defensive runtime path
            log.warning("Issue update attempt %s errored for %s: %s", attempt, issue_id, exc)
        if attempt < PC_RETRY_ATTEMPTS:
            time.sleep(_retry_delay(attempt))
    return False


def _extract_issue_id(payload: dict[str, Any]) -> str | None:
    context = payload.get("context") if isinstance(payload.get("context"), dict) else {}
    wake = context.get("paperclipWake") if isinstance(context.get("paperclipWake"), dict) else {}
    wake_issue = wake.get("issue") if isinstance(wake.get("issue"), dict) else {}
    for candidate in (
        context.get("issueId"),
        context.get("taskId"),
        wake_issue.get("id"),
        wake.get("issueId"),
        wake.get("taskId"),
    ):
        if isinstance(candidate, str) and candidate.strip():
            return candidate.strip()
    return None


def _build_issue_payload(issue_id: str, prefetched_issue: dict[str, Any] | None) -> dict[str, Any] | None:
    if prefetched_issue:
        return prefetched_issue

    heartbeat_context = pc_get_heartbeat_context(issue_id)
    if heartbeat_context:
        issue = heartbeat_context.get("issue") if isinstance(heartbeat_context.get("issue"), dict) else None
        if issue:
            issue = dict(issue)
            issue["_project"] = heartbeat_context.get("project")
            issue["_goal"] = heartbeat_context.get("goal")
            issue["ancestors"] = heartbeat_context.get("ancestors") or []
            issue["_commentCursor"] = heartbeat_context.get("commentCursor")
            issue["_wakeComment"] = heartbeat_context.get("wakeComment")
            return issue

    return pc_get_issue(issue_id)


def _normalize_a0_response(payload: requests.Response) -> str | None:
    content_type = payload.headers.get("content-type", "")
    if "application/json" in content_type:
        data = payload.json()
        if isinstance(data, dict):
            for key in ("response", "text", "message", "content", "result"):
                value = data.get(key)
                if isinstance(value, str) and value.strip():
                    return value.strip()
        return str(data)
    text = payload.text.strip()
    return text or None


def a0_send(message: str) -> str | None:
    try:
        response = requests.post(
            A0_URL,
            headers=_agent_zero_headers(),
            json={"message": message},
            timeout=(10, A0_TIMEOUT),
        )
        if not response.ok:
            log.warning("Agent Zero returned HTTP %s", response.status_code)
            return None
        normalized = _normalize_a0_response(response)
        if normalized:
            log.info("Agent Zero response: %s", normalized[:240].replace("\n", " ↩ "))
        return normalized
    except Exception as exc:  # pragma: no cover - defensive runtime path
        log.error("Agent Zero request failed: %s", exc)
        return None


def build_task_message(issue: dict[str, Any], agent_id: str, run_id: str) -> str:
    identifier = issue.get("identifier") or issue.get("id") or "unknown"
    parts = [f"[Paperclip Task] {identifier}", f"Title: {issue.get('title', 'Untitled issue')}"]

    description = issue.get("description")
    if isinstance(description, str) and description.strip():
        parts.append("")
        parts.append(description.strip())

    if issue.get("priority"):
        parts.append(f"Priority: {issue.get('priority')}")

    project = issue.get("_project") if isinstance(issue.get("_project"), dict) else None
    if project:
        parts.append("")
        parts.append(f"Project: {project.get('name', '?')} (status: {project.get('status', '?')})")
        if project.get("targetDate"):
            parts.append(f"Target date: {project.get('targetDate')}")

    goal = issue.get("_goal") if isinstance(issue.get("_goal"), dict) else None
    if goal:
        parts.append(f"Goal: {goal.get('name') or goal.get('title') or '?'}")

    ancestors = issue.get("ancestors") if isinstance(issue.get("ancestors"), list) else []
    if ancestors:
        parts.append("")
        parts.append("Context (parent chain):")
        for ancestor in ancestors:
            if not isinstance(ancestor, dict):
                continue
            parts.append(f"- {ancestor.get('identifier', '?')}: {ancestor.get('title', '?')}")

    cursor = issue.get("_commentCursor") if isinstance(issue.get("_commentCursor"), dict) else None
    if cursor:
        parts.append("")
        parts.append(f"Existing comments: {cursor.get('totalComments', 0)}")

    wake_comment = issue.get("_wakeComment") if isinstance(issue.get("_wakeComment"), dict) else None
    if wake_comment and isinstance(wake_comment.get("body"), str) and wake_comment["body"].strip():
        parts.append("")
        parts.append("Wake comment:")
        parts.append(wake_comment["body"].strip())

    parts.append("")
    parts.append(f"Paperclip: agentId={agent_id}, runId={run_id}")
    return "\n".join(parts)


def _process_inner(payload: dict[str, Any], agent_id: str, run_id: str, issue_id: str) -> None:
    can_proceed, prefetched_issue = pc_checkout(issue_id, agent_id, run_id)
    if not can_proceed:
        return

    issue = _build_issue_payload(issue_id, prefetched_issue)
    if not issue:
        pc_update_issue(issue_id, run_id, "blocked", "Bridge could not read the issue context from Paperclip.")
        return

    identifier = issue.get("identifier") or issue_id
    if prefetched_issue is None:
        pc_add_comment(issue_id, f"🟢 Working on {identifier}…")

    message = build_task_message(issue, agent_id, run_id)
    response = a0_send(message)
    if response:
        summary = response if len(response) <= 1200 else response[:1200].rstrip() + "…"
        pc_update_issue(issue_id, run_id, "done", f"Completed {identifier}.\n\n{summary}")
    else:
        pc_update_issue(
            issue_id,
            run_id,
            "blocked",
            f"Agent Zero failed to process {identifier}. Check bridge logs and the Agent Zero endpoint.",
        )


def process_payload(payload: dict[str, Any]) -> None:
    agent_id = str(payload.get("agentId") or "unknown")
    run_id = str(payload.get("runId") or "unknown")
    issue_id = _extract_issue_id(payload)

    if not issue_id:
        log.info("Skipping payload without an issue id")
        return
    if _shutdown_event.is_set():
        log.info("Shutdown in progress; skipping issue %s", issue_id)
        return

    lock = _get_issue_lock(issue_id)
    if not lock.acquire(blocking=False):
        log.info("Issue %s is already being processed; skipping duplicate invoke", issue_id)
        return

    try:
        _track_worker(True)
        _process_inner(payload, agent_id, run_id, issue_id)
    finally:
        _track_worker(False)
        lock.release()
        _cleanup_issue_lock(issue_id)


@app.route("/invoke", methods=["POST"])
def invoke() -> Any:
    payload = request.get_json(force=True, silent=True) or {}
    issue_id = _extract_issue_id(payload)

    if _shutdown_event.is_set():
        return jsonify({"status": "rejected", "reason": "shutting_down"}), 503
    if not issue_id:
        return jsonify({"status": "skipped", "reason": "no_issue"})

    thread = threading.Thread(target=process_payload, args=(payload,), daemon=False)
    thread.start()
    return jsonify({
        "status": "accepted",
        "issueId": issue_id,
        "agentId": payload.get("agentId"),
        "runId": payload.get("runId"),
    })


@app.route("/health", methods=["GET"])
def health() -> Any:
    with _active_workers_mutex:
        workers = _active_workers
    return jsonify(
        {
            "status": "ok",
            "paperclip_api": PAPERCLIP_API,
            "a0_url": A0_URL,
            "a0_timeout": A0_TIMEOUT,
            "active_workers": workers,
            "shutdown_pending": _shutdown_event.is_set(),
        }
    )


def _signal_handler(signum: int, _frame: Any) -> None:
    log.info("Received signal %s — draining new work", signum)
    _shutdown_event.set()


if __name__ == "__main__":
    signal.signal(signal.SIGTERM, _signal_handler)
    signal.signal(signal.SIGINT, _signal_handler)
    log.info("Agent Zero bridge starting on port %s", BRIDGE_PORT)
    log.info("Paperclip API: %s", PAPERCLIP_API)
    log.info("Agent Zero URL: %s (timeout=%ss)", A0_URL, A0_TIMEOUT)
    app.run(host="0.0.0.0", port=BRIDGE_PORT)
