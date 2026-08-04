#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import socket
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from typing import Any

DEFAULT_MUTATION_CATEGORIES = {
    "fallback_reassign",
    "outbound_dispatch",
    "routine_provision",
    "issue_creation",
    "issue_mutation",
}
DEFAULT_AGENT_CATEGORIES = {
    "agent_mutation",
    "agent_pause",
    "agent_resume",
}


def _run_id() -> str | None:
    return os.environ.get("PAPERCLIP_RUN_ID")


def _normalize_mode(value: Any) -> str:
    mode = str(value or "normal").strip().lower().replace("-", "_")
    return mode or "normal"


def _safe_json(payload: Any) -> str:
    if isinstance(payload, dict):
        return json.dumps(payload, sort_keys=True, separators=(",", ":"))
    return str(payload)


def _build_request(url: str, key: str) -> urllib.request.Request:
    req = urllib.request.Request(url)
    req.method = "GET"
    req.add_header("Authorization", f"Bearer {key}")
    run_id = _run_id()
    if run_id:
        req.add_header("X-Paperclip-Run-Id", run_id)
    return req


def _read_override() -> tuple[dict[str, Any], str] | None:
    raw = os.environ.get("PAPERCLIP_EMERGENCY_STOP_STATE")
    if not raw:
        return None
    try:
        parsed = json.loads(raw)
        if not isinstance(parsed, dict):
            raise ValueError("expected JSON object")
        return parsed, "env"
    except (json.JSONDecodeError, TypeError, ValueError) as exc:
        raise RuntimeError(f"invalid PAPERCLIP_EMERGENCY_STOP_STATE payload: {exc}") from exc


def _candidate_endpoints(base: str, company_id: str) -> list[str]:
    base = base.rstrip("/")
    explicit = os.environ.get("PAPERCLIP_EMERGENCY_STOP_URL")
    if explicit:
        if explicit.startswith("http://") or explicit.startswith("https://"):
            return [explicit.rstrip("/")]
        return [f"{base}{explicit if explicit.startswith('/') else '/' + explicit}"]

    return [
        f"{base}/api/companies/{company_id}/emergency-stop",
        f"{base}/api/companies/{company_id}/state/emergency-stop",
        f"{base}/api/portfolio/emergency-stop",
        f"{base}/api/emergency-stop",
    ]


def fetch_state(base: str, key: str, company_id: str) -> tuple[dict[str, Any], str, bool]:
    override = _read_override()
    if override is not None:
        return override[0], override[1], False

    for endpoint in _candidate_endpoints(base, company_id):
        # One retry with a longer timeout before failing secure: a single slow
        # read during a server restart/catch-up burst (2026-06-11: every
        # fallback-monitor tick in the busy hour no-opped on stop_mutation)
        # must not be indistinguishable from a real outage. Both attempts
        # timing out still fails secure to stop_mutation below.
        for attempt, read_timeout in enumerate((2, 5)):
            req = _build_request(endpoint, key)
            try:
                with urllib.request.urlopen(req, timeout=read_timeout) as resp:
                    raw = resp.read().decode("utf-8")
                    payload = json.loads(raw)
                    if not isinstance(payload, dict):
                        return {"mode": "normal"}, endpoint, True
                    return payload, endpoint, False
            except urllib.error.HTTPError as exc:
                # During rollout, the first implementation may not yet expose every endpoint yet.
                # Treat 404 as "contract not deployed here" and continue probing.
                if exc.code == 404:
                    break
                body = exc.read().decode("utf-8", errors="replace") if exc.fp is not None else ""
                return {
                    "mode": "stop_mutation",
                    "reason": f"emergency-stop read failed ({exc.code}): {body}",
                }, endpoint, False
            except (socket.timeout, TimeoutError, OSError, urllib.error.URLError):
                if attempt == 0:
                    continue
                return {
                    "mode": "stop_mutation",
                    "reason": f"emergency-stop read network error ({endpoint})",
                }, endpoint, False

    # Keep compatibility if the endpoint contract is not yet deployed in this
    # environment. Default to normal operation so the new guard does not hard-stop
    # non-critical maintenance flows before the endpoint exists.
    return {"mode": "normal", "note": "no emergency-stop endpoint available"}, "none", True


def guard_decision(
    *,
    category: str,
    base: str,
    key: str,
    company_id: str,
    allowlist: set[str] | None = None,
    strict: bool = False,
) -> dict[str, Any]:
    state, source, unreadable = fetch_state(base, key, company_id)
    mode = _normalize_mode(state.get("mode"))
    allow = set(allowlist or [])
    allowed_list = {str(x) for x in state.get("allowlist") or []}
    if allow:
        allowed_list |= set(allow)

    if category in allowed_list:
        return {
            "blocked": False,
            "mode": mode,
            "category": category,
            "source": source,
            "state": state,
            "readable": not unreadable,
            "reason": "category-allowlisted",
        }

    if mode in {"normal", "resume", "running", "go", "allow"}:
        return {
            "blocked": False,
            "mode": mode,
            "category": category,
            "source": source,
            "state": state,
            "readable": not unreadable,
            "reason": "normal-mode",
        }

    if mode in {"stop_agents"}:
        blocked = category in DEFAULT_AGENT_CATEGORIES
        return {
            "blocked": blocked,
            "mode": mode,
            "category": category,
            "source": source,
            "state": state,
            "readable": not unreadable,
            "reason": "agent-only-stop-mode",
        }

    if mode in {"stop_mutation", "recovery", "recover", "mutate", "stop"}:
        blocked = category in DEFAULT_MUTATION_CATEGORIES
        return {
            "blocked": blocked,
            "mode": mode,
            "category": category,
            "source": source,
            "state": state,
            "readable": not unreadable,
            "reason": "mutation-stop-mode",
        }

    # Unknown/legacy/custom modes are treated as blocked for mutation-style calls
    # unless strict=False and the source is simply missing (contract not deployed).
    if mode and mode not in {"normal", "resume", "running", "go", "allow"}:
        return {
            "blocked": category in DEFAULT_MUTATION_CATEGORIES,
            "mode": mode,
            "category": category,
            "source": source,
            "state": state,
            "readable": not unreadable,
            "reason": f"unrecognized-mode:{mode}",
        }

    return {
        "blocked": False,
        "mode": mode,
        "category": category,
        "source": source,
        "state": state,
        "readable": not unreadable,
        "reason": f"default-pass: mode={mode}",
    }


def guard_summary(decision: dict[str, Any]) -> str:
    state = decision.get("state") or {}
    mode = decision.get("mode")
    category = decision.get("category")
    if not decision.get("blocked"):
        return f"[{category}] emergency-stop check passed (mode={mode})"

    details = {
        "category": category,
        "mode": mode,
        "reason": decision.get("reason"),
        "state": state,
        "source": decision.get("source"),
    }
    return f"[{category}] blocked by emergency-stop: {_safe_json(details)}"


def include_audit_signature(category: str, decision: dict[str, Any]) -> dict[str, Any]:
    return {
        "category": category,
        "mode": decision.get("mode"),
        "blocked": decision.get("blocked"),
        "source": decision.get("source"),
        "readable": decision.get("readable"),
        "reason": decision.get("reason"),
        "checkedAt": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "state": decision.get("state"),
    }
