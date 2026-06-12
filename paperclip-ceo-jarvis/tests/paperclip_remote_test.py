"""Remote Paperclip API checks for Jarvis federation.

Run from the repo root with the backend virtualenv:
    backend/.venv/bin/python tests/paperclip_remote_test.py
"""
from __future__ import annotations

import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from fastapi.testclient import TestClient

REQUEST_LOG: list[dict[str, Any]] = []
ALLOW_AGENT_ME = True


class MockPaperclipHandler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A003
        return

    def _read_json(self) -> dict[str, Any]:
        length = int(self.headers.get("Content-Length", "0") or "0")
        if not length:
            return {}
        raw = self.rfile.read(length).decode("utf-8")
        return json.loads(raw) if raw else {}

    def _send_json(self, status: int, payload: Any) -> None:
        data = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _record(self, body: Any = None) -> None:
        REQUEST_LOG.append(
            {
                "method": self.command,
                "path": self.path,
                "authorization": self.headers.get("Authorization"),
                "run_id": self.headers.get("X-Paperclip-Run-Id"),
                "body": body,
            }
        )

    def do_GET(self) -> None:
        path = urlparse(self.path).path
        self._record()
        if path == "/api/agents/me":
            if not ALLOW_AGENT_ME:
                self._send_json(403, {"error": "agents/me disabled for configured-ID fallback test"})
                return
            self._send_json(
                200,
                {
                    "id": "agent-remote-1",
                    "name": "Jarvis Remote",
                    "companyId": "company-remote-1",
                    "role": "chief_of_staff",
                    "chainOfCommand": [{"id": "ceo-remote-1", "name": "CEO Remote"}],
                },
            )
            return
        if path == "/api/companies/company-remote-1":
            self._send_json(200, {"id": "company-remote-1", "name": "Remote Paperclip Co", "status": "active"})
            return
        if path == "/api/companies/company-remote-1/dashboard":
            self._send_json(
                200,
                {
                    "agent_counts": {"active": 4, "idle": 1},
                    "task_counts": {"todo": 3, "in_progress": 2, "blocked": 1, "done": 9},
                    "stale_tasks": [],
                    "cost_summary": {"monthSpendCents": 12000, "budgetCents": 50000},
                    "recent_activity": [{"action": "issue.created", "entityType": "issue", "entityId": "issue-remote-1"}],
                },
            )
            return
        if path == "/api/companies/company-remote-1/activity":
            self._send_json(200, [{"actor": "agent-remote-1", "action": "commented", "entityType": "issue", "entityId": "issue-remote-1"}])
            return
        if path == "/api/companies/company-remote-1/issues":
            self._send_json(
                200,
                [
                    {"id": "issue-remote-1", "title": "Remote readiness", "status": "todo", "priority": "high"},
                    {"id": "issue-remote-2", "title": "Approval cleanup", "status": "in_progress", "priority": "medium"},
                ],
            )
            return
        if path == "/api/companies/company-remote-1/approvals":
            self._send_json(200, [{"id": "approval-remote-1", "title": "Ship launch note", "status": "pending"}])
            return
        self._send_json(404, {"error": f"unknown path: {path}"})

    def do_POST(self) -> None:
        path = urlparse(self.path).path
        body = self._read_json()
        self._record(body)
        if path == "/api/companies/company-remote-1/issues":
            self._send_json(
                200,
                {
                    "id": "issue-created-1",
                    "title": body.get("title"),
                    "status": body.get("status", "todo"),
                    "priority": body.get("priority", "medium"),
                    "assigneeAgentId": body.get("assigneeAgentId"),
                    "description": body.get("description", ""),
                },
            )
            return
        self._send_json(404, {"error": f"unknown path: {path}"})

    def do_PATCH(self) -> None:
        path = urlparse(self.path).path
        body = self._read_json()
        self._record(body)
        if path == "/api/issues/issue-remote-1":
            self._send_json(
                200,
                {
                    "id": "issue-remote-1",
                    "title": body.get("title", "Remote readiness"),
                    "status": body.get("status", "todo"),
                    "priority": body.get("priority", "high"),
                    "comment": body.get("comment"),
                },
            )
            return
        self._send_json(404, {"error": f"unknown path: {path}"})


def start_server() -> tuple[ThreadingHTTPServer, threading.Thread, str]:
    server = ThreadingHTTPServer(("127.0.0.1", 0), MockPaperclipHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server, thread, f"http://127.0.0.1:{server.server_address[1]}/api"


def main() -> None:
    server, thread, api_url = start_server()
    try:
        os.environ["ENVIRONMENT"] = "development"
        os.environ["JARVIS_API_KEY"] = "dev-change-me"
        os.environ["PAPERCLIP_BASE_URL"] = api_url
        os.environ["PAPERCLIP_API_KEY"] = "remote-paperclip-key"
        os.environ.pop("PAPERCLIP_COMPANY_ID", None)
        os.environ.pop("PAPERCLIP_AGENT_ID", None)

        sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

        from app.main import app

        with TestClient(app) as client:
            systems = client.get("/federation/systems")
            systems.raise_for_status()
            system_data = systems.json()
            assert system_data["paperclip"]["mode"] == "http"
            assert system_data["paperclip"]["configured"] is True

            briefing = client.post(
                "/federation/briefing",
                json={"focus": "What should Paperclip do next?", "include_sources": ["paperclip"]},
            )
            briefing.raise_for_status()
            briefing_data = briefing.json()
            paperclip_snapshot = briefing_data["systems"]["paperclip"]["snapshot"]
            assert paperclip_snapshot["company"]["name"] == "Remote Paperclip Co"
            assert paperclip_snapshot["dashboard"]["task_counts"]["todo"] == 3
            assert paperclip_snapshot["company_id"] == "company-remote-1"

            execute = client.post(
                "/federation/execute",
                json={
                    "task": "Create a Paperclip issue for remote routing",
                    "target_system": "paperclip",
                    "approved": True,
                    "context": {"source": "remote-test"},
                },
            )
            execute.raise_for_status()
            execute_data = execute.json()
            assert execute_data["result"]["created_issue"]["id"] == "issue-created-1"
            assert execute_data["result"]["company_id"] == "company-remote-1"
            assert execute_data["result"]["transport"] == "http"

            update = client.post(
                "/federation/execute",
                json={
                    "task": "Update remote issue state",
                    "issueId": "issue-remote-1",
                    "target_system": "paperclip",
                    "approved": True,
                    "title": "Remote readiness updated",
                    "description": "Updated from Jarvis",
                    "status": "in_progress",
                    "priority": "high",
                    "context": {"source": "remote-test"},
                },
            )
            update.raise_for_status()
            update_data = update.json()
            assert update_data["result"]["updated_issue"]["id"] == "issue-remote-1"
            assert update_data["result"]["updated_issue"]["title"] == "Remote readiness updated"
            assert update_data["result"]["updated_issue"]["status"] == "in_progress"

            paperclip_calls = [row for row in REQUEST_LOG if row["path"].startswith("/api/")]
            assert any(row["path"] == "/api/agents/me" for row in paperclip_calls)
            post_calls = [row for row in paperclip_calls if row["method"] == "POST" and row["path"] == "/api/companies/company-remote-1/issues"]
            assert post_calls, REQUEST_LOG
            assert post_calls[-1]["authorization"] == "Bearer remote-paperclip-key"
            assert post_calls[-1]["run_id"]
            patch_calls = [row for row in paperclip_calls if row["method"] == "PATCH" and row["path"] == "/api/issues/issue-remote-1"]
            assert patch_calls, REQUEST_LOG
            assert patch_calls[-1]["authorization"] == "Bearer remote-paperclip-key"
            assert patch_calls[-1]["run_id"]

            global ALLOW_AGENT_ME
            ALLOW_AGENT_ME = False
            REQUEST_LOG.clear()
            os.environ["PAPERCLIP_COMPANY_ID"] = "company-remote-1"
            os.environ["PAPERCLIP_AGENT_ID"] = "agent-remote-1"
            from app.config import get_settings
            from app.services import federation as federation_service
            get_settings.cache_clear()
            federation_service.ADAPTERS["paperclip"].settings = get_settings()

            fallback = client.post(
                "/federation/briefing",
                json={"focus": "Configured-ID fallback", "include_sources": ["paperclip"]},
            )
            fallback.raise_for_status()
            fallback_data = fallback.json()
            fallback_snapshot = fallback_data["systems"]["paperclip"]["snapshot"]
            assert fallback_snapshot["company_id"] == "company-remote-1"
            assert fallback_snapshot["agent"]["id"] == "agent-remote-1"
            assert not any(row["path"] == "/api/agents/me" for row in REQUEST_LOG), REQUEST_LOG

    finally:
        server.shutdown()
        server.server_close()
        thread.join(timeout=5)

    print("JARVIS remote Paperclip federation test passed.")


if __name__ == "__main__":
    main()
