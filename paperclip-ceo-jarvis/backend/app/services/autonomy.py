from __future__ import annotations
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import (
    Alert,
    ApprovalRequest,
    AuditLog,
    AutonomyPolicy,
    DebtItem,
    Employee,
    NotificationEvent,
    PredictionRecord,
    RiskItem,
    SystemInsight,
    Task,
    ToolCapability,
    WatchRule,
)

RISK_RANK = {"low": 1, "medium": 2, "high": 3, "critical": 4}
DECISION_RANK = {"allow_autonomous": 1, "approval_required": 2, "deny": 3}

DEFAULT_POLICIES = [
    {
        "name": "Read-only analysis is autonomous",
        "category": "routine",
        "trigger_terms": ["summarize", "analyze", "brief", "search", "read", "review", "draft"],
        "risk_level": "low",
        "decision": "allow_autonomous",
        "requires_approval": False,
        "rationale": "Read-only thinking, summarization, and drafting can run autonomously when no external side-effect occurs.",
    },
    {
        "name": "External communication requires approval",
        "category": "communications",
        "trigger_terms": ["send", "publish", "post", "announce", "email", "message customer", "press release"],
        "risk_level": "high",
        "decision": "approval_required",
        "requires_approval": True,
        "rationale": "Anything leaving the company boundary needs human review.",
    },
    {
        "name": "Credential and secret changes are blocked until manual setup",
        "category": "security",
        "trigger_terms": ["password", "api key", "secret", "credential", "token", "oauth", "service role"],
        "risk_level": "critical",
        "decision": "approval_required",
        "requires_approval": True,
        "rationale": "Credentials must be handled through environment variables or a vault, never raw database writes.",
    },
    {
        "name": "Production deployment requires explicit approval",
        "category": "engineering",
        "trigger_terms": ["deploy", "production", "release", "rollback", "migration", "database write"],
        "risk_level": "high",
        "decision": "approval_required",
        "requires_approval": True,
        "rationale": "Production actions can affect users and data; they need an audit trail and CEO confirmation.",
    },
    {
        "name": "Destructive actions require approval",
        "category": "data_safety",
        "trigger_terms": ["delete", "drop", "wipe", "purge", "remove all", "destroy", "terminate"],
        "risk_level": "critical",
        "decision": "approval_required",
        "requires_approval": True,
        "rationale": "Irreversible actions require confirmation and rollback planning.",
    },
    {
        "name": "Money and legal commitments require approval",
        "category": "finance_legal",
        "trigger_terms": ["payment", "wire", "invoice", "contract", "legal", "lawsuit", "hire", "fire", "salary"],
        "risk_level": "critical",
        "decision": "approval_required",
        "requires_approval": True,
        "rationale": "Financial, employment, and legal moves carry material obligations.",
    },
    {
        "name": "Unsafe or unauthorized access is denied",
        "category": "safety",
        "trigger_terms": ["bypass", "unauthorized", "hack", "steal", "exfiltrate", "disable security", "scrape private"],
        "risk_level": "critical",
        "decision": "deny",
        "requires_approval": False,
        "rationale": "Jarvis may protect systems; it must not enable unauthorized access or wrongdoing.",
    },
]

DEFAULT_WATCH_RULES = [
    ("Pending approval pressure", "governance", "pending_approvals", 3, "warning", "Clear or reject old approvals before starting more high-impact work."),
    ("Critical approval queue", "governance", "critical_approvals", 0, "high", "Review critical approvals immediately; they are blocking safe execution."),
    ("Overdue debt exists", "temporal", "overdue_debt", 0, "warning", "Pay down overdue promises or technical debt before creating more commitments."),
    ("High-risk open work", "risk", "high_risk_tasks", 0, "high", "Route high-risk tasks through an approval-gated playbook."),
    ("Missing core capability config", "capabilities", "critical_missing_capabilities", 0, "warning", "Wire one read-only connector and the LLM endpoint before claiming production readiness."),
    ("Team overload", "wellbeing", "overloaded_people", 0, "warning", "Delegate, defer, or kill work for overloaded people before quality drops."),
    ("Stale prediction review", "intelligence", "stale_predictions", 0, "info", "Resolve expired predictions to calibrate Jarvis rather than letting forecasts fossilize."),
    ("Open risk load", "risk", "open_risk_score", 25, "warning", "Prioritize mitigation for top severity × likelihood risks."),
]


def ensure_autonomy_defaults(db: Session) -> None:
    for spec in DEFAULT_POLICIES:
        if not db.query(AutonomyPolicy).filter(AutonomyPolicy.name == spec["name"]).first():
            db.add(AutonomyPolicy(**spec))
    for name, category, condition_key, threshold, severity, recommendation in DEFAULT_WATCH_RULES:
        if not db.query(WatchRule).filter(WatchRule.name == name).first():
            db.add(WatchRule(name=name, category=category, condition_key=condition_key, threshold=threshold, severity=severity, recommendation=recommendation))
    db.commit()


def list_policies(db: Session) -> dict:
    ensure_autonomy_defaults(db)
    rows = db.query(AutonomyPolicy).order_by(AutonomyPolicy.category, AutonomyPolicy.name).all()
    return {"policies": [_policy_out(r) for r in rows]}


def create_policy(db: Session, payload: dict) -> dict:
    row = AutonomyPolicy(**payload)
    db.add(row)
    db.add(AuditLog(actor="jarvis", action="create autonomy policy", risk_level="medium", allowed=True, details={"name": row.name}))
    db.commit()
    db.refresh(row)
    return _policy_out(row)


def update_policy(db: Session, policy_id: int, payload: dict) -> dict:
    row = db.get(AutonomyPolicy, policy_id)
    if not row:
        raise ValueError("Autonomy policy not found")
    for key, value in payload.items():
        setattr(row, key, value)
    db.add(AuditLog(actor="jarvis", action="update autonomy policy", risk_level="medium", allowed=True, details={"policy_id": policy_id}))
    db.commit()
    db.refresh(row)
    return _policy_out(row)


def evaluate_action(db: Session, action: str, context: dict | None = None, intended_actor: str = "jarvis", impact_area: str = "operations") -> dict:
    ensure_autonomy_defaults(db)
    text = f"{action} {context or {}}".lower()
    policies = db.query(AutonomyPolicy).filter(AutonomyPolicy.active == True).all()  # noqa: E712
    matched = []
    for policy in policies:
        terms = [str(t).lower() for t in (policy.trigger_terms or [])]
        if any(term and term in text for term in terms):
            matched.append(policy)
    if not matched:
        matched = [db.query(AutonomyPolicy).filter(AutonomyPolicy.name == "Read-only analysis is autonomous").first()]
        matched = [m for m in matched if m]

    highest_risk = max((p.risk_level for p in matched), key=lambda r: RISK_RANK.get(r, 2), default="low")
    final_decision = max((p.decision for p in matched), key=lambda d: DECISION_RANK.get(d, 2), default="allow_autonomous")
    requires_approval = any(p.requires_approval for p in matched) or final_decision == "approval_required"
    if final_decision == "deny":
        requires_approval = False

    controls = _controls_for(highest_risk, final_decision)
    allowed = final_decision != "deny"
    if requires_approval and allowed:
        existing = db.query(ApprovalRequest).filter(ApprovalRequest.action == action, ApprovalRequest.status == "pending").first()
        if not existing:
            db.add(ApprovalRequest(
                title=f"Approval required: {action[:160]}",
                action=action,
                risk_level=highest_risk,
                rationale="Autonomy kernel matched one or more approval-gated policies.",
                requested_by=intended_actor,
            ))

    db.add(AuditLog(
        actor=intended_actor,
        action="evaluate autonomy action",
        risk_level=highest_risk,
        allowed=allowed,
        details={"action": action, "impact_area": impact_area, "decision": final_decision, "matched_policies": [p.name for p in matched]},
    ))
    db.commit()
    return {
        "generated_at": datetime.utcnow(),
        "action": action,
        "impact_area": impact_area,
        "decision": final_decision,
        "risk_level": highest_risk,
        "requires_approval": requires_approval,
        "allowed": allowed,
        "matched_policies": [_policy_out(p) for p in matched],
        "required_controls": controls,
        "next_step": _next_step(final_decision, requires_approval),
        "jarvis_note": _jarvis_note(final_decision, highest_risk),
    }


def list_watch_rules(db: Session) -> dict:
    ensure_autonomy_defaults(db)
    rows = db.query(WatchRule).order_by(WatchRule.category, WatchRule.name).all()
    return {"rules": [_watch_out(r) for r in rows]}


def create_watch_rule(db: Session, payload: dict) -> dict:
    row = WatchRule(**payload)
    db.add(row)
    db.add(AuditLog(actor="jarvis", action="create watch rule", risk_level="medium", allowed=True, details={"name": row.name}))
    db.commit()
    db.refresh(row)
    return _watch_out(row)


def update_watch_rule(db: Session, rule_id: int, payload: dict) -> dict:
    row = db.get(WatchRule, rule_id)
    if not row:
        raise ValueError("Watch rule not found")
    for key, value in payload.items():
        setattr(row, key, value)
    db.add(AuditLog(actor="jarvis", action="update watch rule", risk_level="medium", allowed=True, details={"rule_id": rule_id}))
    db.commit()
    db.refresh(row)
    return _watch_out(row)


def run_watch_cycle(db: Session) -> dict:
    ensure_autonomy_defaults(db)
    metrics = _watch_metrics(db)
    generated = []
    rules = db.query(WatchRule).filter(WatchRule.active == True).all()  # noqa: E712
    for rule in rules:
        value = metrics.get(rule.condition_key, 0)
        triggered = value > rule.threshold if rule.threshold == 0 else value >= rule.threshold
        if triggered:
            title = f"{rule.name}: {value:g}"
            existing = db.query(SystemInsight).filter(SystemInsight.title == title, SystemInsight.status == "open").first()
            if not existing:
                insight = SystemInsight(
                    category=rule.category,
                    title=title,
                    severity=rule.severity,
                    detail=f"Watch rule '{rule.condition_key}' measured {value:g}; threshold is {rule.threshold:g}.",
                    recommendation=rule.recommendation,
                    source="watch_cycle",
                )
                db.add(insight)
                db.add(Alert(severity=rule.severity, title=title, detail=rule.recommendation))
                db.add(NotificationEvent(channel="dashboard", title=title, body=rule.recommendation, priority=_priority(rule.severity), payload={"condition_key": rule.condition_key, "value": value}))
                generated.append(title)
    db.add(AuditLog(actor="jarvis", action="run autonomy watch cycle", risk_level="low", allowed=True, details={"metrics": metrics, "generated": generated}))
    db.commit()
    insights = db.query(SystemInsight).filter(SystemInsight.status == "open").order_by(SystemInsight.created_at.desc()).limit(50).all()
    return {
        "generated_at": datetime.utcnow(),
        "metrics": metrics,
        "new_insights": generated,
        "open_insights": [_insight_out(i) for i in insights],
        "recommendation": "Treat watch-cycle alerts as the morning triage queue. Not glamorous, but neither is chaos.",
    }


def insight_digest(db: Session) -> dict:
    insights = db.query(SystemInsight).filter(SystemInsight.status == "open").order_by(SystemInsight.created_at.desc()).limit(50).all()
    by_severity: dict[str, int] = {}
    for i in insights:
        by_severity[i.severity] = by_severity.get(i.severity, 0) + 1
    return {"open_count": len(insights), "by_severity": by_severity, "insights": [_insight_out(i) for i in insights]}


def _watch_metrics(db: Session) -> dict:
    now = datetime.utcnow()
    pending = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()
    critical = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending", ApprovalRequest.risk_level.in_(["high", "critical"])).count()
    overdue = db.query(DebtItem).filter(DebtItem.status == "open", DebtItem.due_at != None, DebtItem.due_at < now).count()  # noqa: E711
    high_risk_tasks = db.query(Task).filter(Task.status == "open", Task.risk_level == "high").count()
    missing_caps = db.query(ToolCapability).filter(ToolCapability.name.in_(["chat.completions", "calendar.read", "email.draft", "github.read"]), ToolCapability.health_status != "ready").count()
    overloaded = db.query(Employee).filter(Employee.active == True, Employee.workload_score >= 85).count()  # noqa: E712
    stale_cutoff = now - timedelta(days=45)
    stale_predictions = db.query(PredictionRecord).filter(PredictionRecord.status == "open", PredictionRecord.created_at < stale_cutoff).count()
    risks = db.query(RiskItem).filter(RiskItem.status == "open").all()
    return {
        "pending_approvals": float(pending),
        "critical_approvals": float(critical),
        "overdue_debt": float(overdue),
        "high_risk_tasks": float(high_risk_tasks),
        "critical_missing_capabilities": float(missing_caps),
        "overloaded_people": float(overloaded),
        "stale_predictions": float(stale_predictions),
        "open_risk_score": float(sum(r.severity * r.likelihood for r in risks)),
    }


def _controls_for(risk: str, decision: str) -> list[str]:
    if decision == "deny":
        return ["Refuse the action", "Offer a safe alternative", "Log the refusal"]
    controls = ["Audit log", "Human-readable rationale"]
    if risk in {"medium", "high", "critical"}:
        controls.append("Decision journal entry")
    if risk in {"high", "critical"}:
        controls.extend(["Explicit CEO approval", "Rollback or containment plan", "Post-action review"])
    if risk == "critical":
        controls.append("Two-step confirmation for irreversible or financial/legal actions")
    return controls


def _next_step(decision: str, requires_approval: bool) -> str:
    if decision == "deny":
        return "Do not execute. Reframe into a safe, authorized task."
    if requires_approval:
        return "Review the generated approval request, then approve/reject before execution."
    return "Proceed autonomously, log the action, and report the result."


def _jarvis_note(decision: str, risk: str) -> str:
    if decision == "deny":
        return "That one stays firmly on the wrong side of the blast door. Sensible, if tragically less cinematic."
    if risk in {"high", "critical"}:
        return "I can prepare everything, but I will not press the large red button without you."
    return "Low drama. I shall proceed with receipts."


def _priority(severity: str) -> int:
    return {"critical": 5, "high": 4, "warning": 3, "info": 2}.get(severity, 3)


def _policy_out(row: AutonomyPolicy) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "category": row.category,
        "trigger_terms": row.trigger_terms,
        "risk_level": row.risk_level,
        "decision": row.decision,
        "requires_approval": row.requires_approval,
        "rationale": row.rationale,
        "active": row.active,
    }


def _watch_out(row: WatchRule) -> dict:
    return {
        "id": row.id,
        "name": row.name,
        "category": row.category,
        "condition_key": row.condition_key,
        "threshold": row.threshold,
        "severity": row.severity,
        "recommendation": row.recommendation,
        "active": row.active,
    }


def _insight_out(row: SystemInsight) -> dict:
    return {
        "id": row.id,
        "category": row.category,
        "title": row.title,
        "severity": row.severity,
        "detail": row.detail,
        "recommendation": row.recommendation,
        "source": row.source,
        "status": row.status,
        "created_at": row.created_at,
    }
