#!/usr/bin/env python3
"""No-LLM end-to-end validation of the Pilot Research scoped handoff chain."""

from __future__ import annotations

import json
import os
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

API = "http://127.0.0.1:3100/api"
COMPANY_ID = "3026a09a-da4a-499b-a633-032058933429"
PROJECT_ID = "67a1f416-5420-403c-9584-604fb2370b2a"
BRIDGE = r"C:\Users\rcatl\paperclip\packages\adapters\hermes\skills\paperclip-task-bridge\paperclip-task.mjs"
LOG_PATH = Path(r"C:\Users\rcatl\.paperclip\pilot-research-pipeline-e2e-validation-2026-07-10.json")


def request(method: str, path: str, payload: dict[str, Any] | None = None) -> Any:
    data = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        API + path,
        data=data,
        headers={"Content-Type": "application/json"} if data is not None else {},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=40) as response:
            return json.load(response)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:1000]
        raise RuntimeError(f"{method} {path} failed ({exc.code}): {detail}") from exc


def run_bridge(token: str, agent_id: str, *args: str, expect_ok: bool = True) -> dict[str, Any]:
    env = os.environ.copy()
    env.update(
        {
            "PAPERCLIP_API_URL": "http://127.0.0.1:3100",
            "PAPERCLIP_COMPANY_ID": COMPANY_ID,
            "PAPERCLIP_AGENT_ID": agent_id,
            "PAPERCLIP_BRIDGE_API_KEY": token,
        }
    )
    result = subprocess.run(
        ["node", BRIDGE, *args],
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=env,
        timeout=50,
        check=False,
    )
    if expect_ok:
        if result.returncode != 0:
            raise RuntimeError(f"Bridge {' '.join(args[:2])} failed: {result.stdout[-1000:]} {result.stderr[-500:]}")
        return json.loads(result.stdout)
    if result.returncode == 0:
        raise RuntimeError("A scoped bridge key unexpectedly performed a forbidden cross-role assignment")
    response = json.loads(result.stdout)
    if response.get("status") not in {401, 403}:
        raise RuntimeError(f"Expected authorization denial, received: {response}")
    return response


def main() -> int:
    agents = request("GET", f"/companies/{COMPANY_ID}/agents")
    by_name = {agent["name"]: agent for agent in agents}
    required = ["Research Lead", "Source Gatherer", "Fact-Checker", "Reporting Agent"]
    if any(by_name.get(name, {}).get("status") != "paused" for name in required):
        raise RuntimeError("Validation requires all Pilot Research agents to remain paused")

    role_ids = {name: by_name[name]["id"] for name in required}
    scopes = {
        "Research Lead": [role_ids["Source Gatherer"]],
        "Source Gatherer": [role_ids["Fact-Checker"]],
        "Fact-Checker": [role_ids["Reporting Agent"]],
        "Reporting Agent": [role_ids["Research Lead"]],
    }
    key_material: dict[str, tuple[str, str]] = {}
    evidence: dict[str, Any] = {"timestamp": datetime.now(timezone.utc).isoformat(), "projectId": PROJECT_ID}
    try:
        for role in required:
            created = request(
                "POST",
                f"/agents/{role_ids[role]}/keys",
                {
                    "name": "Pilot Research e2e validation bridge",
                    "scope": {
                        "kind": "task_bridge",
                        "projectId": PROJECT_ID,
                        "allowedAssigneeAgentIds": scopes[role],
                    },
                },
            )
            token = created.get("token")
            if not isinstance(token, str) or not token:
                raise RuntimeError("Paperclip did not supply one-time validation key material")
            key_material[role] = (created["id"], token)

        root = request(
            "POST",
            f"/companies/{COMPANY_ID}/issues",
            {
                "title": "[VALIDATION] Pilot Research sequential handoff",
                "description": "No-LLM validation artifact. Must complete through Lead → Source → Fact → Report → Lead.",
                "projectId": PROJECT_ID,
                "status": "todo",
                "priority": "low",
                "assigneeAgentId": role_ids["Research Lead"],
            },
        )
        root_id = root["id"]

        lead_token = key_material["Research Lead"][1]
        source = run_bridge(
            lead_token, role_ids["Research Lead"], "create-task",
            "--title", "[Source] validation evidence",
            "--parent-id", root_id, "--project-id", PROJECT_ID,
            "--assignee-agent-id", role_ids["Source Gatherer"],
            "--description", f"ROOT_ISSUE_ID: {root_id}\nSynthetic evidence: a validation-only claim.",
        )["issue"]
        source_id = source["id"]
        run_bridge(lead_token, role_ids["Research Lead"], "update-status", "--issue", root_id, "--status", "blocked", "--comment", f"Validation dispatched Source {source_id}.")

        source_token = key_material["Source Gatherer"][1]
        source_read = run_bridge(source_token, role_ids["Source Gatherer"], "get-task", "--issue", source_id)
        if source_read["issue"]["id"] != source_id:
            raise RuntimeError("Source bridge did not return its assigned issue")
        forbidden = run_bridge(
            source_token, role_ids["Source Gatherer"], "create-task",
            "--title", "[FORBIDDEN] cross-role assignment", "--project-id", PROJECT_ID,
            "--assignee-agent-id", role_ids["Reporting Agent"], "--description", "must be denied",
            expect_ok=False,
        )
        if forbidden.get("status") != 403:
            raise RuntimeError("Scoped Source bridge key was allowed to assign a non-permitted role")
        run_bridge(source_token, role_ids["Source Gatherer"], "update-status", "--issue", source_id, "--status", "done", "--comment", "Validation source evidence complete.")
        fact = run_bridge(
            source_token, role_ids["Source Gatherer"], "create-task",
            "--title", "[Fact] validation evidence", "--parent-id", source_id, "--project-id", PROJECT_ID,
            "--assignee-agent-id", role_ids["Fact-Checker"],
            "--description", f"ROOT_ISSUE_ID: {root_id}\nEVIDENCE PACK: validation-only evidence.",
        )["issue"]
        fact_id = fact["id"]

        fact_token = key_material["Fact-Checker"][1]
        run_bridge(fact_token, role_ids["Fact-Checker"], "get-task", "--issue", fact_id)
        run_bridge(fact_token, role_ids["Fact-Checker"], "update-status", "--issue", fact_id, "--status", "done", "--comment", "Validation fact-check complete.")
        report = run_bridge(
            fact_token, role_ids["Fact-Checker"], "create-task",
            "--title", "[Report] validation evidence", "--parent-id", fact_id, "--project-id", PROJECT_ID,
            "--assignee-agent-id", role_ids["Reporting Agent"],
            "--description", f"ROOT_ISSUE_ID: {root_id}\nVERIFIED BRIEF: validation claim verified.",
        )["issue"]
        report_id = report["id"]

        report_token = key_material["Reporting Agent"][1]
        run_bridge(report_token, role_ids["Reporting Agent"], "get-task", "--issue", report_id)
        run_bridge(report_token, role_ids["Reporting Agent"], "update-status", "--issue", report_id, "--status", "done", "--comment", "Validation report complete.")
        close = run_bridge(
            report_token, role_ids["Reporting Agent"], "create-task",
            "--title", "[Close] validation evidence", "--parent-id", root_id, "--project-id", PROJECT_ID,
            "--assignee-agent-id", role_ids["Research Lead"],
            "--description", f"ROOT_ISSUE_ID: {root_id}\nFINAL REPORT: validation handoff chain completed.",
        )["issue"]
        close_id = close["id"]

        close_read = run_bridge(lead_token, role_ids["Research Lead"], "get-task", "--issue", close_id)
        if "validation handoff chain completed" not in (close_read["issue"].get("description") or ""):
            raise RuntimeError("Lead could not read final closure report")
        run_bridge(lead_token, role_ids["Research Lead"], "update-status", "--issue", root_id, "--status", "done", "--comment", "Validation final report received through scoped closure handoff.")
        run_bridge(lead_token, role_ids["Research Lead"], "update-status", "--issue", close_id, "--status", "done", "--comment", "Validation root closed.")

        final_issues = {issue_id: request("GET", f"/issues/{issue_id}") for issue_id in [root_id, source_id, fact_id, report_id, close_id]}
        if any(issue.get("status") != "done" for issue in final_issues.values()):
            raise RuntimeError("Validation chain did not reach done for every stage")
        expected_parents = {source_id: root_id, fact_id: source_id, report_id: fact_id, close_id: root_id}
        if any(final_issues[child].get("parentId") != parent for child, parent in expected_parents.items()):
            raise RuntimeError("Validation chain parent relationships are incorrect")
        if any(issue.get("projectId") != PROJECT_ID for issue in final_issues.values()):
            raise RuntimeError("Validation chain escaped its project boundary")
        evidence.update(
            {
                "ok": True,
                "issues": {"root": root_id, "source": source_id, "fact": fact_id, "report": report_id, "close": close_id},
                "statuses": {name: issue["status"] for name, issue in zip(["root", "source", "fact", "report", "close"], final_issues.values())},
                "crossRoleAssignmentDenied": forbidden.get("status"),
            }
        )
        LOG_PATH.write_text(json.dumps(evidence, indent=2) + "\n", encoding="utf-8")
        print(json.dumps({"ok": True, "allStagesDone": True, "crossRoleAssignmentDenied": forbidden.get("status"), "log": str(LOG_PATH)}, indent=2))
        return 0
    finally:
        for role, (key_id, _token) in key_material.items():
            try:
                request("DELETE", f"/agents/{role_ids[role]}/keys/{key_id}")
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
