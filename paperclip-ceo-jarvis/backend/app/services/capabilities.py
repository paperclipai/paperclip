from __future__ import annotations
import os
from datetime import datetime
from sqlalchemy.orm import Session
from ..models import ToolCapability, NotificationEvent, AuditLog


DEFAULT_CAPABILITIES = [
    {
        "name": "chat.completions",
        "category": "ai",
        "description": "Generate executive answers through an OpenAI-compatible endpoint or deterministic fallback.",
        "minimum_authority": "assistant",
        "approval_required": False,
        "env_vars": ["OPENAI_BASE_URL", "OPENAI_API_KEY"],
    },
    {
        "name": "calendar.read",
        "category": "calendar",
        "description": "Read authorized calendar events for briefings, meeting prep, and scheduling suggestions.",
        "minimum_authority": "user_oauth",
        "approval_required": False,
        "env_vars": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    },
    {
        "name": "calendar.write",
        "category": "calendar",
        "description": "Create or update calendar events after user approval.",
        "minimum_authority": "user_oauth",
        "approval_required": True,
        "env_vars": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    },
    {
        "name": "email.draft",
        "category": "email",
        "description": "Draft Gmail messages for CEO review.",
        "minimum_authority": "user_oauth",
        "approval_required": False,
        "env_vars": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    },
    {
        "name": "email.send",
        "category": "email",
        "description": "Send email only after explicit approval.",
        "minimum_authority": "user_oauth",
        "approval_required": True,
        "env_vars": ["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"],
    },
    {
        "name": "github.read",
        "category": "engineering",
        "description": "Read repository metadata, issues, pull requests, and engineering velocity metrics.",
        "minimum_authority": "repository_token",
        "approval_required": False,
        "env_vars": ["GITHUB_TOKEN"],
    },
    {
        "name": "github.write",
        "category": "engineering",
        "description": "Create issues, branches, pull requests, or comments after approval.",
        "minimum_authority": "repository_token",
        "approval_required": True,
        "env_vars": ["GITHUB_TOKEN"],
    },
    {
        "name": "database.read_metrics",
        "category": "database",
        "description": "Read authorized KPI snapshots from Supabase/Postgres.",
        "minimum_authority": "service_readonly",
        "approval_required": False,
        "env_vars": ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    },
    {
        "name": "database.write",
        "category": "database",
        "description": "Write operational records only through approved, auditable actions.",
        "minimum_authority": "service_role",
        "approval_required": True,
        "env_vars": ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"],
    },
    {
        "name": "repo.secret_scan",
        "category": "security",
        "description": "Scan local project files for common credential leak patterns.",
        "minimum_authority": "local_runtime",
        "approval_required": False,
        "env_vars": [],
    },

    {
        "name": "autonomy.evaluate",
        "category": "governance",
        "description": "Evaluate proposed actions against authority rules, side effects, and approval gates.",
        "minimum_authority": "local_runtime",
        "approval_required": False,
        "env_vars": [],
    },
    {
        "name": "watch.proactive_cycle",
        "category": "governance",
        "description": "Run proactive watch rules across approvals, debt, risk, workload, predictions, and capabilities.",
        "minimum_authority": "local_runtime",
        "approval_required": False,
        "env_vars": [],
    },
    {
        "name": "knowledge.vector_search",
        "category": "memory",
        "description": "Semantic local retrieval over uploaded specs, decisions, and project notes.",
        "minimum_authority": "local_runtime",
        "approval_required": False,
        "env_vars": ["EMBEDDINGS_MODEL"],
    },
    {
        "name": "voice.local_command",
        "category": "interface",
        "description": "Optional local voice command layer with explicit confirmation for risky actions.",
        "minimum_authority": "local_runtime",
        "approval_required": True,
        "env_vars": ["VOICE_WAKE_WORD_MODEL"],
    },
    {
        "name": "vision.document_analysis",
        "category": "interface",
        "description": "Multimodal analysis of screenshots, dashboards, diagrams, and documents.",
        "minimum_authority": "assistant",
        "approval_required": False,
        "env_vars": ["VISION_MODEL"],
    },
    {
        "name": "ticket.create",
        "category": "engineering",
        "description": "Create implementation tickets from approved decisions and feature plans.",
        "minimum_authority": "repository_token",
        "approval_required": True,
        "env_vars": ["GITHUB_TOKEN"],
    },
]


def ensure_tool_capabilities(db: Session) -> None:
    for spec in DEFAULT_CAPABILITIES:
        existing = db.query(ToolCapability).filter(ToolCapability.name == spec["name"]).first()
        if not existing:
            row = ToolCapability(**spec)
            row.health_status = _health_for_env(spec.get("env_vars", []))
            db.add(row)
    db.commit()


def _health_for_env(env_vars: list[str]) -> str:
    if not env_vars:
        return "ready"
    present = [var for var in env_vars if os.getenv(var)]
    if len(present) == len(env_vars):
        return "ready"
    if present:
        return "degraded"
    return "missing_config"


def list_capabilities(db: Session) -> dict:
    ensure_tool_capabilities(db)
    rows = db.query(ToolCapability).order_by(ToolCapability.category, ToolCapability.name).all()
    ready = 0
    missing = 0
    capabilities = []
    for r in rows:
        r.health_status = "disabled" if not r.enabled else _health_for_env(r.env_vars or [])
        if r.health_status == "ready":
            ready += 1
        if r.health_status == "missing_config":
            missing += 1
        capabilities.append({
            "id": r.id,
            "name": r.name,
            "category": r.category,
            "description": r.description,
            "minimum_authority": r.minimum_authority,
            "approval_required": r.approval_required,
            "enabled": r.enabled,
            "env_vars": r.env_vars,
            "health_status": r.health_status,
        })
    db.commit()
    return {
        "generated_at": datetime.utcnow(),
        "ready_count": ready,
        "missing_config_count": missing,
        "capabilities": capabilities,
        "recommendation": "Wire read-only capabilities first. Give write permissions only after approval gates are tested. Dull, safe, effective — annoyingly correct.",
    }


def update_capability(db: Session, capability_id: int, enabled: bool | None = None, health_status: str | None = None) -> ToolCapability:
    row = db.get(ToolCapability, capability_id)
    if not row:
        raise ValueError("Capability not found")
    if enabled is not None:
        row.enabled = enabled
    if health_status is not None:
        row.health_status = health_status
    db.add(AuditLog(actor="jarvis", action="update tool capability", risk_level="medium", allowed=True, details={"capability_id": capability_id, "enabled": enabled, "health_status": health_status}))
    db.commit()
    db.refresh(row)
    return row


def readiness_report(db: Session) -> dict:
    data = list_capabilities(db)
    critical_missing = [c for c in data["capabilities"] if c["name"] in {"chat.completions", "calendar.read", "email.draft", "github.read"} and c["health_status"] != "ready"]
    if critical_missing:
        db.add(NotificationEvent(channel="dashboard", title="Capability configuration missing", body=f"{len(critical_missing)} core capability/capabilities need configuration.", priority=4, payload={"missing": [c["name"] for c in critical_missing]}))
        db.commit()
    return {
        **data,
        "critical_missing": critical_missing,
        "production_ready": len(critical_missing) == 0 and data["missing_config_count"] <= 2,
        "next_steps": [
            "Set JARVIS_API_KEY before exposing the API outside localhost.",
            "Configure one read-only connector first: Calendar, Gmail draft, GitHub read, or metrics database.",
            "Run /risk/scan-secrets before publishing or deploying.",
        ],
    }
