#!/usr/bin/env python3
"""Apply the Pilot Research pipeline guardrails through the Paperclip board API.

This script intentionally never prints or writes raw API-key material.  Each
agent receives a project-bounded task-bridge key stored as a Paperclip secret.
"""

from __future__ import annotations

import json
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

API = "http://127.0.0.1:3100/api"
COMPANY_ID = "3026a09a-da4a-499b-a633-032058933429"
PROJECT_NAME = "Pilot Research Pipeline"
LOG_PATH = Path(r"C:\Users\rcatl\.paperclip\pilot-research-pipeline-repair-2026-07-10.json")

ROLE_CONFIG = {
    "Research Lead": {
        "toolsets": "terminal,todo",
        "secret_key": "PAPERCLIP_BRIDGE_RESEARCH_LEAD",
        "allowed_assignee_names": ["Source Gatherer"],
        "can_assign": True,
        "can_create_agents": False,
        "can_create_skills": False,
    },
    "Source Gatherer": {
        "toolsets": "web,browser,terminal,todo",
        "secret_key": "PAPERCLIP_BRIDGE_SOURCE_GATHERER",
        "allowed_assignee_names": ["Fact-Checker"],
        "can_assign": True,
        "can_create_agents": False,
        "can_create_skills": False,
    },
    "Fact-Checker": {
        "toolsets": "web,browser,terminal,todo",
        "secret_key": "PAPERCLIP_BRIDGE_FACT_CHECKER",
        "allowed_assignee_names": ["Reporting Agent"],
        "can_assign": True,
        "can_create_agents": False,
        "can_create_skills": False,
    },
    "Reporting Agent": {
        "toolsets": "terminal,todo",
        "secret_key": "PAPERCLIP_BRIDGE_REPORTING_AGENT",
        "allowed_assignee_names": ["Research Lead"],
        "can_assign": True,
        "can_create_agents": False,
        "can_create_skills": False,
    },
}

HEARTBEAT_POLICY = {
    "enabled": True,
    "cooldownSec": 60,
    "intervalSec": 900,
    "wakeOnDemand": True,
    "maxConcurrentRuns": 1,
    "skipTimerWhenNoActionableWork": True,
}


def request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    body = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API + path,
        data=body,
        headers={"Content-Type": "application/json"} if body is not None else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=45) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise RuntimeError(f"{method} {path} failed ({exc.code}): {detail}") from exc


def response_token(key_result: dict[str, Any]) -> str:
    # The board returns the one-time key material in `token`; retain it only in
    # process memory long enough to put it into encrypted Paperclip secret storage.
    token = key_result.get("token")
    if not isinstance(token, str) or not token.strip():
        raise RuntimeError("Paperclip did not return one-time task-bridge key material")
    return token


def main() -> int:
    agents = request("GET", f"/companies/{COMPANY_ID}/agents")
    if not isinstance(agents, list):
        raise RuntimeError("Agent listing did not return a list")
    by_name = {agent.get("name"): agent for agent in agents}
    missing = sorted(set(ROLE_CONFIG) - set(by_name))
    if missing:
        raise RuntimeError(f"Required Pilot Research agents are missing: {', '.join(missing)}")
    if any(agent.get("status") != "paused" for agent in by_name.values() if agent.get("name") in ROLE_CONFIG):
        raise RuntimeError("Refusing to change the pipeline while a Pilot Research agent is not paused")

    projects = request("GET", f"/companies/{COMPANY_ID}/projects")
    project = next((item for item in projects if item.get("name") == PROJECT_NAME), None)
    project_created = False
    if project is None:
        lead_id = by_name["Research Lead"]["id"]
        project = request(
            "POST",
            f"/companies/{COMPANY_ID}/projects",
            {
                "name": PROJECT_NAME,
                "description": (
                    "Bounded four-stage research flow: Lead dispatches Source, Fact-Checker, "
                    "and Report Writer child tasks through scoped Paperclip task-bridge credentials."
                ),
                "status": "planned",
                "leadAgentId": lead_id,
                "icon": "layers",
            },
        )
        project_created = True
    project_id = project.get("id")
    if not isinstance(project_id, str):
        raise RuntimeError("Pilot Research Pipeline project has no id")

    generated_key_ids: list[tuple[str, str]] = []
    generated_secret_ids: list[str] = []
    result: dict[str, Any] = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "companyId": COMPANY_ID,
        "projectId": project_id,
        "projectCreated": project_created,
        "heartbeatPolicy": HEARTBEAT_POLICY,
        "agents": {},
    }

    try:
        for name, role in ROLE_CONFIG.items():
            agent = by_name[name]
            agent_id = agent["id"]
            scope: dict[str, Any] = {"kind": "task_bridge", "projectId": project_id}
            allowed_assignee_names = role.get("allowed_assignee_names", [])
            if allowed_assignee_names:
                scope["allowedAssigneeAgentIds"] = [by_name[agent_name]["id"] for agent_name in allowed_assignee_names]

            key = request(
                "POST",
                f"/agents/{agent_id}/keys",
                {"name": "Pilot Research task bridge", "scope": scope},
            )
            generated_key_ids.append((agent_id, key["id"]))
            token = response_token(key)

            secret = request(
                "POST",
                f"/companies/{COMPANY_ID}/secrets",
                {
                    "name": f"Pilot Research task bridge — {name}",
                    "key": role["secret_key"],
                    "provider": "local_encrypted",
                    "managedMode": "paperclip_managed",
                    "value": token,
                    "description": f"Project-bounded task-bridge credential for {name}.",
                },
            )
            # Drop the raw one-time token immediately after encrypted storage succeeds.
            token = ""
            generated_secret_ids.append(secret["id"])

            existing_env = dict((agent.get("adapterConfig") or {}).get("env") or {})
            existing_env["PAPERCLIP_BRIDGE_API_KEY"] = {
                "type": "secret_ref",
                "secretId": secret["id"],
                "version": "latest",
            }
            request(
                "PATCH",
                f"/agents/{agent_id}",
                {
                    "adapterConfig": {
                        "toolsets": role["toolsets"],
                        "env": existing_env,
                    },
                    "runtimeConfig": {"heartbeat": HEARTBEAT_POLICY},
                },
            )
            request(
                "PATCH",
                f"/agents/{agent_id}/permissions",
                {
                    "canCreateAgents": role["can_create_agents"],
                    "canCreateSkills": role["can_create_skills"],
                    "canAssignTasks": role["can_assign"],
                },
            )
            result["agents"][name] = {
                "agentId": agent_id,
                "taskBridgeKeyId": key["id"],
                "secretId": secret["id"],
                "toolsets": role["toolsets"],
                "canAssignTasks": role["can_assign"],
            }
    except Exception:
        # Avoid leaving usable credentials behind when the configuration only
        # partially applied. The project is retained as an auditable boundary.
        for secret_id in reversed(generated_secret_ids):
            try:
                request("DELETE", f"/secrets/{secret_id}")
            except Exception:
                pass
        for agent_id, key_id in reversed(generated_key_ids):
            try:
                request("DELETE", f"/agents/{agent_id}/keys/{key_id}")
            except Exception:
                pass
        raise

    LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
    LOG_PATH.write_text(json.dumps(result, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({
        "ok": True,
        "projectId": project_id,
        "projectCreated": project_created,
        "configuredAgents": sorted(result["agents"]),
        "maxConcurrentRuns": HEARTBEAT_POLICY["maxConcurrentRuns"],
        "log": str(LOG_PATH),
    }, indent=2))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception as exc:
        print(json.dumps({"ok": False, "error": str(exc)}))
        raise SystemExit(1)
