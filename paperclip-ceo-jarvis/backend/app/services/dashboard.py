from __future__ import annotations
from datetime import datetime
from sqlalchemy.orm import Session
from ..models import Company, Employee, Task, Objective, Alert, ApprovalRequest, AgentProfile, RiskItem, DebtItem, OpportunitySignal, PredictionRecord, AuditLog, WorkflowRun, ToolCapability, NotificationEvent, AutonomyPolicy, WatchRule, EnchantmentFeature, SystemInsight, V5Record, FederationTrace
from .burnout import workload_snapshot
from .alignment import alignment_report
from .opportunity import opportunity_radar
from .orchestrator import ensure_default_agents
from .governance import system_status
from .federation import system_statuses as federation_statuses


def executive_snapshot(db: Session) -> dict:
    ensure_default_agents(db)
    companies = db.query(Company).all()
    employees = db.query(Employee).filter(Employee.active == True).all()  # noqa: E712
    tasks = db.query(Task).filter(Task.status == "open").all()
    objectives = db.query(Objective).filter(Objective.status == "active").all()
    alerts = db.query(Alert).filter(Alert.resolved == False).order_by(Alert.created_at.desc()).limit(10).all()  # noqa: E712
    approvals = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").order_by(ApprovalRequest.created_at.desc()).limit(10).all()
    agents = db.query(AgentProfile).all()
    risks = db.query(RiskItem).filter(RiskItem.status == "open").all()
    debts = db.query(DebtItem).filter(DebtItem.status == "open").all()
    opportunities = db.query(OpportunitySignal).filter(OpportunitySignal.status == "open").order_by(OpportunitySignal.score.desc()).limit(5).all()
    predictions = db.query(PredictionRecord).filter(PredictionRecord.status == "open").all()
    audit_recent = db.query(AuditLog).order_by(AuditLog.created_at.desc()).limit(5).all()
    workflow_runs = db.query(WorkflowRun).filter(WorkflowRun.status.in_(["running", "blocked"])).order_by(WorkflowRun.created_at.desc()).limit(10).all()
    tool_capabilities = db.query(ToolCapability).all()
    notifications = db.query(NotificationEvent).filter(NotificationEvent.status == "queued").order_by(NotificationEvent.priority.desc(), NotificationEvent.created_at.desc()).limit(5).all()
    autonomy_policies = db.query(AutonomyPolicy).filter(AutonomyPolicy.active == True).all()  # noqa: E712
    watch_rules = db.query(WatchRule).filter(WatchRule.active == True).all()  # noqa: E712
    enchantments = db.query(EnchantmentFeature).all()
    top_enchantments = sorted(enchantments, key=lambda e: (-e.priority, e.complexity, e.title))[:5]
    open_insights = db.query(SystemInsight).filter(SystemInsight.status == "open").order_by(SystemInsight.created_at.desc()).limit(8).all()

    high_risk_tasks = [t for t in tasks if t.risk_level == "high" or t.priority >= 5]
    avg_health = round(sum(c.health_score for c in companies) / max(1, len(companies)), 2)
    agent_health = round(sum(a.reliability_score for a in agents) / max(1, len(agents)), 2)
    open_risk_score = sum(r.severity * r.likelihood for r in risks)
    workload = workload_snapshot(db)
    alignment = alignment_report(db)

    return {
        "generated_at": datetime.utcnow(),
        "system": system_status(db),
        "portfolio": {
            "company_count": len(companies),
            "average_health": avg_health,
            "companies": [{"id": c.id, "name": c.name, "health_score": c.health_score, "mission": c.mission} for c in companies],
            "active_objectives": len(objectives),
            "open_tasks": len(tasks),
            "high_risk_tasks": len(high_risk_tasks),
        },
        "people_and_agents": {
            "active_humans": len([e for e in employees if e.kind == "human"]),
            "active_employee_agents": len([e for e in employees if e.kind == "agent"]),
            "federated_agents": len(agents),
            "agent_health": agent_health,
            "workload": workload,
        },
        "governance": {
            "pending_approvals": [{"id": a.id, "title": a.title, "risk_level": a.risk_level, "created_at": a.created_at} for a in approvals],
            "open_risk_score": open_risk_score,
            "alerts": [{"id": a.id, "severity": a.severity, "title": a.title, "detail": a.detail} for a in alerts],
            "recent_audit": [{"action": a.action, "risk_level": a.risk_level, "allowed": a.allowed, "created_at": a.created_at} for a in audit_recent],
        },
        "intelligence": {
            "alignment": alignment,
            "opportunities": [{"title": o.title, "score": o.score, "window_days": o.window_days, "first_step": o.first_step} for o in opportunities] or opportunity_radar(db)[:5],
            "open_predictions": len(predictions),
            "debt_items": len(debts),
        },
        "mission_control": {
            "active_workflows": [{"id": w.id, "title": w.title, "template_key": w.template_key, "status": w.status, "risk_level": w.risk_level, "current_step_index": w.current_step_index} for w in workflow_runs],
            "queued_notifications": [{"id": n.id, "title": n.title, "priority": n.priority, "channel": n.channel} for n in notifications],
            "capability_readiness": {
                "total": len(tool_capabilities),
                "ready": len([c for c in tool_capabilities if c.health_status == "ready"]),
                "approval_gated": len([c for c in tool_capabilities if c.approval_required]),
                "missing_config": len([c for c in tool_capabilities if c.health_status == "missing_config"]),
            },
        },
        "autonomy_kernel": {
            "active_policies": len(autonomy_policies),
            "active_watch_rules": len(watch_rules),
            "open_insights": [{"id": i.id, "title": i.title, "severity": i.severity, "recommendation": i.recommendation} for i in open_insights],
            "default_posture": "read-only autonomous, high-impact approval-gated, unsafe unauthorized actions denied",
        },
        "cross_system_orchestration": {
            "trace_count": db.query(FederationTrace).count(),
            "recent_traces": [{"trace_id": t.trace_id, "kind": t.kind, "target_system": t.target_system, "status": t.status} for t in db.query(FederationTrace).order_by(FederationTrace.created_at.desc()).limit(5).all()],
            "system_statuses": federation_statuses(db),
        },
        "enchantment_lab": {
            "feature_count": len(enchantments),
            "planned_or_building": len([e for e in enchantments if e.status in {"planned", "building"}]),
            "top_candidates": [{"id": e.id, "key": e.key, "title": e.title, "category": e.category, "priority": e.priority, "complexity": e.complexity, "risk_level": e.risk_level} for e in top_enchantments],
        },
        "v5_missing_systems": {
            "record_count": db.query(V5Record).count(),
            "constitutional_principles": db.query(V5Record).filter(V5Record.kind == "constitutional_principle").count(),
            "zero_trust_rules": db.query(V5Record).filter(V5Record.kind == "zero_trust_rule").count(),
            "carbon_routes": db.query(V5Record).filter(V5Record.kind == "carbon_route").count(),
            "evaluation_suites": db.query(V5Record).filter(V5Record.kind == "evaluation_suite").count(),
            "context_policies": db.query(V5Record).filter(V5Record.kind == "context_policy").count(),
            "skill_listings": db.query(V5Record).filter(V5Record.kind == "skill_listing").count(),
            "engineering_domains": db.query(V5Record).filter(V5Record.kind == "engineering_domain").count(),
            "posture": "v5 installs 2026+ governance, workforce economy, company ecosystem, and engineering catalog modules.",
        },
        "ceo_recommendations": [
            "Approve or reject pending high-risk items before starting new execution.",
            "Review high-risk tasks and workload pressure together; they compound like unpleasant interest.",
            "Use a swarm run for strategic questions, then convert the synthesis into a decision journal entry.",
            "Run /mission-control/daily-ritual each morning and pick one commit/delegate/kill decision.",
            "Run /autonomy/watch-cycle before major planning sessions; it finds boring problems before they become expensive ones.",
            "Use /enchantments/audit to see which Jarvis tier needs the next real implementation push.",
            "Run /v5/audit to check 2026+ missing-system coverage before declaring production readiness.",
        ],
    }
