from __future__ import annotations
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import (
    WorkflowTemplate,
    WorkflowRun,
    WorkflowStep,
    ApprovalRequest,
    AuditLog,
    Task,
    NotificationEvent,
    SOPDocument,
    RiskItem,
    DebtItem,
)
from .orchestrator import run_swarm
from .briefing import morning_briefing
from .dashboard import executive_snapshot
from .temporal import execution_timeline, opportunity_windows, debt_snapshot
from .risk import risk_register
from .federation import briefing as federation_briefing, execute_task as federation_execute_task, route_task as federation_route_task


DEFAULT_PLAYBOOKS = [
    {
        "key": "daily_ceo_operating_loop",
        "name": "Daily CEO Operating Loop",
        "category": "cadence",
        "trigger": "weekday_morning",
        "objective": "Turn system state into a short executive plan for today.",
        "required_agents": ["Hermes", "Counselor", "Analyst"],
        "approval_policy": "none_read_only",
        "steps": [
            {"title": "Generate morning briefing", "owner_agent": "JARVIS", "instructions": "Collect alerts, workload, open tasks, and recommendations.", "requires_approval": False},
            {"title": "Rank top three decisions", "owner_agent": "Hermes", "instructions": "Prioritize decisions by reversibility, risk, and time sensitivity.", "requires_approval": False},
            {"title": "Protect focus", "owner_agent": "Counselor", "instructions": "Identify what should be delegated, delayed, or deleted.", "requires_approval": False},
            {"title": "Commit today plan", "owner_agent": "CEO", "instructions": "CEO selects the single most important outcome for the day.", "requires_approval": True},
        ],
    },
    {
        "key": "strategic_decision_wargame",
        "name": "Strategic Decision War-game",
        "category": "strategy",
        "trigger": "major_decision",
        "objective": "Test a decision against scenarios, risks, capacity, and market timing before commitment.",
        "required_agents": ["Hermes", "OpenClaw", "Minerva", "Analyst", "Compliance"],
        "approval_policy": "always_before_execution",
        "steps": [
            {"title": "Frame decision and constraints", "owner_agent": "Hermes", "instructions": "Define the exact decision, non-goals, assumptions, and success metric.", "requires_approval": False},
            {"title": "Market and opportunity scan", "owner_agent": "OpenClaw", "instructions": "Summarize timing, competitors, customer pain, and distribution leverage.", "requires_approval": False},
            {"title": "Architecture and execution review", "owner_agent": "Minerva", "instructions": "Identify technical path, dependencies, and debt created.", "requires_approval": False},
            {"title": "Financial/KPI impact", "owner_agent": "Analyst", "instructions": "Estimate impact, cost, and leading indicators.", "requires_approval": False},
            {"title": "CEO approval gate", "owner_agent": "CEO", "instructions": "Approve, reject, or request a narrower pilot.", "requires_approval": True},
        ],
    },
    {
        "key": "product_launch_room",
        "name": "Product Launch Room",
        "category": "execution",
        "trigger": "launch_or_public_release",
        "objective": "Move from idea to safe launch with approval gates, comms, and rollback planning.",
        "required_agents": ["Pi", "Minerva", "Compliance", "OpenClaw"],
        "approval_policy": "public_or_production_requires_approval",
        "steps": [
            {"title": "Launch readiness checklist", "owner_agent": "Minerva", "instructions": "Check tests, observability, support load, and rollback plan.", "requires_approval": False},
            {"title": "Security and privacy check", "owner_agent": "Compliance", "instructions": "Verify no exposed credentials, unsafe permissions, or policy gaps.", "requires_approval": False},
            {"title": "Generate launch communications", "owner_agent": "JARVIS", "instructions": "Draft announcement, release notes, FAQs, and internal briefing.", "requires_approval": True},
            {"title": "Execute approved release", "owner_agent": "Pi", "instructions": "Only execute after explicit approval.", "requires_approval": True},
        ],
    },
    {
        "key": "incident_response_room",
        "name": "Incident Response Room",
        "category": "risk",
        "trigger": "critical_alert",
        "objective": "Contain damage, preserve evidence, communicate clearly, and restore service.",
        "required_agents": ["Compliance", "Minerva", "Pi", "Counselor"],
        "approval_policy": "emergency_actions_logged_then_reviewed",
        "steps": [
            {"title": "Classify incident severity", "owner_agent": "Compliance", "instructions": "Classify scope, affected systems, users, data, and legal risk.", "requires_approval": False},
            {"title": "Contain and preserve evidence", "owner_agent": "Minerva", "instructions": "Recommend containment steps and evidence preservation.", "requires_approval": True},
            {"title": "Restoration plan", "owner_agent": "Pi", "instructions": "Prepare rollback/recovery steps with tests.", "requires_approval": True},
            {"title": "Stakeholder communication", "owner_agent": "JARVIS", "instructions": "Draft factual status update without speculation.", "requires_approval": True},
        ],
    },
    {
        "key": "integration_onboarding",
        "name": "Authorized Integration Onboarding",
        "category": "infrastructure",
        "trigger": "new_connector",
        "objective": "Connect a new data source without leaking credentials or exceeding permissions.",
        "required_agents": ["Compliance", "Minerva", "Pi"],
        "approval_policy": "credentials_never_stored_raw",
        "steps": [
            {"title": "Define exact scopes", "owner_agent": "Compliance", "instructions": "Minimize permissions; document read/write boundaries.", "requires_approval": False},
            {"title": "Configure environment/vault keys", "owner_agent": "CEO", "instructions": "Human provides credentials through approved secret path only.", "requires_approval": True},
            {"title": "Run safe sync test", "owner_agent": "Pi", "instructions": "Read-only first sync; log audit event.", "requires_approval": True},
            {"title": "Document connector SOP", "owner_agent": "JARVIS", "instructions": "Write runbook and failure procedure.", "requires_approval": False},
        ],
    },
    {
        "key": "weekly_strategy_review",
        "name": "Weekly Strategy Review",
        "category": "cadence",
        "trigger": "friday_afternoon",
        "objective": "Turn the week into decisions, lessons, risk updates, and next-week commitments.",
        "required_agents": ["Hermes", "Analyst", "Counselor"],
        "approval_policy": "none_read_only",
        "steps": [
            {"title": "Summarize week", "owner_agent": "JARVIS", "instructions": "Summarize completed tasks, blockers, alerts, and approvals.", "requires_approval": False},
            {"title": "Score prediction accuracy", "owner_agent": "Analyst", "instructions": "Review resolved predictions and calibration gaps.", "requires_approval": False},
            {"title": "Identify strategic drift", "owner_agent": "Hermes", "instructions": "Find tasks not aligned with company mission and strategy.", "requires_approval": False},
            {"title": "Set next-week constraints", "owner_agent": "CEO", "instructions": "Choose priority, capacity limits, and delegation plan.", "requires_approval": True},
        ],
    },
]


DEFAULT_SOPS = [
    ("Approval Gates", "governance", "High-impact actions require explicit CEO approval: public publishing, external sending, destructive database/file actions, payments, hiring/firing, legal notices, production deploys, or credential changes."),
    ("Credential Handling", "security", "Never store raw credentials in the database or generated docs. Use environment variables, a local secret manager, or OAuth. Scan generated repositories before publishing."),
    ("Decision Journal", "strategy", "Every major decision should include context, assumptions, chosen path, expected outcome, review date, leading indicators, and post-review accuracy."),
    ("Swarm Delegation", "agents", "Use Hermes for strategy, OpenClaw for market intelligence, Pi for implementation, Minerva for architecture, Analyst for metrics, Counselor for workload, Compliance for approvals and policy."),
]


def ensure_workflow_templates(db: Session) -> None:
    for spec in DEFAULT_PLAYBOOKS:
        existing = db.query(WorkflowTemplate).filter(WorkflowTemplate.key == spec["key"]).first()
        if not existing:
            db.add(WorkflowTemplate(**spec))
    for title, category, body in DEFAULT_SOPS:
        existing = db.query(SOPDocument).filter(SOPDocument.title == title).first()
        if not existing:
            db.add(SOPDocument(title=title, category=category, body=body, owner="JARVIS", review_days=30))
    db.commit()


def list_playbooks(db: Session) -> list[dict]:
    ensure_workflow_templates(db)
    rows = db.query(WorkflowTemplate).filter(WorkflowTemplate.active == True).order_by(WorkflowTemplate.category, WorkflowTemplate.name).all()  # noqa: E712
    return [
        {
            "id": r.id,
            "key": r.key,
            "name": r.name,
            "category": r.category,
            "trigger": r.trigger,
            "objective": r.objective,
            "required_agents": r.required_agents,
            "approval_policy": r.approval_policy,
            "step_count": len(r.steps or []),
        }
        for r in rows
    ]


def _risk_from_text(text: str) -> str:
    lowered = text.lower()
    critical_terms = ["delete", "payment", "wire", "fire", "legal", "credential", "production", "publish", "send", "external", "deploy"]
    medium_terms = ["hire", "launch", "connect", "sync", "database", "customer", "pricing"]
    if any(t in lowered for t in critical_terms):
        return "high"
    if any(t in lowered for t in medium_terms):
        return "medium"
    return "low"


def start_workflow(db: Session, template_key: str, title: str | None, owner: str, input_payload: dict | None = None) -> dict:
    ensure_workflow_templates(db)
    template = db.query(WorkflowTemplate).filter(WorkflowTemplate.key == template_key, WorkflowTemplate.active == True).first()  # noqa: E712
    if not template:
        raise ValueError(f"Workflow template not found: {template_key}")
    payload = input_payload or {}
    run_title = title or template.name
    risk_level = _risk_from_text(f"{run_title} {payload}")
    run = WorkflowRun(template_key=template.key, title=run_title, owner=owner, input_payload=payload, risk_level=risk_level)
    db.add(run)
    db.flush()
    step_rows = []
    for index, step in enumerate(template.steps or []):
        row = WorkflowStep(
            run_id=run.id,
            step_index=index,
            title=step.get("title", f"Step {index + 1}"),
            owner_agent=step.get("owner_agent", "JARVIS"),
            instructions=step.get("instructions", ""),
            requires_approval=bool(step.get("requires_approval", False)),
            status="running" if index == 0 else "pending",
        )
        step_rows.append(row)
        db.add(row)
    if risk_level == "high":
        db.add(ApprovalRequest(
            title=f"Workflow approval required: {run_title}",
            action=f"Start or continue workflow {template.key}: {run_title}",
            risk_level="high",
            rationale="Mission-control workflow contains high-impact execution terms and must stay approval-gated.",
        ))
        run.status = "blocked"
    db.add(AuditLog(actor="jarvis", action="start mission-control workflow", risk_level=risk_level, allowed=True, details={"template_key": template.key, "run_id": run.id}))
    db.add(NotificationEvent(channel="dashboard", title=f"Workflow started: {run_title}", body=f"Template: {template.name}. Risk: {risk_level}.", priority=4 if risk_level == "high" else 3, payload={"run_id": run.id}))
    db.commit()
    db.refresh(run)
    return workflow_detail(db, run.id)


def workflow_detail(db: Session, run_id: int) -> dict:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise ValueError("Workflow run not found")
    steps = db.query(WorkflowStep).filter(WorkflowStep.run_id == run.id).order_by(WorkflowStep.step_index).all()
    return {
        "id": run.id,
        "template_key": run.template_key,
        "title": run.title,
        "status": run.status,
        "owner": run.owner,
        "risk_level": run.risk_level,
        "current_step_index": run.current_step_index,
        "input_payload": run.input_payload,
        "outputs": run.outputs,
        "steps": [
            {
                "id": s.id,
                "step_index": s.step_index,
                "title": s.title,
                "owner_agent": s.owner_agent,
                "status": s.status,
                "instructions": s.instructions,
                "requires_approval": s.requires_approval,
                "output": s.output,
            }
            for s in steps
        ],
    }


def list_workflow_runs(db: Session, status: str = "running") -> dict:
    q = db.query(WorkflowRun)
    if status != "all":
        q = q.filter(WorkflowRun.status == status)
    runs = q.order_by(WorkflowRun.created_at.desc()).limit(100).all()
    return {"runs": [workflow_detail(db, r.id) for r in runs]}


def advance_workflow(db: Session, run_id: int, output: dict | None = None, status: str = "completed") -> dict:
    run = db.get(WorkflowRun, run_id)
    if not run:
        raise ValueError("Workflow run not found")
    steps = db.query(WorkflowStep).filter(WorkflowStep.run_id == run.id).order_by(WorkflowStep.step_index).all()
    if not steps:
        run.status = "completed"
        db.commit()
        return workflow_detail(db, run.id)
    current = None
    for step in steps:
        if step.step_index == run.current_step_index:
            current = step
            break
    if current is None:
        current = steps[-1]
    current.status = status
    current.output = output or {}
    if status == "blocked":
        run.status = "blocked"
        db.add(NotificationEvent(channel="dashboard", title=f"Workflow blocked: {run.title}", body=current.title, priority=5, payload={"run_id": run.id, "step_id": current.id}))
    elif run.current_step_index + 1 >= len(steps):
        run.status = "completed"
        run.outputs = {**(run.outputs or {}), "completed_at": datetime.utcnow().isoformat(), "last_step_output": output or {}}
    else:
        run.current_step_index += 1
        next_step = steps[run.current_step_index]
        next_step.status = "running"
        if next_step.requires_approval:
            run.status = "blocked"
            db.add(ApprovalRequest(
                title=f"Approve workflow step: {next_step.title}",
                action=f"Workflow {run.title} step {next_step.step_index + 1}: {next_step.instructions}",
                risk_level=run.risk_level if run.risk_level in {"medium", "high", "critical"} else "medium",
                rationale="Workflow step declares approval requirement.",
            ))
        else:
            run.status = "running"
    db.add(AuditLog(actor="jarvis", action="advance mission-control workflow", risk_level=run.risk_level, allowed=True, details={"run_id": run.id, "step_status": status}))
    db.commit()
    return workflow_detail(db, run.id)


def command_triage(db: Session, command: str, context: dict | None = None, autonomous: bool = False) -> dict:
    ensure_workflow_templates(db)
    context = context or {}
    lowered = command.lower()
    if any(word in lowered for word in ["incident", "breach", "down", "outage", "leak", "compromised"]):
        template_key = "incident_response_room"
    elif any(word in lowered for word in ["launch", "publish", "release", "announce"]):
        template_key = "product_launch_room"
    elif any(word in lowered for word in ["connect", "integration", "oauth", "gmail", "calendar", "github", "supabase", "stripe"]):
        template_key = "integration_onboarding"
    elif any(word in lowered for word in ["weekly", "review", "retrospective"]):
        template_key = "weekly_strategy_review"
    elif any(word in lowered for word in ["should", "decide", "pivot", "strategy", "market", "pricing", "hire"]):
        template_key = "strategic_decision_wargame"
    else:
        template_key = "daily_ceo_operating_loop"

    risk = _risk_from_text(command)
    recommended_agents = ["Hermes", "Counselor"]
    if template_key in {"product_launch_room", "integration_onboarding", "incident_response_room"}:
        recommended_agents = ["Minerva", "Compliance", "Pi"]
    elif template_key == "strategic_decision_wargame":
        recommended_agents = ["Hermes", "OpenClaw", "Minerva", "Analyst", "Compliance"]

    swarm = run_swarm(db, command, mode="consensus" if risk != "low" else "parallel", agent_names=recommended_agents, require_approval_for_execution=True)
    cross_system_route = federation_route_task(db, command, "auto", context, allow_execution=autonomous)
    cross_system_execution = None
    run = None
    if autonomous and risk != "high":
        run = start_workflow(db, template_key, command[:240], "CEO", {"command": command, "context": context})
        cross_system_execution = federation_execute_task(db, command, "auto", True, context)

    return {
        "command": command,
        "risk_level": risk,
        "recommended_playbook": template_key,
        "recommended_agents": recommended_agents,
        "approval_needed": risk == "high" or any(w in lowered for w in ["publish", "send", "payment", "delete", "deploy", "credential"]),
        "swarm_synthesis": swarm,
        "cross_system_route": cross_system_route,
        "cross_system_execution": cross_system_execution,
        "workflow_started": run,
        "next_best_actions": [
            "Start the recommended playbook." if not run else "Complete the first playbook step.",
            "Create or review approval request before irreversible execution." if risk == "high" else "Keep execution reversible until evidence improves.",
            "Write expected outcome into the decision journal if this affects more than one week of work.",
        ],
    }


def next_best_actions(db: Session) -> dict:
    snapshot = executive_snapshot(db)
    approvals = snapshot["governance"]["pending_approvals"]
    risk_score = snapshot["governance"]["open_risk_score"]
    workload = snapshot["people_and_agents"]["workload"]
    actions = []
    if approvals:
        actions.append({"priority": 5, "title": "Clear pending approvals", "reason": f"{len(approvals)} approval(s) are blocking execution.", "playbook": "strategic_decision_wargame"})
    if risk_score >= 20:
        actions.append({"priority": 5, "title": "Run risk review", "reason": f"Open risk score is {risk_score}.", "playbook": "incident_response_room"})
    if workload.get("risk_count", 0):
        actions.append({"priority": 4, "title": "Rebalance workload", "reason": "At least one person/agent is overloaded.", "playbook": "daily_ceo_operating_loop"})
    actions.append({"priority": 4, "title": "Ship one integration safely", "reason": "A CEO assistant becomes useful when connected to authorized real data.", "playbook": "integration_onboarding"})
    actions.append({"priority": 3, "title": "Run weekly strategic review", "reason": "Convert activity into calibrated learning.", "playbook": "weekly_strategy_review"})
    actions = sorted(actions, key=lambda a: a["priority"], reverse=True)[:5]
    return {"generated_at": datetime.utcnow(), "actions": actions}


def daily_operating_ritual(db: Session, primary_user: str) -> dict:
    briefing = morning_briefing(db, primary_user)
    timeline = execution_timeline(db, 14)
    windows = opportunity_windows(db)
    debt = debt_snapshot(db)
    risks = risk_register(db)
    nba = next_best_actions(db)
    cross_system = federation_briefing(db, f"Daily ritual for {primary_user}")
    return {
        "generated_at": datetime.utcnow(),
        "opening": f"Good morning, {primary_user}. Today we optimize for one important outcome, not a carnival of half-started tasks.",
        "briefing": briefing,
        "cross_system": cross_system,
        "next_14_days": timeline,
        "opportunity_windows": windows,
        "debt": debt,
        "risk_register": risks,
        "next_best_actions": nba["actions"],
        "ceo_prompt": "Choose one action to commit, one to delegate, and one to kill.",
    }


def list_sops(db: Session) -> dict:
    ensure_workflow_templates(db)
    rows = db.query(SOPDocument).filter(SOPDocument.active == True).order_by(SOPDocument.category, SOPDocument.title).all()  # noqa: E712
    return {"sops": [{"id": r.id, "title": r.title, "category": r.category, "body": r.body, "owner": r.owner, "review_days": r.review_days} for r in rows]}


def create_sop(db: Session, title: str, category: str, body: str, owner: str, review_days: int) -> SOPDocument:
    row = SOPDocument(title=title, category=category, body=body, owner=owner, review_days=review_days)
    db.add(row)
    db.commit()
    db.refresh(row)
    return row
