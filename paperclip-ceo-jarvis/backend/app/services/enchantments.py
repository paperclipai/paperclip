from __future__ import annotations
from collections import defaultdict
from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import (
    AgentProfile,
    ApprovalRequest,
    AuditLog,
    AutonomyPolicy,
    Company,
    DecisionJournal,
    EnchantmentFeature,
    KnowledgeDocument,
    PredictionRecord,
    RiskItem,
    SystemInsight,
    Task,
    ToolCapability,
    WatchRule,
    WorkflowTemplate,
)
from .autonomy import ensure_autonomy_defaults, run_watch_cycle
from .capabilities import ensure_tool_capabilities
from .orchestrator import ensure_default_agents
from .workflows import ensure_workflow_templates

DEFAULT_ENCHANTMENTS = [
    # Cognitive / explainability
    ("reasoning_dependency_graph", "Dependency Graph Reasoner", "cognitive", 5, 3, "medium", "Map assumptions, blockers, dependencies, and second-order effects for every major decision.", "Cuts hidden execution risk before it mutates into theatre."),
    ("pre_mortem_wargame", "Pre-Mortem War-Game", "cognitive", 5, 3, "medium", "Before launch, generate failure narratives, leading indicators, and containment plays.", "Turns optimism into a proper adult conversation."),
    ("counterfactual_review", "Counterfactual Decision Review", "cognitive", 4, 3, "low", "After decisions resolve, compare actual outcome against rejected paths.", "Improves strategic calibration instead of merely collecting memories."),
    ("confidence_calibrator", "Prediction Confidence Calibrator", "cognitive", 5, 2, "low", "Track forecast accuracy by agent, category, and time horizon.", "Makes confidence scores earn their keep."),
    ("assumption_ledger", "Assumption Ledger", "cognitive", 4, 2, "low", "Extract and track assumptions from decisions, tasks, and plans.", "Shows which plans are built on concrete, clay, or fog."),

    # Memory / context
    ("semantic_knowledge_base", "Local Semantic Knowledge Base", "memory", 5, 4, "medium", "Embed documents locally and retrieve relevant project, decision, and market context.", "Stops every conversation from starting with corporate amnesia."),
    ("decision_memory_graph", "Decision Memory Graph", "memory", 5, 4, "medium", "Connect decisions to tasks, predictions, risks, agents, and outcomes.", "Turns scattered notes into institutional memory."),
    ("context_autoload", "Automatic Context Autoload", "memory", 4, 3, "low", "Before answering, load the most relevant company, task, decision, and risk context.", "Fewer blank slates; fewer foolish reruns."),
    ("promise_tracker", "Promise and Obligation Tracker", "memory", 5, 2, "low", "Track promises made to users, staff, partners, and yourself.", "Prevents trust debt, which is the expensive kind."),
    ("founder_preference_model", "Founder Preference Model", "memory", 4, 3, "medium", "Learn durable CEO preferences for communication, risk tolerance, and build style.", "Personalized without becoming creepy. A fine line, handled carefully."),

    # Agent federation
    ("agent_scorecards", "Agent Performance Scorecards", "agents", 5, 2, "low", "Measure agent reliability, latency, usefulness, and calibration over time.", "Lets useful agents get promoted and nonsense agents get sent to the cupboard."),
    ("agent_contracts", "Agent Capability Contracts", "agents", 4, 3, "medium", "Define input/output schemas and authority limits for each agent.", "Prevents orchestration turning into interpretive dance."),
    ("red_team_council", "Red-Team Council", "agents", 5, 3, "medium", "Automatically assign a contrarian panel to high-impact plans.", "Creates resistance before the market does."),
    ("skill_marketplace", "Internal Skill Marketplace", "agents", 3, 4, "medium", "Route tasks to humans/agents based on skill, workload, and impact score.", "Better delegation; fewer heroic bottlenecks."),
    ("swarm_replay", "Swarm Replay and Audit", "agents", 4, 3, "low", "Replay multi-agent runs, conflicts, confidence, and final synthesis.", "Useful when someone asks why a decision happened. Including future you."),

    # Execution / operations
    ("approval_to_ticket", "Approval-to-Ticket Converter", "execution", 5, 3, "medium", "Turn approved requests into tasks, checklists, GitHub issues, and documentation stubs.", "Bridges thought and execution without copy-paste purgatory."),
    ("safe_code_patch_loop", "Safe Code Patch Loop", "execution", 5, 4, "high", "Generate patches, run tests, summarize diffs, and require approval before production use.", "Actual implementation with guardrails, not vibes with a compiler."),
    ("live_kpi_stream", "Live KPI Stream", "execution", 4, 4, "medium", "Pull metrics from database, analytics, GitHub, Stripe, and product logs.", "CEO dashboard becomes live instead of decorative."),
    ("weekly_mood_report", "Weekly Company Mood Report", "execution", 3, 3, "medium", "Summarize morale, workload, unresolved conflicts, and sustainability signals.", "Keeps the company human even when agents multiply."),
    ("incident_drill_runner", "Incident Drill Runner", "execution", 4, 3, "high", "Run simulated outages/security incidents and grade response readiness.", "Practice panic in private; perform calmly in public."),

    # Personality / interface
    ("adaptive_formality", "Adaptive Formality Dial", "personality", 3, 2, "low", "Shift between concise operator mode, board mode, and dry-wit companion mode.", "Style becomes context-aware instead of permanently theatrical."),
    ("protective_dissent", "Protective Dissent Mode", "personality", 5, 2, "low", "Firmly challenge decisions with high downside, poor evidence, or fatigue indicators.", "Loyalty means not cheering you into a wall."),
    ("milestone_rituals", "Milestone Celebration Rituals", "personality", 2, 2, "low", "Celebrate launches, recoveries, and consistency streaks without fake hype.", "Morale, but not confetti poisoning."),
    ("voice_command_layer", "Voice Command Layer", "personality", 4, 4, "medium", "Local wake-word optional voice interface with confirmation for high-risk actions.", "Feels like Jarvis while staying under authority gates."),
    ("vision_briefing", "Vision Briefing Mode", "personality", 3, 4, "medium", "Analyze screenshots, dashboards, docs, and diagrams with multimodal inputs.", "A proper command center should be able to look at things."),

    # Temporal / foresight
    ("seasonality_planner", "Seasonality-Aware Planning", "temporal", 4, 3, "low", "Account for holidays, funding cycles, launch windows, and team availability.", "Calendar reality, finally allowed into strategy."),
    ("opportunity_decay", "Opportunity Decay Tracker", "temporal", 5, 3, "low", "Score how quickly each opportunity loses value if delayed.", "Not all ideas age like wine; many age like milk."),
    ("runway_scenarios", "Runway and Resource Scenarios", "temporal", 4, 3, "medium", "Model team capacity, budget, and operational runway under several choices.", "Shows whether ambition fits the fuel tank."),
    ("commitment_calendar", "Commitment Calendar", "temporal", 4, 2, "low", "Convert promises, reviews, launches, and recurring rituals into a timeline.", "A CEO memory prosthetic, but polite."),
    ("decision_review_scheduler", "Decision Review Scheduler", "temporal", 5, 2, "low", "Automatically create review moments for major decisions and predictions.", "No more ungraded prophecies."),

    # Dashboards / visibility
    ("portfolio_god_view_v2", "Portfolio God View v2", "dashboard", 5, 3, "medium", "Add drill-downs for portfolio, companies, agents, capabilities, approvals, and watch alerts.", "Less JSON, more command center."),
    ("health_heatmap", "Company Health Heatmap", "dashboard", 4, 3, "low", "Visualize risk, velocity, workload, capability readiness, and alignment by entity.", "Shows where the room is on fire without requiring a poem."),
    ("board_mode", "Board Mode Dashboard", "dashboard", 4, 2, "medium", "One-click executive summary for board, investor, or partner review.", "Same truth, fewer knobs."),
    ("war_room_mode", "War Room Mode", "dashboard", 4, 3, "high", "Focused crisis interface with incident steps, owners, timers, and approvals.", "Panic gets a checklist and a chair."),
    ("agent_network_map", "Agent Network Map", "dashboard", 3, 3, "low", "Show which agents own which domains, tasks, and workflows.", "Delegation becomes visible."),

    # Risk / safety / integrations
    ("autonomy_kernel", "Autonomy Kernel", "safety", 5, 3, "high", "Evaluate each action against authority rules, side effects, and approval gates.", "The difference between assistant and liability."),
    ("connector_sandbox", "Connector Sandbox", "safety", 5, 4, "high", "Test integrations in read-only/sandbox mode before production permissions.", "Connect carefully; regret is not an integration strategy."),
    ("secret_rotation_reminder", "Secret Rotation Reminder", "safety", 4, 2, "medium", "Track credential age and prompt rotation without storing secrets.", "Security hygiene, minus the sticky note catastrophe."),
    ("regulatory_watch", "Regulatory Watch Desk", "safety", 3, 4, "medium", "Track policy and compliance items relevant to company operations.", "Boring until it saves you. Then suddenly thrilling."),
    ("data_access_manifest", "Data Access Manifest", "safety", 5, 3, "medium", "List every data source, scope, purpose, retention rule, and write capability.", "Omniscience, but with permission slips."),

    # Content / growth
    ("content_calendar_agent", "Content Calendar Agent", "growth", 4, 3, "medium", "Plan and draft product updates, technical posts, launch content, and social snippets.", "Distribution gets systematized, not remembered at midnight."),
    ("pitch_deck_builder", "Pitch Deck Builder", "growth", 3, 4, "medium", "Generate structured decks from metrics, strategy, product screenshots, and narrative.", "Less slide archaeology."),
    ("customer_signal_miner", "Customer Signal Miner", "growth", 5, 4, "medium", "Cluster customer pain, requests, churn reasons, and feedback.", "Roadmaps should answer reality, not just ambition."),
    ("pricing_experiment_planner", "Pricing Experiment Planner", "growth", 4, 3, "medium", "Design safe pricing tests with metrics, guardrails, and rollback criteria.", "Turns pricing from guesswork into adult supervision."),
    ("partnership_radar", "Partnership Radar", "growth", 3, 3, "medium", "Score possible partners, channels, integrations, and acquisition leads.", "Growth without random wandering."),
]

CATEGORY_MATURITY_TARGETS = {
    "cognitive": ["DecisionJournal", "PredictionRecord"],
    "memory": ["KnowledgeDocument", "DecisionJournal"],
    "agents": ["AgentProfile", "AgentRun"],
    "execution": ["WorkflowTemplate", "Task"],
    "personality": ["SOPDocument", "KnowledgeDocument"],
    "temporal": ["PredictionRecord", "DebtItem"],
    "dashboard": ["SystemInsight", "ToolCapability"],
    "safety": ["AutonomyPolicy", "WatchRule", "AuditLog"],
    "growth": ["OpportunitySignal", "KnowledgeDocument"],
}


def ensure_enchantments(db: Session) -> None:
    for key, title, category, priority, complexity, risk_level, description, benefit in DEFAULT_ENCHANTMENTS:
        existing = db.query(EnchantmentFeature).filter(EnchantmentFeature.key == key).first()
        if not existing:
            db.add(EnchantmentFeature(
                key=key,
                title=title,
                category=category,
                priority=priority,
                complexity=complexity,
                risk_level=risk_level,
                description=description,
                benefit=benefit,
                dependencies=_dependencies_for(category, risk_level),
                implementation_notes=_implementation_notes_for(category, risk_level),
            ))
    db.commit()


def list_enchantments(db: Session, category: str | None = None, status: str | None = None) -> dict:
    ensure_enchantments(db)
    query = db.query(EnchantmentFeature)
    if category:
        query = query.filter(EnchantmentFeature.category == category)
    if status:
        query = query.filter(EnchantmentFeature.status == status)
    rows = query.order_by(EnchantmentFeature.priority.desc(), EnchantmentFeature.complexity.asc(), EnchantmentFeature.title).all()
    groups: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        groups[row.category].append(_feature_out(row))
    return {
        "generated_at": datetime.utcnow(),
        "count": len(rows),
        "categories": sorted(groups.keys()),
        "features_by_category": groups,
        "top_10": [_feature_out(r) for r in rows[:10]],
    }


def update_feature_status(db: Session, feature_id: int, status: str, note: str = "") -> dict:
    feature = db.get(EnchantmentFeature, feature_id)
    if not feature:
        raise ValueError("Feature not found")
    feature.status = status
    if note:
        feature.implementation_notes = f"{feature.implementation_notes}\n\nUpdate: {note}".strip()
    if status in {"planned", "building"}:
        existing_task = db.query(Task).filter(Task.title == f"Implement: {feature.title}").first()
        if not existing_task:
            db.add(Task(
                title=f"Implement: {feature.title}",
                description=f"{feature.description}\n\nBenefit: {feature.benefit}\n\nNotes: {feature.implementation_notes}",
                priority=feature.priority,
                risk_level="high" if feature.risk_level in {"high", "critical"} else "medium",
                due_at=datetime.utcnow() + timedelta(days=max(7, 42 - feature.priority * 5)),
            ))
    db.add(AuditLog(actor="jarvis", action="update enchantment feature status", risk_level=feature.risk_level, allowed=True, details={"feature": feature.key, "status": status}))
    db.commit()
    db.refresh(feature)
    return _feature_out(feature)


def build_implementation_plan(db: Session, focus_categories: list[str] | None, horizon_days: int, capacity_level: str, include_high_risk: bool = False) -> dict:
    ensure_enchantments(db)
    focus = set(focus_categories or [])
    query = db.query(EnchantmentFeature).filter(EnchantmentFeature.status.in_(["backlog", "planned"]))
    if focus:
        query = query.filter(EnchantmentFeature.category.in_(list(focus)))
    if not include_high_risk:
        query = query.filter(EnchantmentFeature.risk_level != "high")
    rows = query.all()
    capacity = {"low": 4, "normal": 8, "aggressive": 14}.get(capacity_level, 8)
    scored = sorted(rows, key=lambda f: (-(f.priority * 2 - f.complexity), f.risk_level, f.title))[:capacity]
    phases = []
    day_cursor = 0
    for index, feature in enumerate(scored, start=1):
        duration = max(3, feature.complexity * 4)
        start_day = min(day_cursor, max(0, horizon_days - duration))
        day_cursor += duration
        phase = {
            "order": index,
            "feature_id": feature.id,
            "key": feature.key,
            "title": feature.title,
            "category": feature.category,
            "priority": feature.priority,
            "complexity": feature.complexity,
            "risk_level": feature.risk_level,
            "start_day": start_day,
            "target_day": min(horizon_days, start_day + duration),
            "dependencies": feature.dependencies,
            "definition_of_done": [
                "Backend endpoint/service implemented",
                "Dashboard or API visibility added",
                "Audit/approval behavior verified where relevant",
                "Smoke test updated",
                "Docs updated with usage and boundaries",
            ],
        }
        phases.append(phase)
    db.add(AuditLog(actor="jarvis", action="generate enchantment implementation plan", risk_level="low", allowed=True, details={"focus": list(focus), "horizon_days": horizon_days, "capacity_level": capacity_level, "features": [p["key"] for p in phases]}))
    db.commit()
    return {
        "generated_at": datetime.utcnow(),
        "horizon_days": horizon_days,
        "capacity_level": capacity_level,
        "selected_count": len(phases),
        "phases": phases,
        "recommendation": "Start with safety + memory + calibration. Speed is good; repeatable judgement is better.",
    }


def maturity_audit(db: Session) -> dict:
    ensure_enchantments(db)
    ensure_default_agents(db)
    ensure_workflow_templates(db)
    ensure_tool_capabilities(db)
    ensure_autonomy_defaults(db)
    run_watch_cycle(db)

    counts = {
        "companies": db.query(Company).count(),
        "agents": db.query(AgentProfile).count(),
        "workflows": db.query(WorkflowTemplate).count(),
        "knowledge_docs": db.query(KnowledgeDocument).count(),
        "decisions": db.query(DecisionJournal).count(),
        "predictions": db.query(PredictionRecord).count(),
        "autonomy_policies": db.query(AutonomyPolicy).count(),
        "watch_rules": db.query(WatchRule).count(),
        "capabilities": db.query(ToolCapability).count(),
        "risks": db.query(RiskItem).count(),
        "insights": db.query(SystemInsight).filter(SystemInsight.status == "open").count(),
    }
    capabilities = db.query(ToolCapability).all()
    ready_caps = len([c for c in capabilities if c.health_status == "ready"])
    missing_caps = len([c for c in capabilities if c.health_status == "missing_config"])
    pending_approvals = db.query(ApprovalRequest).filter(ApprovalRequest.status == "pending").count()

    tier_scores = {
        "cognitive": _score(counts["predictions"] >= 1, counts["decisions"] >= 1, db.query(EnchantmentFeature).filter(EnchantmentFeature.category == "cognitive").count() >= 5),
        "memory": _score(counts["knowledge_docs"] >= 1, counts["decisions"] >= 1, db.query(EnchantmentFeature).filter(EnchantmentFeature.category == "memory").count() >= 5),
        "agents": _score(counts["agents"] >= 7, counts["workflows"] >= 6, True),
        "execution": _score(counts["workflows"] >= 6, counts["capabilities"] >= 10, pending_approvals >= 0),
        "personality": _score(True, db.query(EnchantmentFeature).filter(EnchantmentFeature.category == "personality").count() >= 5, True),
        "temporal": _score(counts["predictions"] >= 1, True, True),
        "dashboard": _score(counts["capabilities"] >= 10, counts["insights"] >= 0, True),
        "safety": _score(counts["autonomy_policies"] >= 7, counts["watch_rules"] >= 8, missing_caps <= 6),
        "growth": _score(db.query(EnchantmentFeature).filter(EnchantmentFeature.category == "growth").count() >= 5, True, True),
    }
    overall = round(sum(tier_scores.values()) / len(tier_scores), 1)
    gaps = []
    if counts["knowledge_docs"] < 3:
        gaps.append("Add more project specs, customer notes, and strategy docs to the knowledge base.")
    if missing_caps:
        gaps.append(f"Configure missing capability environment variables ({missing_caps} currently missing).")
    if counts["predictions"] < 3:
        gaps.append("Create at least three prediction records and resolve them later for calibration.")
    if pending_approvals > 5:
        gaps.append("Approval queue is growing; review or reject stale approvals.")
    if counts["decisions"] < 3:
        gaps.append("Capture major decisions into the decision journal with review dates.")

    db.add(AuditLog(actor="jarvis", action="run v4 maturity audit", risk_level="low", allowed=True, details={"overall_score": overall, "gaps": gaps}))
    db.commit()
    return {
        "generated_at": datetime.utcnow(),
        "version": "4.0.0-autonomy-enchantments",
        "overall_maturity_score": overall,
        "tier_scores": tier_scores,
        "counts": counts,
        "capability_readiness": {"ready": ready_caps, "missing_config": missing_caps, "total": len(capabilities)},
        "gaps": gaps,
        "next_best_upgrades": _top_features(db, limit=8),
        "verdict": _verdict(overall),
    }


def brainstorm_matrix(db: Session) -> dict:
    ensure_enchantments(db)
    rows = db.query(EnchantmentFeature).order_by(EnchantmentFeature.category, EnchantmentFeature.priority.desc()).all()
    grouped: dict[str, list[dict]] = defaultdict(list)
    for row in rows:
        grouped[row.category].append({
            "title": row.title,
            "priority": row.priority,
            "complexity": row.complexity,
            "risk_level": row.risk_level,
            "benefit": row.benefit,
        })
    return {
        "generated_at": datetime.utcnow(),
        "matrix": grouped,
        "missing_but_beneficial": [
            "Local vector embeddings for true semantic memory",
            "Connector sandbox before live write permissions",
            "Agent scorecards with calibration over time",
            "Visual heatmaps instead of raw JSON-heavy dashboard blocks",
            "Voice/vision modes with approval-gated action confirmation",
            "Data access manifest and secret rotation hygiene",
        ],
    }


def _top_features(db: Session, limit: int = 8) -> list[dict]:
    rows = db.query(EnchantmentFeature).filter(EnchantmentFeature.status.in_(["backlog", "planned"])).order_by(EnchantmentFeature.priority.desc(), EnchantmentFeature.complexity.asc()).limit(limit).all()
    return [_feature_out(r) for r in rows]


def _feature_out(row: EnchantmentFeature) -> dict:
    return {
        "id": row.id,
        "key": row.key,
        "title": row.title,
        "category": row.category,
        "description": row.description,
        "benefit": row.benefit,
        "priority": row.priority,
        "complexity": row.complexity,
        "risk_level": row.risk_level,
        "status": row.status,
        "dependencies": row.dependencies,
        "implementation_notes": row.implementation_notes,
    }


def _dependencies_for(category: str, risk_level: str) -> list[str]:
    deps = {
        "cognitive": ["decision_journal", "prediction_records"],
        "memory": ["knowledge_documents", "local_storage"],
        "agents": ["agent_profiles", "agent_runs"],
        "execution": ["workflow_engine", "approval_requests"],
        "personality": ["system_prompt", "sop_library"],
        "temporal": ["prediction_records", "debt_items"],
        "dashboard": ["god_view_dashboard", "system_insights"],
        "safety": ["autonomy_policies", "audit_logs"],
        "growth": ["content_generator", "opportunity_signals"],
    }.get(category, ["audit_logs"])
    if risk_level in {"high", "critical"}:
        deps.append("explicit_approval_gate")
    return deps


def _implementation_notes_for(category: str, risk_level: str) -> str:
    base = f"Implement under the {category} subsystem with tests, audit logs, and API visibility."
    if risk_level in {"high", "critical"}:
        base += " Keep execution disabled until approval gates and rollback paths are tested."
    return base


def _score(*checks: bool) -> float:
    return round(sum(1 for c in checks if c) / max(1, len(checks)) * 100, 1)


def _verdict(score: float) -> str:
    if score >= 85:
        return "Strong mission-control foundation. Next step: real connectors, live metrics, and UI polish."
    if score >= 65:
        return "Useful operational core. Strengthen memory, calibration, and live integrations before scaling autonomy."
    return "Early foundation. Build safety, memory, and observability before adding more autonomous execution."
