from datetime import datetime, timedelta
from sqlalchemy.orm import Session
from ..models import Company, Employee, Objective, BriefingItem, Task, Memory, KnowledgeDocument, RiskItem, DebtItem, OpportunitySignal, PredictionRecord
from .knowledge import digest_text


def seed_if_empty(db: Session) -> None:
    if db.query(Company).count() == 0:
        company = Company(
            name="Paperclip / PhoenixRising AI",
            mission="Build local-first AI tools, research systems, and creative automation that are useful, safe, and self-hostable.",
            strategy="Zero-budget/open-source first, real data over mockups, fast iteration, strong execution, and practical agent orchestration.",
            health_score=78,
        )
        db.add(company)
        db.flush()
        db.add_all([
            Employee(company_id=company.id, name="CEO", role="Founder / CEO", kind="human", skills={"strategy": 90, "product": 85}, workload_score=82, impact_score=86, reliability_score=72, innovation_score=90, collaboration_score=70),
            Employee(company_id=company.id, name="Chief of Staff Agent", role="CEO Personal Agent", kind="agent", skills={"briefings": 90, "coordination": 86}, workload_score=46, impact_score=72, reliability_score=82, innovation_score=70, collaboration_score=76),
            Employee(company_id=company.id, name="Research Swarm", role="Research + OSINT Agent Team", kind="agent", skills={"research": 92, "summarization": 80}, workload_score=64, impact_score=74, reliability_score=68, innovation_score=76, collaboration_score=63),
        ])
        db.add_all([
            Objective(company_id=company.id, title="Ship Paperclip CEO Jarvis MVP", description="Always-on CEO assistant with briefings, decision simulation, and employee oversight.", priority=5),
            Objective(company_id=company.id, title="Connect real data sources", description="Add authorized calendar, email, docs, GitHub, and Paperclip database connectors.", priority=4),
            Objective(company_id=company.id, title="Add agent federation", description="Hermes, OpenClaw, Pi, Minerva, Analyst, Counselor, and Compliance specialists with approval gates.", priority=5),
        ])
        db.add_all([
            Task(title="Configure API key and local LLM", description="Set JARVIS_API_KEY and optional local OpenAI-compatible model endpoint.", priority=5, risk_level="medium"),
            Task(title="Add first real integration", description="Connect calendar or Paperclip company database with explicit credentials.", priority=4, risk_level="medium"),
            Task(title="Review approval workflow", description="Verify high-impact actions create pending approval requests before execution.", priority=5, risk_level="high"),
        ])
        db.add_all([
            BriefingItem(category="system", title="Jarvis runtime initialized", summary="Core CEO services are online: briefing, decision simulation, reputation, workload, board pack, opportunity radar, agent federation, governance, temporal intelligence, and dashboard snapshot.", urgency=4),
            Memory(scope="user", key="style", value="User prefers full implementation, production structure, zero-budget/open-source/self-hosted where possible.", importance=5),
            Memory(scope="system", key="jarvis_principle", value="Decisive within authorized scope; transparent about uncertainty; witty without becoming unserious.", importance=5),
        ])
        db.commit()

    # Idempotent v2 seeds.
    if db.query(KnowledgeDocument).count() == 0:
        content = "JARVIS v2 adds transparent rationale, decision journal, knowledge search, agent federation, approval gates, god-view dashboard, temporal forecasts, risk register, integration registry, and content generation."
        db.add(KnowledgeDocument(title="JARVIS v2 upgrade note", content=content, source="system_seed", tags=["jarvis", "upgrade", "ceo"], importance=5, digest=digest_text(content)))
    if db.query(RiskItem).count() == 0:
        db.add_all([
            RiskItem(title="Unreviewed high-impact automation", category="governance", severity=5, likelihood=3, owner="CEO", mitigation="Require explicit approval and audit logging."),
            RiskItem(title="Integration credential exposure", category="security", severity=5, likelihood=2, owner="Compliance", mitigation="Use env/vault storage, scan repos, never store raw credentials."),
        ])
    if db.query(DebtItem).count() == 0:
        db.add(DebtItem(title="Define production connector secrets policy", category="operational", owner="CEO", due_at=datetime.utcnow() + timedelta(days=7), impact=4))
    if db.query(OpportunitySignal).count() == 0:
        db.add_all([
            OpportunitySignal(title="Productize CEO Jarvis as a self-hosted executive OS", source="seed", score=88, window_days=45, rationale="The current codebase is already modular enough to package as a product tier.", first_step="Create one demo workflow: morning briefing -> swarm analysis -> approval -> task."),
            OpportunitySignal(title="Build Paperclip integrations marketplace", source="seed", score=82, window_days=60, rationale="Connectors are the difference between an assistant and an operating system.", first_step="Ship Google Calendar, Gmail draft, GitHub read, and Supabase metrics connectors first."),
        ])
    if db.query(PredictionRecord).count() == 0:
        db.add(PredictionRecord(subject="JARVIS adoption", prediction="Daily briefing plus approval workflow will become the highest-use CEO loop within 30 days.", confidence=0.72, horizon_days=30, expected_signal="At least 5 briefing or dashboard checks per week."))
    db.commit()
