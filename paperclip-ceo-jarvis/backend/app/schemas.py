from datetime import datetime
from typing import Any, Literal
from pydantic import BaseModel, Field


class ChatRequest(BaseModel):
    message: str
    context: dict[str, Any] = Field(default_factory=dict)
    personality_level: int | None = None


class ChatResponse(BaseModel):
    reply: str
    mode: str
    suggested_actions: list[str] = Field(default_factory=list)


class CompanyCreate(BaseModel):
    name: str
    mission: str = "Build useful AI systems with disciplined execution."
    strategy: str = "Ship practical products, protect users, compound knowledge."


class CompanyOut(CompanyCreate):
    id: int
    health_score: float
    created_at: datetime
    class Config:
        from_attributes = True


class EmployeeCreate(BaseModel):
    company_id: int = 1
    name: str
    role: str = "Contributor"
    kind: Literal["human", "agent"] = "human"
    skills: dict[str, Any] = Field(default_factory=dict)


class EmployeeOut(BaseModel):
    id: int
    company_id: int
    name: str
    role: str
    kind: str
    skills: dict[str, Any]
    workload_score: float
    impact_score: float
    reliability_score: float
    innovation_score: float
    collaboration_score: float
    active: bool
    class Config:
        from_attributes = True


class ReputationEventIn(BaseModel):
    category: Literal["quality", "reliability", "innovation", "collaboration", "delivery"]
    score_delta: float = Field(ge=-50, le=50)
    note: str = ""


class DecisionSimulationRequest(BaseModel):
    title: str
    decision: str
    horizon_days: int = Field(default=60, ge=1, le=365)
    assumptions: list[str] = Field(default_factory=list)
    constraints: list[str] = Field(default_factory=list)


class DecisionSimulationResponse(BaseModel):
    title: str
    recommendation: str
    confidence: float
    forecast: dict[str, Any]
    risks: list[str]
    mitigations: list[str]
    next_actions: list[str]


class TaskCreate(BaseModel):
    title: str
    description: str = ""
    owner_employee_id: int | None = None
    priority: int = Field(default=3, ge=1, le=5)
    due_at: datetime | None = None
    risk_level: Literal["low", "medium", "high"] = "low"


class TaskOut(TaskCreate):
    id: int
    status: str
    created_at: datetime
    class Config:
        from_attributes = True


class BriefingOut(BaseModel):
    generated_at: datetime
    greeting: str
    top_items: list[dict[str, Any]]
    workload: dict[str, Any]
    recommendations: list[str]


class ExecutiveMessageRequest(BaseModel):
    audience: str
    objective: str
    facts: list[str] = Field(default_factory=list)
    tone: str = "calm, decisive, executive"


class MeetingOptimizeRequest(BaseModel):
    topic: str
    participants: list[str] = Field(default_factory=list)
    desired_outcome: str


class BoardPackResponse(BaseModel):
    generated_at: datetime
    summary: str
    company_health: list[dict[str, Any]]
    risks: list[str]
    decisions_needed: list[str]
    recommendations: list[str]


class ReasoningRequest(BaseModel):
    question: str
    context: dict[str, Any] = Field(default_factory=dict)
    horizon_days: int = Field(default=60, ge=1, le=365)


class KnowledgeIn(BaseModel):
    title: str
    content: str
    source: str = "manual"
    tags: list[str] = Field(default_factory=list)
    importance: int = Field(default=3, ge=1, le=5)


class KnowledgeSearchRequest(BaseModel):
    query: str
    limit: int = Field(default=5, ge=1, le=25)


class SwarmRunRequest(BaseModel):
    task: str
    mode: Literal["parallel", "serial", "consensus", "red_team"] = "parallel"
    agents: list[str] = Field(default_factory=list)
    require_approval_for_execution: bool = True


class ApprovalCreate(BaseModel):
    title: str
    action: str
    risk_level: Literal["low", "medium", "high", "critical"] = "medium"
    rationale: str = ""


class ApprovalDecision(BaseModel):
    note: str = ""


class ContentRequest(BaseModel):
    kind: Literal["press_release", "pitch_deck", "blog_post", "team_update", "investor_update"]
    topic: str
    audience: str = "stakeholders"
    facts: list[str] = Field(default_factory=list)
    tone: str = "executive, direct, credible"


class RiskCreate(BaseModel):
    title: str
    category: str = "operational"
    severity: int = Field(default=3, ge=1, le=5)
    likelihood: int = Field(default=3, ge=1, le=5)
    owner: str = "CEO"
    mitigation: str = ""


class DebtCreate(BaseModel):
    title: str
    category: Literal["promise", "technical", "operational", "relationship"] = "promise"
    owner: str = "CEO"
    due_at: datetime | None = None
    impact: int = Field(default=3, ge=1, le=5)


class PredictionCreate(BaseModel):
    subject: str
    prediction: str
    confidence: float = Field(default=0.65, ge=0.0, le=1.0)
    horizon_days: int = Field(default=30, ge=1, le=365)
    expected_signal: str = ""


class PredictionResolve(BaseModel):
    actual_outcome: str
    accuracy_score: float = Field(ge=0.0, le=1.0)


class IntegrationUpdate(BaseModel):
    status: Literal["not_connected", "planned", "connected", "degraded", "disabled"]
    notes: str = ""

class CommandRequest(BaseModel):
    command: str
    context: dict[str, Any] = Field(default_factory=dict)
    autonomous: bool = False


class WorkflowStartRequest(BaseModel):
    template_key: str
    title: str | None = None
    owner: str = "CEO"
    input_payload: dict[str, Any] = Field(default_factory=dict)


class WorkflowAdvanceRequest(BaseModel):
    output: dict[str, Any] = Field(default_factory=dict)
    status: Literal["completed", "blocked", "running"] = "completed"


class SOPCreate(BaseModel):
    title: str
    category: str = "operations"
    body: str
    owner: str = "JARVIS"
    review_days: int = Field(default=30, ge=1, le=365)


class NotificationCreate(BaseModel):
    channel: str = "dashboard"
    title: str
    body: str = ""
    priority: int = Field(default=3, ge=1, le=5)
    payload: dict[str, Any] = Field(default_factory=dict)


class ToolCapabilityUpdate(BaseModel):
    enabled: bool | None = None
    health_status: Literal["unknown", "ready", "degraded", "missing_config", "disabled"] | None = None

class AutonomyEvaluateRequest(BaseModel):
    action: str
    context: dict[str, Any] = Field(default_factory=dict)
    intended_actor: str = "jarvis"
    impact_area: str = "operations"


class AutonomyPolicyIn(BaseModel):
    name: str
    category: str = "governance"
    trigger_terms: list[str] = Field(default_factory=list)
    risk_level: Literal["low", "medium", "high", "critical"] = "medium"
    decision: Literal["allow_autonomous", "approval_required", "deny"] = "approval_required"
    requires_approval: bool = True
    rationale: str = ""
    active: bool = True


class WatchRuleIn(BaseModel):
    name: str
    category: str = "operations"
    condition_key: str
    threshold: float = 1.0
    severity: Literal["info", "warning", "high", "critical"] = "warning"
    recommendation: str = ""
    active: bool = True


class FeatureStatusUpdate(BaseModel):
    status: Literal["backlog", "planned", "building", "shipped", "rejected"]
    note: str = ""


class FeaturePlanRequest(BaseModel):
    focus_categories: list[str] = Field(default_factory=list)
    horizon_days: int = Field(default=60, ge=7, le=365)
    capacity_level: Literal["low", "normal", "aggressive"] = "normal"
    include_high_risk: bool = False


class FederationBriefingRequest(BaseModel):
    focus: str = "CEO briefing"
    include_sources: list[Literal["paperclip", "hermes", "pi", "opencode"]] = Field(default_factory=lambda: ["paperclip", "hermes", "pi", "opencode"])


class FederationRouteRequest(BaseModel):
    task: str
    preferred_system: Literal["paperclip", "hermes", "pi", "opencode", "auto"] = "auto"
    allow_execution: bool = True
    context: dict[str, Any] = Field(default_factory=dict)


class FederationExecuteRequest(BaseModel):
    task: str
    target_system: Literal["paperclip", "hermes", "pi", "opencode", "auto"] = "auto"
    approved: bool = True
    context: dict[str, Any] = Field(default_factory=dict)
    issue_id: str | None = Field(default=None, alias="issueId")
    title: str | None = None
    description: str | None = None
    status: str | None = None
    priority: str | int | None = None
    assignee_agent_id: str | None = Field(default=None, alias="assigneeAgentId")
    parent_id: str | None = Field(default=None, alias="parentId")
    project_id: str | None = Field(default=None, alias="projectId")
    goal_id: str | None = Field(default=None, alias="goalId")
    billing_code: str | None = Field(default=None, alias="billingCode")
    comment: str | None = None


class FederationTraceQuery(BaseModel):
    limit: int = Field(default=25, ge=1, le=200)
