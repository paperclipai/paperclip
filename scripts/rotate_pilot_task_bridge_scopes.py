#!/usr/bin/env python3
"""Rotate Pilot Research bridge keys to least-privilege sequential handoff scopes."""

from __future__ import annotations

import json
from pathlib import Path

from repair_pilot_pipeline import (
    COMPANY_ID,
    LOG_PATH,
    PROJECT_NAME,
    ROLE_CONFIG,
    request,
    response_token,
)


def main() -> int:
    record = json.loads(LOG_PATH.read_text(encoding="utf-8"))
    agents = request("GET", f"/companies/{COMPANY_ID}/agents")
    by_name = {agent["name"]: agent for agent in agents}
    projects = request("GET", f"/companies/{COMPANY_ID}/projects")
    project = next((item for item in projects if item.get("name") == PROJECT_NAME), None)
    if not project:
        raise RuntimeError("Pilot Research Pipeline project is missing")
    project_id = project["id"]

    rotated: dict[str, dict[str, object]] = {}
    for name, role in ROLE_CONFIG.items():
        agent = by_name.get(name)
        old = record.get("agents", {}).get(name, {})
        if not agent or not old.get("taskBridgeKeyId") or not old.get("secretId"):
            raise RuntimeError(f"Missing current bridge state for {name}")
        scope = {
            "kind": "task_bridge",
            "projectId": project_id,
            "allowedAssigneeAgentIds": [by_name[target]["id"] for target in role["allowed_assignee_names"]],
        }
        new_key = None
        try:
            new_key = request(
                "POST",
                f"/agents/{agent['id']}/keys",
                {"name": "Pilot Research task bridge v2", "scope": scope},
            )
            request("POST", f"/secrets/{old['secretId']}/rotate", {"value": response_token(new_key)})
            request(
                "PATCH",
                f"/agents/{agent['id']}/permissions",
                {"canCreateAgents": False, "canCreateSkills": False, "canAssignTasks": True},
            )
            request("DELETE", f"/agents/{agent['id']}/keys/{old['taskBridgeKeyId']}")
            record["agents"][name].update(
                {
                    "taskBridgeKeyId": new_key["id"],
                    "canAssignTasks": True,
                    "taskBridgeScope": scope,
                }
            )
            rotated[name] = {"agentId": agent["id"], "taskBridgeKeyId": new_key["id"], "scope": scope}
        except Exception:
            if new_key and new_key.get("id"):
                try:
                    request("DELETE", f"/agents/{agent['id']}/keys/{new_key['id']}")
                except Exception:
                    pass
            raise

    record["bridgeScopesRotated"] = rotated
    LOG_PATH.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"ok": True, "projectId": project_id, "rotated": sorted(rotated)}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
