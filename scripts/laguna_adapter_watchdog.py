#!/usr/bin/env python3
"""Read-only Laguna adapter and Node B Ollama watchdog.

The only control-plane writes this script can make are owner-wake/digest/request
comments.  It never calls status mutation routes or a service restart.
"""

import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


EXPECTED_MODEL = os.environ.get("LAGUNA_MODEL", "laguna-s-2.1:q4_K_M")
OLLAMA_BASE = os.environ.get("OLLAMA_BASE_URL", "http://192.168.86.152:11434").rstrip("/")
AGENT_IDS = {
    "Executor": "9a20c1b5-a039-4c18-8962-2825e3f28538",
    "Iterator": "2eae0d23-158c-4962-a332-111e5d6f4b03",
    "Reviewer": "0acb5c9f-ef99-43d7-8ed2-d001b66baf66",
    "Planner": "3e89a9e8-29df-490c-8dfd-97b67559018c",
    "Director": "f04912bb-babe-45a9-9774-bb998668a869",
}
CAP = int(os.environ.get("LAGUNA_WATCHDOG_NUDGE_CAP", "2"))
STALE_MINUTES = float(os.environ.get("LAGUNA_WATCHDOG_STALE_MINUTES", "45"))
STATE_ISSUE = os.environ.get(
    "LAGUNA_WATCHDOG_STATE_ISSUE",
    "f5c9151b-f233-4bcc-a9ff-853eb7b4470e",
)
DIGEST_ID = os.environ.get("LAGUNA_WATCHDOG_DIGEST_AGENT_ID", "1e0167fe-1f74-43ea-ad89-36fa724ab80a")
DIGEST_NAME = os.environ.get("LAGUNA_WATCHDOG_DIGEST_AGENT_NAME", "Digest")
BOARD_ID = os.environ.get("LAGUNA_WATCHDOG_BOARD_AGENT_ID", "b0f67cc2-259e-477b-ac89-d0ff4e7c8e89")
BOARD_NAME = os.environ.get("LAGUNA_WATCHDOG_BOARD_AGENT_NAME", "CEO")
MODE = sys.argv[1] if len(sys.argv) > 1 else "live"


def models(payload):
    value = payload.get("models", []) if isinstance(payload, dict) else []
    return value if isinstance(value, list) else []


def model_name(item):
    if isinstance(item, str):
        return item
    if isinstance(item, dict):
        return str(item.get("name") or item.get("model") or "")
    return ""


def inspect_ollama(ps_payload, tags_payload, environment):
    resident = [model_name(item) for item in models(ps_payload) if model_name(item)]
    tagged = [model_name(item) for item in models(tags_payload) if model_name(item)]
    findings = []
    if EXPECTED_MODEL not in resident:
        findings.append({"kind": "model_evicted", "model": EXPECTED_MODEL, "resident": resident})
    extra = [name for name in resident if name != EXPECTED_MODEL]
    if extra:
        findings.append({"kind": "second_model_loaded", "models": extra})
    if len(resident) != 1 or (resident and resident[0] != EXPECTED_MODEL):
        findings.append({"kind": "single_resident_violation", "resident": resident, "expected": EXPECTED_MODEL})
    if extra or str(environment.get("OLLAMA_MAX_LOADED_MODELS", "")) != "1":
        findings.append({
            "kind": "headroom_policy_violation",
            "expected": "OLLAMA_MAX_LOADED_MODELS=1",
            "observed": environment.get("OLLAMA_MAX_LOADED_MODELS"),
        })
    if EXPECTED_MODEL not in tagged:
        findings.append({"kind": "model_tag_missing", "model": EXPECTED_MODEL, "tags": tagged})
    return findings


def parse_time(value):
    if not value:
        return None
    try:
        return datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except ValueError:
        return None


def inspect_agent(agent):
    status = str(agent.get("status") or agent.get("state") or "").lower()
    adapter_status = str(agent.get("adapterStatus") or agent.get("adapter_state") or "").lower()
    error_text = " ".join(
        str(agent.get(key) or "").lower()
        for key in ("errorReason", "lastError", "adapterError")
    )
    findings = []
    if (
        status in {"error", "adapter_failed"}
        or adapter_status in {"error", "adapter_failed"}
        or "adapter_failed" in error_text
    ):
        findings.append({
            "kind": "adapter_failed",
            "agent_id": agent.get("id"),
            "agent_name": agent.get("name") or agent.get("role") or agent.get("id"),
            "status": status or adapter_status,
        })
    if status == "running" and not agent.get("activeRunId"):
        findings.append({
            "kind": "ghost_running",
            "agent_id": agent.get("id"),
            "agent_name": agent.get("name") or agent.get("role") or agent.get("id"),
        })
    if status == "running":
        observed = next(
            (agent.get(key) for key in ("lastHeartbeatAt", "lastRunAt", "updatedAt") if agent.get(key)),
            None,
        )
        parsed = parse_time(observed)
        if parsed and (datetime.now(timezone.utc) - parsed).total_seconds() > STALE_MINUTES * 60:
            findings.append({
                "kind": "stuck_running",
                "agent_id": agent.get("id"),
                "agent_name": agent.get("name") or agent.get("role") or agent.get("id"),
                "observed_at": observed,
            })
    return findings


def recovery_actions(findings, nudge_counts, cap=CAP):
    """Convert findings to bounded safe actions without mutating any status."""
    actions = []
    seen_agents = set()
    for finding in findings:
        agent_id = finding.get("agent_id")
        agent_name = finding.get("agent_name") or agent_id
        if finding["kind"] in {"adapter_failed", "ghost_running", "stuck_running"} and agent_id:
            if agent_id in seen_agents:
                continue
            seen_agents.add(agent_id)
            count = int(nudge_counts.get(agent_id, 0))
            if count < cap:
                actions.append({
                    "kind": "owner_wake",
                    "agent_id": agent_id,
                    "agent_name": agent_name,
                    "nudge_number": count + 1,
                    "reason": finding["kind"],
                })
            else:
                actions.append({
                    "kind": "digest_surface",
                    "agent_id": agent_id,
                    "agent_name": agent_name,
                    "reason": f"nudge-cap-exhausted:{finding['kind']}",
                })
            if finding["kind"] == "ghost_running":
                actions.append({
                    "kind": "request",
                    "request": "board_agent_status_reset",
                    "agent_id": agent_id,
                    "agent_name": agent_name,
                    "reason": "ghost running state requires board-owned reset",
                })
        elif finding["kind"] in {
            "model_evicted",
            "second_model_loaded",
            "single_resident_violation",
            "headroom_policy_violation",
            "model_tag_missing",
        }:
            if not any(
                action.get("request") == "root_ollama_restart" for action in actions
            ):
                actions.append({
                    "kind": "request",
                    "request": "root_ollama_restart",
                    "reason": finding["kind"],
                    "model": EXPECTED_MODEL,
                })
    return actions


def api_request(method, path, payload=None):
    api = os.environ.get("PAPERCLIP_API_URL", "").rstrip("/")
    if api.endswith("/api"):
        api = api[:-4]
    if not api or not os.environ.get("PAPERCLIP_API_KEY"):
        return 0, {"error": "PAPERCLIP_API_URL/API_KEY unavailable"}
    data = json.dumps(payload).encode("utf-8") if payload is not None else None
    request = urllib.request.Request(
        api + path,
        data=data,
        method=method,
        headers={
            "Authorization": "Bearer " + os.environ["PAPERCLIP_API_KEY"],
            "Content-Type": "application/json",
        },
    )
    run_id = os.environ.get("PAPERCLIP_RUN_ID")
    if run_id:
        request.add_header("X-Paperclip-Run-Id", run_id)
    try:
        with urllib.request.urlopen(request, timeout=20) as response:
            return response.status, response.read().decode("utf-8")
    except urllib.error.HTTPError as error:
        return error.code, error.read().decode("utf-8")[:200]
    except OSError as error:
        return 0, str(error)


def ollama_get(path):
    request = urllib.request.Request(OLLAMA_BASE + path, method="GET")
    try:
        with urllib.request.urlopen(request, timeout=10) as response:
            return json.loads(response.read().decode("utf-8"))
    except (OSError, ValueError, urllib.error.HTTPError) as error:
        raise RuntimeError(f"ollama {path}: {error}") from error


def read_ledger():
    explicit = os.environ.get("LAGUNA_WATCHDOG_LEDGER")
    scratch = os.environ.get("PAPERCLIP_SCRATCH_DIR") or os.environ.get("PAPERCLIP_RUN_SCRATCH_DIR")
    path = Path(explicit or (Path(scratch) / "laguna-watchdog-ledger.json" if scratch else "/tmp/laguna-watchdog-ledger.json"))
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        payload = {}
    payload.setdefault("nudges", {})
    payload.setdefault("states", [])
    payload["_path"] = path
    return payload


def write_ledger(ledger):
    path = ledger.pop("_path")
    path.parent.mkdir(parents=True, exist_ok=True)
    temp = path.with_suffix(path.suffix + ".tmp")
    temp.write_text(json.dumps(ledger, indent=2) + "\n", encoding="utf-8")
    os.replace(temp, path)


def action_key(action):
    return json.dumps({key: action.get(key) for key in sorted(action) if key != "nudge_number"}, sort_keys=True)


def apply_actions(actions, dry=False):
    ledger = read_ledger()
    emitted = []
    for action in actions:
        key = action_key(action)
        if key in ledger["states"]:
            emitted.append(dict(action, result="deduped"))
            continue
        if dry:
            emitted.append(dict(action, result="would-request"))
            continue
        if action["kind"] == "owner_wake":
            body = (
                f"**Laguna watchdog owner wake** — [@{action['agent_name']}](agent://{action['agent_id']}), "
                f"resume your own assigned work. Detection: `{action['reason']}`. "
                f"This is bounded wake {action['nudge_number']}/{CAP}; no status change was attempted."
            )
            status, response = api_request("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": body})
            result = f"owner-wake:{status}"
        else:
            target = DIGEST_ID if action["kind"] == "digest_surface" else BOARD_ID
            target_name = DIGEST_NAME if action["kind"] == "digest_surface" else BOARD_NAME
            body = (
                f"[@{target_name}](agent://{target}) — **Laguna watchdog request**\n\n"
                f"Requested action: `{action.get('request', 'digest-only')}`\n"
                f"Reason: `{action.get('reason')}`\n"
                "This script only detected and requested attention; it did not mutate agent status, "
                "restart Ollama, or execute a privileged command."
            )
            status, response = api_request("POST", f"/api/issues/{STATE_ISSUE}/comments", {"body": body})
            result = f"request:{status}"
        emitted.append(dict(action, result=result))
        if 200 <= status < 300:
            ledger["states"].append(key)
            if action["kind"] == "owner_wake":
                agent_id = action["agent_id"]
                ledger["nudges"][agent_id] = int(ledger["nudges"].get(agent_id, 0)) + 1
    if not dry:
        write_ledger(ledger)
    return emitted


def poll():
    fixture = os.environ.get("LAGUNA_WATCHDOG_FIXTURE")
    if fixture:
        payload = json.loads(Path(fixture).read_text(encoding="utf-8"))
        findings = inspect_ollama(
            payload.get("ps", {}),
            payload.get("tags", {}),
            payload.get("ollama_environment", {}),
        )
        agents = payload.get("agents", [])
        if isinstance(agents, dict):
            agents = list(agents.values())
        for agent in agents:
            findings.extend(inspect_agent(agent))
        return findings
    ps_payload = ollama_get("/api/ps")
    tags_payload = ollama_get("/api/tags")
    ollama_environment = {
        "OLLAMA_MAX_LOADED_MODELS": os.environ.get("OLLAMA_MAX_LOADED_MODELS", "")
    }
    findings = inspect_ollama(ps_payload, tags_payload, ollama_environment)
    for name, agent_id in AGENT_IDS.items():
        agent = api_request("GET", f"/api/agents/{agent_id}")
        if agent[0] != 200:
            findings.append({
                "kind": "agent_poll_failed",
                "agent_id": agent_id,
                "agent_name": name,
                "status": agent[0],
            })
        else:
            try:
                findings.extend(inspect_agent(json.loads(agent[1])))
            except (TypeError, ValueError):
                findings.append({"kind": "agent_poll_failed", "agent_id": agent_id, "agent_name": name})
    return findings


def selftest():
    findings = inspect_ollama(
        {"models": [{"name": "other:q4"}]},
        {"models": [{"name": EXPECTED_MODEL}, {"name": "other:q4"}]},
        {"OLLAMA_MAX_LOADED_MODELS": "1"},
    )
    findings.extend(inspect_agent({"id": "agent-failed", "name": "Planner", "status": "error", "activeRunId": None}))
    findings.extend(inspect_agent({"id": "agent-ghost", "name": "Director", "status": "running", "activeRunId": None}))
    actions = recovery_actions(findings, {"agent-failed": 0, "agent-ghost": CAP})
    assert any(action["kind"] == "owner_wake" for action in actions)
    assert any(action["kind"] == "digest_surface" for action in actions)
    assert sum(action["kind"] == "request" for action in actions) == 2
    result = apply_actions(actions, dry=True)
    assert all(item["result"] == "would-request" for item in result)
    print(json.dumps({"selftest": "GREEN", "findings": findings, "actions": result}, sort_keys=True))


def main():
    if MODE == "selftest":
        selftest()
        return 0
    if MODE not in ("live", "dry"):
        print("usage: laguna_adapter_watchdog.py [live|dry|selftest]", file=sys.stderr)
        return 2
    try:
        findings = poll()
        counts = read_ledger().get("nudges", {})
        actions = recovery_actions(findings, counts)
        emitted = apply_actions(actions, dry=MODE == "dry")
        print(json.dumps({"findings": findings, "actions": emitted}, indent=2, sort_keys=True))
        return 0
    except RuntimeError as error:
        print(json.dumps({"state": "UNKNOWN", "error": str(error)}))
        return 0 if MODE == "dry" else 1


if __name__ == "__main__":
    raise SystemExit(main())
