"""Smoke checks for the local JARVIS API, including cross-system federation.

Run after installing backend requirements:
    cd backend && DATABASE_URL=sqlite:////tmp/jarvis_test.db python ../tests/smoke_test.py

The script forces dev mode when needed so it can also be run from the repo root.
"""
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
        checks = [
            ("GET", "/health", None),
            ("GET", "/dashboard/god-view", None),
            ("GET", "/agents", None),
            ("POST", "/intelligence/reason", {"question": "Should we productize CEO Jarvis?", "horizon_days": 90}),
            ("POST", "/agents/swarm", {"task": "Analyze safe launch path", "mode": "consensus"}),
            ("GET", "/governance/approvals?status=all", None),
            ("GET", "/temporal/timeline?horizon_days=90", None),
            ("GET", "/integrations", None),
            ("GET", "/providers/catalog", None),
            ("GET", "/mission-control/playbooks", None),
            ("GET", "/mission-control/daily-ritual", None),
            ("POST", "/mission-control/command", {"command": "Should we launch Jarvis publicly after adding Gmail?", "autonomous": False}),
            ("GET", "/mission-control/next-best-actions", None),
            ("GET", "/federation/systems", None),
            ("POST", "/federation/briefing", {"focus": "Executive briefing across Paperclip, Hermes, Pi, and OpenCode", "include_sources": ["paperclip", "hermes", "pi", "opencode"]}),
            ("POST", "/federation/route", {"task": "Implement the next CEO workflow slice", "preferred_system": "auto", "allow_execution": True, "context": {"source": "smoke"}}),
            ("POST", "/federation/execute", {"task": "Summarize the CEO workflow slice in Paperclip", "target_system": "auto", "approved": True, "context": {"source": "smoke"}}),
            ("GET", "/federation/traces", None),
            ("GET", "/capabilities/readiness", None),
            ("GET", "/autonomy/policies", None),
            ("POST", "/autonomy/evaluate", {"action": "Publish launch announcement and deploy to production"}),
            ("POST", "/autonomy/watch-cycle", None),
            ("GET", "/autonomy/insights", None),
            ("GET", "/enchantments/backlog", None),
            ("GET", "/enchantments/brainstorm", None),
            ("POST", "/enchantments/plan", {"focus_categories": ["safety", "memory", "cognitive"], "horizon_days": 60, "capacity_level": "normal"}),
            ("GET", "/enchantments/audit", None),
            ("GET", "/v5/audit", None),
            ("GET", "/v5/constitutional/principles", None),
            ("POST", "/v5/constitutional/check", {"action": "Publish a public Jarvis announcement and connect production credentials"}),
            ("GET", "/v5/zero-trust/rules", None),
            ("POST", "/v5/zero-trust/decision", {"actor": "JARVIS", "resource": "production_deploy", "requested_scope": "execute"}),
            ("GET", "/v5/carbon/routes", None),
            ("POST", "/v5/carbon/choose-route", {"task": "Generate weekly strategic briefing", "min_quality": 70}),
            ("GET", "/v5/evaluation/suites", None),
            ("POST", "/v5/evaluation/run", {}),
            ("GET", "/v5/context/policies", None),
            ("POST", "/v5/context/bundle", {"task": "Decide public launch", "scope": "ceo"}),
            ("POST", "/v5/collaboration/start", {"title": "Launch review", "participants": ["CEO", "JARVIS"], "artifact": "launch plan"}),
            ("GET", "/v5/workforce/marketplace", None),
            ("GET", "/v5/company/ecosystem", None),
            ("GET", "/v5/company/health-forecast?horizon_days=90", None),
            ("POST", "/v5/board/vote", {"proposal": "Launch Jarvis publicly after security review"}),
            ("POST", "/v5/teams/propose", {"demand_signal": "Growth Engineering demand exceeds capacity"}),
            ("GET", "/v5/meta-learning", None),
            ("POST", "/v5/agents/propose-generation", {"parent_agent": "Hermes", "improvement_goal": "Better war-game evaluation"}),
            ("GET", "/v5/rnd/lab", None),
            ("GET", "/v5/engineering/catalog", None),
            ("GET", "/v5/deployment/regions", None),
            ("GET", "/v5/compliance/automation", None),
            ("GET", "/v5/culture/intelligence", None),
        ]
        for method, path, payload in checks:
            response = client.request(method, path, json=payload) if payload else client.request(method, path)
            print(f"{method} {path}: {response.status_code}")
            response.raise_for_status()
    print("JARVIS smoke test passed.")


if __name__ == "__main__":
    main()
