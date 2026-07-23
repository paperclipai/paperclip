from __future__ import annotations
from sqlalchemy.orm import Session
from ..models import Integration

DEFAULT_INTEGRATIONS = [
    ("Google Calendar", "calendar", ["read_events", "write_events_optional"], "OAuth connector for briefings, meeting prep, and scheduling."),
    ("Gmail", "email", ["read_mail", "draft_mail", "send_requires_approval"], "Email triage and executive communication drafts."),
    ("Google Drive", "documents", ["read_docs", "write_docs_optional"], "Knowledge ingestion, board packs, and generated docs."),
    ("GitHub", "engineering", ["read_repos", "issues", "pull_requests"], "Engineering metrics, code review, and implementation tracking."),
    ("Slack", "team", ["read_channels", "send_requires_approval"], "Briefings, alerts, and team coordination."),
    ("Supabase/Postgres", "database", ["read_metrics", "write_with_approval"], "Company data, product KPIs, and persistence."),
    ("Stripe", "finance", ["read_revenue", "read_customers"], "Revenue, churn, pricing, and subscription health."),
    ("Analytics", "product", ["read_events", "dashboards"], "Usage, conversion, funnels, and product health."),
    ("Local LLM", "ai", ["chat_completions"], "Self-hosted OpenAI-compatible model endpoint."),
]


def ensure_integrations(db: Session) -> None:
    for name, category, scopes, notes in DEFAULT_INTEGRATIONS:
        existing = db.query(Integration).filter(Integration.name == name).first()
        if not existing:
            db.add(Integration(name=name, category=category, scopes=scopes, notes=notes))
    db.commit()


def list_integrations(db: Session) -> list[dict]:
    ensure_integrations(db)
    rows = db.query(Integration).order_by(Integration.category, Integration.name).all()
    return [{"id": r.id, "name": r.name, "category": r.category, "status": r.status, "auth_mode": r.auth_mode, "scopes": r.scopes, "last_sync_at": r.last_sync_at, "notes": r.notes} for r in rows]


def update_integration(db: Session, integration_id: int, status: str, notes: str = "") -> Integration:
    row = db.get(Integration, integration_id)
    if not row:
        raise ValueError("Integration not found")
    row.status = status
    if notes:
        row.notes = notes
    db.commit()
    db.refresh(row)
    return row
