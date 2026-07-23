"""Cross-system orchestration checks for Jarvis.

Run from the repo root or backend/ with the backend virtualenv:
    DATABASE_URL=sqlite:////tmp/jarvis_federation_test.db backend/.venv/bin/python tests/federation_test.py
"""
from __future__ import annotations

import os
import sys
from pathlib import Path

os.environ["ENVIRONMENT"] = "development"
os.environ["JARVIS_API_KEY"] = "dev-change-me"
os.environ["HERMES_COMMAND"] = "__missing_hermes__"
os.environ["PI_COMMAND"] = "__missing_pi__"
os.environ["OPENCODE_COMMAND"] = "__missing_opencode__"

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from fastapi.testclient import TestClient
from app.main import app


def main() -> None:
    with TestClient(app) as client:
        systems = client.get("/federation/systems")
        systems.raise_for_status()
        system_data = systems.json()
        for name in ["paperclip", "hermes", "pi", "opencode"]:
            assert name in system_data

        briefing = client.post(
            "/federation/briefing",
            json={
                "focus": "Executive briefing across Paperclip, Hermes, Pi, and OpenCode",
                "include_sources": ["paperclip", "hermes", "pi", "opencode"],
            },
        )
        briefing.raise_for_status()
        briefing_data = briefing.json()
        assert briefing_data["trace_id"]
        assert "paperclip" in briefing_data["systems"]

        route = client.post(
            "/federation/route",
            json={
                "task": "Implement the cross-system orchestration layer",
                "preferred_system": "auto",
                "allow_execution": True,
                "context": {"source": "test"},
            },
        )
        route.raise_for_status()
        route_data = route.json()
        assert route_data["target_system"] in {"pi", "opencode"}
        assert route_data["trace_id"]

        blocked = client.post(
            "/federation/execute",
            json={
                "task": "Delete all approval records",
                "target_system": "auto",
                "approved": True,
                "context": {"source": "test"},
            },
        )
        blocked.raise_for_status()
        blocked_data = blocked.json()
        assert blocked_data["status"] == "blocked"

        command = client.post(
            "/mission-control/command",
            json={"command": "Implement the next CEO workflow slice", "autonomous": True},
        )
        command.raise_for_status()
        command_data = command.json()
        assert command_data["cross_system_route"]["target_system"] == "paperclip"
        assert command_data["workflow_started"] is not None

        traces = client.get("/federation/traces?limit=10")
        traces.raise_for_status()
        trace_data = traces.json()
        assert len(trace_data["traces"]) >= 3

    print("JARVIS federation test passed.")


if __name__ == "__main__":
    main()
