from sqlalchemy.orm import Session
from ..models import Alert, BriefingItem, Task, ApprovalRequest, RiskItem, DebtItem, SystemFlag
from .burnout import workload_snapshot
from .integrations import ensure_integrations
from .orchestrator import ensure_default_agents
from .autonomy import run_watch_cycle as run_autonomy_watch_cycle


def _exists_alert(db: Session, title: str) -> bool:
    return db.query(Alert).filter(Alert.resolved == False, Alert.title == title).first() is not None  # noqa: E712


def run_watch_cycle(db: Session) -> dict:
    created = 0
    ensure_default_agents(db)
    ensure_integrations(db)
    paused = db.query(SystemFlag).filter(SystemFlag.key == "paused", SystemFlag.value == "true").first()
    if paused:
        if not _exists_alert(db, "Jarvis automation paused"):
            db.add(Alert(severity="warning", title="Jarvis automation paused", detail=paused.reason or "System paused by CEO."))
            created += 1
        db.commit()
        return {"created": created, "paused": True}

    workload = workload_snapshot(db)
    for person in workload["people_at_risk"]:
        title = f"Burnout risk: {person['name']}"
        if not _exists_alert(db, title):
            db.add(Alert(severity="warning", title=title, detail=f"Workload score is {person['workload_score']}. Rebalance recommended."))
            created += 1
    high_risk_tasks = db.query(Task).filter(Task.risk_level == "high", Task.status == "open").all()
    for task in high_risk_tasks:
        title = f"High-risk task needs CEO review: {task.title}"
        if not db.query(BriefingItem).filter(BriefingItem.resolved == False, BriefingItem.title == title).first():  # noqa: E712
            db.add(BriefingItem(category="risk", title=title, summary=task.description or "High-risk open task detected.", urgency=5, source="watchdog"))
            created += 1
    pending_approvals = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()
    if pending_approvals and not _exists_alert(db, "Pending approvals require CEO decision"):
        db.add(Alert(severity="info", title="Pending approvals require CEO decision", detail=f"{pending_approvals} approval request(s) are waiting."))
        created += 1
    risk_score = sum(r.severity * r.likelihood for r in db.query(RiskItem).filter(RiskItem.status == "open").all())
    if risk_score >= 25 and not _exists_alert(db, "Aggregate risk score elevated"):
        db.add(Alert(severity="warning", title="Aggregate risk score elevated", detail=f"Open risk score is {risk_score}. Review risk register."))
        created += 1
    debt_count = db.query(DebtItem).filter(DebtItem.status == "open", DebtItem.impact >= 4).count()
    if debt_count and not _exists_alert(db, "High-impact debt needs attention"):
        db.add(Alert(severity="info", title="High-impact debt needs attention", detail=f"{debt_count} high-impact debt item(s) are open."))
        created += 1
    db.commit()
    autonomy_result = run_autonomy_watch_cycle(db)
    return {"created": created, "workload": workload, "pending_approvals": pending_approvals, "risk_score": risk_score, "autonomy": autonomy_result}
