from datetime import datetime
from sqlalchemy import String, Text, DateTime, Boolean, Integer, Float, ForeignKey, JSON
from sqlalchemy.orm import Mapped, mapped_column, relationship
from .db import Base


class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow)
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow)


class Company(TimestampMixin, Base):
    __tablename__ = "companies"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(200), unique=True, index=True)
    mission: Mapped[str] = mapped_column(Text, default="Build useful AI systems with disciplined execution.")
    strategy: Mapped[str] = mapped_column(Text, default="Ship practical products, protect users, compound knowledge.")
    health_score: Mapped[float] = mapped_column(Float, default=75.0)
    employees: Mapped[list["Employee"]] = relationship(back_populates="company")


class Employee(TimestampMixin, Base):
    __tablename__ = "employees"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"))
    name: Mapped[str] = mapped_column(String(200), index=True)
    role: Mapped[str] = mapped_column(String(200), default="Contributor")
    kind: Mapped[str] = mapped_column(String(50), default="human")  # human | agent
    skills: Mapped[dict] = mapped_column(JSON, default=dict)
    workload_score: Mapped[float] = mapped_column(Float, default=50.0)
    impact_score: Mapped[float] = mapped_column(Float, default=50.0)
    reliability_score: Mapped[float] = mapped_column(Float, default=50.0)
    innovation_score: Mapped[float] = mapped_column(Float, default=50.0)
    collaboration_score: Mapped[float] = mapped_column(Float, default=50.0)
    active: Mapped[bool] = mapped_column(Boolean, default=True)
    company: Mapped[Company] = relationship(back_populates="employees")


class Objective(TimestampMixin, Base):
    __tablename__ = "objectives"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int] = mapped_column(ForeignKey("companies.id"))
    title: Mapped[str] = mapped_column(String(250), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[int] = mapped_column(Integer, default=3)
    status: Mapped[str] = mapped_column(String(50), default="active")
    owner_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)


class Task(TimestampMixin, Base):
    __tablename__ = "tasks"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    owner_employee_id: Mapped[int | None] = mapped_column(ForeignKey("employees.id"), nullable=True)
    priority: Mapped[int] = mapped_column(Integer, default=3)
    status: Mapped[str] = mapped_column(String(50), default="open")
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    risk_level: Mapped[str] = mapped_column(String(50), default="low")


class Decision(TimestampMixin, Base):
    __tablename__ = "decisions"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    decision: Mapped[str] = mapped_column(Text)
    horizon_days: Mapped[int] = mapped_column(Integer, default=60)
    assumptions: Mapped[dict] = mapped_column(JSON, default=dict)
    simulation: Mapped[dict] = mapped_column(JSON, default=dict)


class BriefingItem(TimestampMixin, Base):
    __tablename__ = "briefing_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(100), default="general")
    title: Mapped[str] = mapped_column(String(250))
    summary: Mapped[str] = mapped_column(Text)
    urgency: Mapped[int] = mapped_column(Integer, default=3)
    source: Mapped[str] = mapped_column(String(150), default="jarvis")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class ReputationEvent(TimestampMixin, Base):
    __tablename__ = "reputation_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    employee_id: Mapped[int] = mapped_column(ForeignKey("employees.id"))
    category: Mapped[str] = mapped_column(String(100))
    score_delta: Mapped[float] = mapped_column(Float)
    note: Mapped[str] = mapped_column(Text, default="")


class Memory(TimestampMixin, Base):
    __tablename__ = "memories"
    id: Mapped[int] = mapped_column(primary_key=True)
    scope: Mapped[str] = mapped_column(String(50), default="user")
    key: Mapped[str] = mapped_column(String(250), index=True)
    value: Mapped[str] = mapped_column(Text)
    importance: Mapped[int] = mapped_column(Integer, default=3)


class Alert(TimestampMixin, Base):
    __tablename__ = "alerts"
    id: Mapped[int] = mapped_column(primary_key=True)
    severity: Mapped[str] = mapped_column(String(50), default="info")
    title: Mapped[str] = mapped_column(String(250))
    detail: Mapped[str] = mapped_column(Text, default="")
    resolved: Mapped[bool] = mapped_column(Boolean, default=False)


class AuditLog(TimestampMixin, Base):
    __tablename__ = "audit_logs"
    id: Mapped[int] = mapped_column(primary_key=True)
    actor: Mapped[str] = mapped_column(String(100), default="jarvis")
    action: Mapped[str] = mapped_column(String(250))
    risk_level: Mapped[str] = mapped_column(String(50), default="low")
    allowed: Mapped[bool] = mapped_column(Boolean, default=True)
    details: Mapped[dict] = mapped_column(JSON, default=dict)


# v2.0 upgrade tables: institutional memory, agent federation, governance, temporal intelligence.
class KnowledgeDocument(TimestampMixin, Base):
    __tablename__ = "knowledge_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    source: Mapped[str] = mapped_column(String(250), default="manual")
    content: Mapped[str] = mapped_column(Text)
    tags: Mapped[list] = mapped_column(JSON, default=list)
    importance: Mapped[int] = mapped_column(Integer, default=3)
    digest: Mapped[str] = mapped_column(String(128), index=True)


class DecisionJournal(TimestampMixin, Base):
    __tablename__ = "decision_journal"
    id: Mapped[int] = mapped_column(primary_key=True)
    decision_id: Mapped[int | None] = mapped_column(ForeignKey("decisions.id"), nullable=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    context: Mapped[str] = mapped_column(Text, default="")
    chosen_path: Mapped[str] = mapped_column(Text, default="")
    expected_outcome: Mapped[str] = mapped_column(Text, default="")
    review_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    prediction_accuracy: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="open")


class AgentProfile(TimestampMixin, Base):
    __tablename__ = "agent_profiles"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    role: Mapped[str] = mapped_column(String(220))
    tier: Mapped[str] = mapped_column(String(80), default="specialist")
    mission: Mapped[str] = mapped_column(Text)
    capabilities: Mapped[list] = mapped_column(JSON, default=list)
    status: Mapped[str] = mapped_column(String(50), default="active")
    reliability_score: Mapped[float] = mapped_column(Float, default=75.0)
    cost_mode: Mapped[str] = mapped_column(String(80), default="local/open-source")


class AgentRun(TimestampMixin, Base):
    __tablename__ = "agent_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    agent_name: Mapped[str] = mapped_column(String(160), index=True)
    task: Mapped[str] = mapped_column(Text)
    mode: Mapped[str] = mapped_column(String(80), default="solo")
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    confidence: Mapped[float] = mapped_column(Float, default=0.65)
    status: Mapped[str] = mapped_column(String(50), default="completed")


class ApprovalRequest(TimestampMixin, Base):
    __tablename__ = "approval_requests"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    action: Mapped[str] = mapped_column(Text)
    risk_level: Mapped[str] = mapped_column(String(50), default="medium")
    rationale: Mapped[str] = mapped_column(Text, default="")
    requested_by: Mapped[str] = mapped_column(String(120), default="jarvis")
    status: Mapped[str] = mapped_column(String(50), default="pending")  # pending | approved | rejected | expired
    decision_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    decided_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)


class Integration(TimestampMixin, Base):
    __tablename__ = "integrations"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(120), default="general")
    status: Mapped[str] = mapped_column(String(50), default="not_connected")
    auth_mode: Mapped[str] = mapped_column(String(120), default="environment_or_oauth")
    scopes: Mapped[list] = mapped_column(JSON, default=list)
    last_sync_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    notes: Mapped[str] = mapped_column(Text, default="")


class MetricSnapshot(TimestampMixin, Base):
    __tablename__ = "metric_snapshots"
    id: Mapped[int] = mapped_column(primary_key=True)
    company_id: Mapped[int | None] = mapped_column(ForeignKey("companies.id"), nullable=True)
    name: Mapped[str] = mapped_column(String(160), index=True)
    value: Mapped[float] = mapped_column(Float)
    unit: Mapped[str] = mapped_column(String(80), default="score")
    source: Mapped[str] = mapped_column(String(160), default="manual")


class PredictionRecord(TimestampMixin, Base):
    __tablename__ = "prediction_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    subject: Mapped[str] = mapped_column(String(250), index=True)
    prediction: Mapped[str] = mapped_column(Text)
    confidence: Mapped[float] = mapped_column(Float, default=0.65)
    horizon_days: Mapped[int] = mapped_column(Integer, default=30)
    expected_signal: Mapped[str] = mapped_column(Text, default="")
    actual_outcome: Mapped[str | None] = mapped_column(Text, nullable=True)
    accuracy_score: Mapped[float | None] = mapped_column(Float, nullable=True)
    status: Mapped[str] = mapped_column(String(50), default="open")


class RiskItem(TimestampMixin, Base):
    __tablename__ = "risk_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    category: Mapped[str] = mapped_column(String(120), default="operational")
    severity: Mapped[int] = mapped_column(Integer, default=3)
    likelihood: Mapped[int] = mapped_column(Integer, default=3)
    owner: Mapped[str] = mapped_column(String(160), default="CEO")
    mitigation: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(50), default="open")


class DebtItem(TimestampMixin, Base):
    __tablename__ = "debt_items"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    category: Mapped[str] = mapped_column(String(120), default="promise")
    owner: Mapped[str] = mapped_column(String(160), default="CEO")
    due_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    impact: Mapped[int] = mapped_column(Integer, default=3)
    status: Mapped[str] = mapped_column(String(50), default="open")


class OpportunitySignal(TimestampMixin, Base):
    __tablename__ = "opportunity_signals"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    source: Mapped[str] = mapped_column(String(160), default="jarvis")
    score: Mapped[float] = mapped_column(Float, default=50.0)
    window_days: Mapped[int] = mapped_column(Integer, default=30)
    rationale: Mapped[str] = mapped_column(Text, default="")
    first_step: Mapped[str] = mapped_column(Text, default="")
    status: Mapped[str] = mapped_column(String(50), default="open")


class SystemFlag(TimestampMixin, Base):
    __tablename__ = "system_flags"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    value: Mapped[str] = mapped_column(String(250), default="false")
    reason: Mapped[str] = mapped_column(Text, default="")

# v3.0 upgrade tables: mission-control workflows, tool readiness, notifications, and SOPs.
class WorkflowTemplate(TimestampMixin, Base):
    __tablename__ = "workflow_templates"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(160), unique=True, index=True)
    name: Mapped[str] = mapped_column(String(220), index=True)
    category: Mapped[str] = mapped_column(String(120), default="operations")
    trigger: Mapped[str] = mapped_column(String(220), default="manual")
    objective: Mapped[str] = mapped_column(Text, default="")
    steps: Mapped[list] = mapped_column(JSON, default=list)
    required_agents: Mapped[list] = mapped_column(JSON, default=list)
    approval_policy: Mapped[str] = mapped_column(String(120), default="high_impact_only")
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class WorkflowRun(TimestampMixin, Base):
    __tablename__ = "workflow_runs"
    id: Mapped[int] = mapped_column(primary_key=True)
    template_key: Mapped[str] = mapped_column(String(160), index=True)
    title: Mapped[str] = mapped_column(String(250), index=True)
    status: Mapped[str] = mapped_column(String(50), default="running")  # running | blocked | completed | cancelled
    owner: Mapped[str] = mapped_column(String(160), default="CEO")
    input_payload: Mapped[dict] = mapped_column(JSON, default=dict)
    current_step_index: Mapped[int] = mapped_column(Integer, default=0)
    outputs: Mapped[dict] = mapped_column(JSON, default=dict)
    risk_level: Mapped[str] = mapped_column(String(50), default="medium")


class WorkflowStep(TimestampMixin, Base):
    __tablename__ = "workflow_steps"
    id: Mapped[int] = mapped_column(primary_key=True)
    run_id: Mapped[int] = mapped_column(ForeignKey("workflow_runs.id"), index=True)
    step_index: Mapped[int] = mapped_column(Integer, default=0)
    title: Mapped[str] = mapped_column(String(250))
    owner_agent: Mapped[str] = mapped_column(String(160), default="JARVIS")
    status: Mapped[str] = mapped_column(String(50), default="pending")  # pending | running | blocked | completed
    instructions: Mapped[str] = mapped_column(Text, default="")
    output: Mapped[dict] = mapped_column(JSON, default=dict)
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=False)


class ToolCapability(TimestampMixin, Base):
    __tablename__ = "tool_capabilities"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(120), default="general")
    description: Mapped[str] = mapped_column(Text, default="")
    minimum_authority: Mapped[str] = mapped_column(String(80), default="assistant")
    approval_required: Mapped[bool] = mapped_column(Boolean, default=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    env_vars: Mapped[list] = mapped_column(JSON, default=list)
    health_status: Mapped[str] = mapped_column(String(50), default="unknown")


class NotificationEvent(TimestampMixin, Base):
    __tablename__ = "notification_events"
    id: Mapped[int] = mapped_column(primary_key=True)
    channel: Mapped[str] = mapped_column(String(120), default="dashboard")
    title: Mapped[str] = mapped_column(String(250), index=True)
    body: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[int] = mapped_column(Integer, default=3)
    status: Mapped[str] = mapped_column(String(50), default="queued")
    payload: Mapped[dict] = mapped_column(JSON, default=dict)


class SOPDocument(TimestampMixin, Base):
    __tablename__ = "sop_documents"
    id: Mapped[int] = mapped_column(primary_key=True)
    title: Mapped[str] = mapped_column(String(250), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(120), default="operations")
    body: Mapped[str] = mapped_column(Text, default="")
    owner: Mapped[str] = mapped_column(String(160), default="JARVIS")
    review_days: Mapped[int] = mapped_column(Integer, default=30)
    active: Mapped[bool] = mapped_column(Boolean, default=True)

# v4.0 upgrade tables: autonomy kernel, proactive watch rules, enchantment backlog, and system insights.
class AutonomyPolicy(TimestampMixin, Base):
    __tablename__ = "autonomy_policies"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(220), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(120), default="governance")
    trigger_terms: Mapped[list] = mapped_column(JSON, default=list)
    risk_level: Mapped[str] = mapped_column(String(50), default="medium")
    decision: Mapped[str] = mapped_column(String(80), default="approval_required")  # allow_autonomous | approval_required | deny
    requires_approval: Mapped[bool] = mapped_column(Boolean, default=True)
    rationale: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class WatchRule(TimestampMixin, Base):
    __tablename__ = "watch_rules"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str] = mapped_column(String(220), unique=True, index=True)
    category: Mapped[str] = mapped_column(String(120), default="operations")
    condition_key: Mapped[str] = mapped_column(String(160), index=True)
    threshold: Mapped[float] = mapped_column(Float, default=1.0)
    severity: Mapped[str] = mapped_column(String(50), default="warning")
    recommendation: Mapped[str] = mapped_column(Text, default="")
    active: Mapped[bool] = mapped_column(Boolean, default=True)


class EnchantmentFeature(TimestampMixin, Base):
    __tablename__ = "enchantment_features"
    id: Mapped[int] = mapped_column(primary_key=True)
    key: Mapped[str] = mapped_column(String(180), unique=True, index=True)
    title: Mapped[str] = mapped_column(String(260), index=True)
    category: Mapped[str] = mapped_column(String(120), index=True)
    description: Mapped[str] = mapped_column(Text, default="")
    benefit: Mapped[str] = mapped_column(Text, default="")
    priority: Mapped[int] = mapped_column(Integer, default=3)
    complexity: Mapped[int] = mapped_column(Integer, default=3)
    risk_level: Mapped[str] = mapped_column(String(50), default="medium")
    status: Mapped[str] = mapped_column(String(50), default="backlog")  # backlog | planned | building | shipped | rejected
    dependencies: Mapped[list] = mapped_column(JSON, default=list)
    implementation_notes: Mapped[str] = mapped_column(Text, default="")


class SystemInsight(TimestampMixin, Base):
    __tablename__ = "system_insights"
    id: Mapped[int] = mapped_column(primary_key=True)
    category: Mapped[str] = mapped_column(String(120), default="operations", index=True)
    title: Mapped[str] = mapped_column(String(260), index=True)
    severity: Mapped[str] = mapped_column(String(50), default="info")
    detail: Mapped[str] = mapped_column(Text, default="")
    recommendation: Mapped[str] = mapped_column(Text, default="")
    source: Mapped[str] = mapped_column(String(160), default="autonomy_kernel")
    status: Mapped[str] = mapped_column(String(50), default="open")

# v5.0 missing systems: 2026+ best practices, company ecosystem, workforce economy, and engineering catalog.
class V5Record(TimestampMixin, Base):
    __tablename__ = "v5_records"
    id: Mapped[int] = mapped_column(primary_key=True)
    kind: Mapped[str] = mapped_column(String(120), index=True)
    key: Mapped[str] = mapped_column(String(220), index=True)
    title: Mapped[str] = mapped_column(String(260), index=True)
    status: Mapped[str] = mapped_column(String(80), default="active")
    score: Mapped[float] = mapped_column(Float, default=0.0)
    payload: Mapped[dict] = mapped_column(JSON, default=dict)
    notes: Mapped[str] = mapped_column(Text, default="")


class FederationTrace(TimestampMixin, Base):
    __tablename__ = "federation_traces"
    id: Mapped[int] = mapped_column(primary_key=True)
    trace_id: Mapped[str] = mapped_column(String(120), unique=True, index=True)
    kind: Mapped[str] = mapped_column(String(80), index=True)
    source_systems: Mapped[list] = mapped_column(JSON, default=list)
    target_system: Mapped[str] = mapped_column(String(80), index=True)
    status: Mapped[str] = mapped_column(String(50), default="completed")
    request: Mapped[dict] = mapped_column(JSON, default=dict)
    result: Mapped[dict] = mapped_column(JSON, default=dict)
    blocked_reason: Mapped[str] = mapped_column(Text, default="")
    rollback_hint: Mapped[str] = mapped_column(Text, default="")
