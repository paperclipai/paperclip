from __future__ import annotations
import hashlib
from sqlalchemy.orm import Session
from ..models import AgentProfile, AgentRun, ApprovalRequest, AuditLog

DEFAULT_AGENTS = [
    {
        "name": "Hermes",
        "role": "Strategic reasoning and self-evolution engine",
        "tier": "cognitive",
        "mission": "Decompose complex strategic problems into scenarios, trade-offs, and reviewable recommendations.",
        "capabilities": ["scenario planning", "causal inference", "decision critique", "strategy synthesis"],
        "reliability_score": 82,
    },
    {
        "name": "OpenClaw",
        "role": "Market intelligence and opportunity radar",
        "tier": "intelligence",
        "mission": "Track competitors, market windows, customer pain, and external threats from authorized sources.",
        "capabilities": ["market scans", "competitor briefs", "trend detection", "opportunity scoring"],
        "reliability_score": 78,
    },
    {
        "name": "Pi",
        "role": "Execution and coding agent",
        "tier": "execution",
        "mission": "Turn approved plans into code, tests, documentation, and automation tasks.",
        "capabilities": ["code generation", "tests", "refactoring", "deployment checklist"],
        "reliability_score": 76,
    },
    {
        "name": "Minerva",
        "role": "Technical strategy and architecture guardian",
        "tier": "technical",
        "mission": "Guard architecture quality, scalability, maintainability, and cost discipline.",
        "capabilities": ["architecture review", "dependency risk", "security posture", "scalability planning"],
        "reliability_score": 80,
    },
    {
        "name": "Analyst",
        "role": "Financial and KPI analyst",
        "tier": "operations",
        "mission": "Model unit economics, runway, KPI changes, and resource allocation.",
        "capabilities": ["forecasting", "KPI analysis", "runway", "pricing"],
        "reliability_score": 74,
    },
    {
        "name": "Counselor",
        "role": "Founder workload and judgement protector",
        "tier": "wellbeing",
        "mission": "Detect overreach, decision fatigue, and harmful urgency while preserving ambition.",
        "capabilities": ["burnout detection", "prioritization", "protective dissent", "delegation"],
        "reliability_score": 81,
    },
    {
        "name": "Compliance",
        "role": "Safety, audit, privacy, and regulatory watcher",
        "tier": "governance",
        "mission": "Keep actions auditable, permissioned, and aligned with privacy/security obligations.",
        "capabilities": ["audit", "approval gates", "privacy review", "policy checks"],
        "reliability_score": 79,
    },
]


def ensure_default_agents(db: Session) -> None:
    for spec in DEFAULT_AGENTS:
        existing = db.query(AgentProfile).filter(AgentProfile.name == spec["name"]).first()
        if not existing:
            db.add(AgentProfile(**spec))
    db.commit()


def list_agents(db: Session) -> list[dict]:
    ensure_default_agents(db)
    agents = db.query(AgentProfile).order_by(AgentProfile.tier, AgentProfile.name).all()
    return [{
        "id": a.id,
        "name": a.name,
        "role": a.role,
        "tier": a.tier,
        "mission": a.mission,
        "capabilities": a.capabilities,
        "status": a.status,
        "reliability_score": a.reliability_score,
        "cost_mode": a.cost_mode,
    } for a in agents]


def _confidence(agent_name: str, task: str) -> float:
    digest = hashlib.sha256(f"{agent_name}|{task}".encode()).hexdigest()
    return round(0.55 + (int(digest[:4], 16) / 0xFFFF) * 0.35, 2)


def _agent_answer(agent: AgentProfile, task: str, mode: str) -> dict:
    name = agent.name.lower()
    if "hermes" in name:
        stance = "Use scenario branches and reversible pilots before commitment."
        risks = ["false certainty", "unvalidated assumptions"]
    elif "openclaw" in name:
        stance = "Scan market signals and customer pain before prioritizing build work."
        risks = ["market window missed", "competitor response"]
    elif "pi" in name:
        stance = "Convert approved decisions into tickets, tests, docs, and implementation steps."
        risks = ["scope creep", "untested automation"]
    elif "minerva" in name:
        stance = "Protect architecture, dependency choices, and long-term maintainability."
        risks = ["technical debt", "scaling bottleneck"]
    elif "compliance" in name:
        stance = "Keep high-impact actions behind explicit approval and audit trails."
        risks = ["privacy leak", "unauthorized action"]
    elif "counselor" in name:
        stance = "Protect CEO focus and team sustainability before adding more work."
        risks = ["burnout", "decision fatigue"]
    else:
        stance = "Quantify impact, cost, and measurable signals before commitment."
        risks = ["weak metrics", "resource misallocation"]
    return {
        "agent": agent.name,
        "role": agent.role,
        "stance": stance,
        "risks": risks,
        "recommended_action": f"Apply {agent.name}'s perspective to: {task[:160]}",
        "confidence": _confidence(agent.name, task + mode),
    }


def run_swarm(db: Session, task: str, mode: str = "parallel", agent_names: list[str] | None = None, require_approval_for_execution: bool = True) -> dict:
    ensure_default_agents(db)
    query = db.query(AgentProfile).filter(AgentProfile.status == "active")
    if agent_names:
        query = query.filter(AgentProfile.name.in_(agent_names))
    agents = query.all()
    results = [_agent_answer(agent, task, mode) for agent in agents]
    avg_conf = round(sum(r["confidence"] for r in results) / max(1, len(results)), 2)
    conflicts = []
    if mode in {"consensus", "red_team"}:
        conflicts.append("Execution agents favor action; governance/wellbeing agents request proof of capacity and approval first.")
    synthesis = {
        "task": task,
        "mode": mode,
        "agents_used": [a.name for a in agents],
        "confidence": avg_conf,
        "agent_results": results,
        "conflicts": conflicts,
        "synthesis": "Proceed only through a staged plan: validate, approve high-impact moves, execute, measure, and review.",
        "next_actions": [
            "Create a decision journal entry with expected outcome.",
            "Open approval request before public, financial, destructive, or production actions.",
            "Assign Pi to implementation only after the CEO approves the execution scope.",
        ],
    }
    db.add(AgentRun(agent_name="JARVIS Swarm", task=task, mode=mode, result=synthesis, confidence=avg_conf))
    if require_approval_for_execution and any(word in task.lower() for word in ["deploy", "send", "publish", "delete", "hire", "fire", "spend", "payment"]):
        db.add(ApprovalRequest(
            title=f"Approval required: {task[:180]}",
            action=task,
            risk_level="high",
            rationale="Swarm detected execution intent touching production, public, financial, or irreversible action.",
        ))
    db.add(AuditLog(actor="jarvis", action="run agent swarm", risk_level="medium", allowed=True, details={"task": task, "mode": mode}))
    db.commit()
    return synthesis
