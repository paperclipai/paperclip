// Rt2-specific Approval Types (distinct from Paperclip's built-in approval types)
export type Rt2ApprovalType =
  | "hire_agent"
  | "approve_strategy"
  | "task_completion"
  | "deployment"
  | "budget_exceed"
  | "jarvis_auto_action"
  | "jarvis_skill_capability";

export type Rt2ApprovalStatus = "pending" | "approved" | "rejected";

// Core entities
export interface Rt2Approval {
  id: string;
  companyId: string;
  type: Rt2ApprovalType;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  status: Rt2ApprovalStatus;
  payload: Record<string, unknown>;
  decisionNote: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface Rt2ApprovalWithComments extends Rt2Approval {
  comments: Rt2ApprovalComment[];
}

// Comments
export interface Rt2ApprovalComment {
  id: string;
  companyId: string;
  approvalId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

// Governance Status
export interface Rt2GovernanceStatus {
  companyId: string;
  pendingApprovals: number;
  approvedThisWeek: number;
  rejectedThisWeek: number;
  averageApprovalTimeHours: number;
}

// Activity Log
export type ActorType = "user" | "agent" | "system";

export interface Rt2ActivityLogEntry {
  id: string;
  companyId: string;
  actorType: ActorType;
  actorId: string;
  action: string;
  entityType: string;
  entityId: string;
  agentId: string | null;
  runId: string | null;
  details: Record<string, unknown> | null;
  createdAt: Date;
}

// Request types
export interface CreateApprovalRequest {
  type: Rt2ApprovalType;
  payload: Record<string, unknown>;
  requestedByAgentId?: string;
  requestedByUserId?: string;
}

export interface DecisionRequest {
  decisionNote?: string;
}

export interface AddCommentRequest {
  body: string;
  authorAgentId?: string;
  authorUserId?: string;
}

// Filter types
export interface ActivityLogFilter {
  entityType?: string;
  action?: string;
  actorType?: ActorType;
  fromDate?: Date;
  toDate?: Date;
  limit?: number;
}

export interface ApprovalQueueFilter {
  type?: Rt2ApprovalType;
  status?: Rt2ApprovalStatus;
}

export type Rt2JarvisEvaluationMode = "shadow" | "copilot" | "auto";
export type Rt2JarvisPolicyDecision = "record_only" | "requires_copilot" | "auto_approved";

export interface Rt2JarvisQualityReviewItem {
  evaluationId: string;
  companyId: string;
  taskIssueId: string;
  taskTitle: string;
  deliverableId: string | null;
  deliverableTitle: string | null;
  deliverableType: string;
  evaluator: string;
  evaluationMode: Rt2JarvisEvaluationMode;
  score: number;
  direction: "positive" | "negative";
  category: string;
  rationale: string | null;
  managerDecision: "approved" | "rejected" | "pending" | null;
  managerFeedback: string | null;
  isActive: number;
  isFinalized: number;
  basePrice: number | null;
  expectedDeltaGold: number | null;
  autoApprovalBandLow: number | null;
  autoApprovalBandHigh: number | null;
  policyDecision: Rt2JarvisPolicyDecision;
  policyReason: string;
  evidence: {
    taskStatus: string;
    deliverableStatus: string | null;
    deliverableReviewState: string | null;
    createdAt: Date;
    updatedAt: Date;
  };
}

export interface Rt2JarvisQualityReviewQueue {
  companyId: string;
  items: Rt2JarvisQualityReviewItem[];
  stats: {
    shadow: number;
    copilotPending: number;
    autoApproved: number;
    rejected: number;
  };
}

export interface Rt2JarvisQualityDecision {
  evaluationId: string;
  managerId: string;
  feedback?: string;
}

export interface Rt2JarvisAutoPolicyDecision {
  mode: Rt2JarvisEvaluationMode;
  decision: Rt2JarvisPolicyDecision;
  reason: string;
  expectedDeltaGold: number;
  basePrice: number;
  bandLow: number;
  bandHigh: number;
  threshold: number;
  thresholdSource: "custom" | "default";
  approvalRequired: boolean;
}

export type Rt2JarvisRewriteProposalStatus = "proposed" | "approval_requested" | "approved" | "applied" | "rejected" | "blocked";
export type Rt2JarvisRewriteRiskLevel = "low" | "medium" | "high";
export type Rt2JarvisRewriteEvalProviderStatus = "not_run" | "completed" | "unavailable" | "error";
export type Rt2JarvisRewriteEvalFallbackStatus = "completed" | "error";
export type Rt2JarvisRewriteEvalRecommendation = "approve" | "revise" | "reject" | "block";

export interface Rt2JarvisRewriteDiff {
  before: string;
  after: string;
  summary: string;
}

export interface Rt2JarvisRewriteCitationEvidence {
  id: string;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  freshness: "fresh" | "stale" | "unknown";
  contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
  score?: number;
}

export interface Rt2JarvisRewriteEvalDimension {
  key: "citation_coverage" | "freshness" | "contradiction_safety" | "diff_scope" | "evidence_density";
  score: number;
  rationale: string;
}

export interface Rt2JarvisRewriteEvalRubric {
  rubricVersion: string;
  dimensions: Rt2JarvisRewriteEvalDimension[];
  overallScore: number;
  confidence: number;
  recommendation: Rt2JarvisRewriteEvalRecommendation;
  rationale: string;
}

export interface Rt2JarvisRewriteEvalComparison {
  providerStatus: Rt2JarvisRewriteEvalProviderStatus;
  fallbackStatus: Rt2JarvisRewriteEvalFallbackStatus;
  disagreement: boolean;
  lowConfidence: boolean;
  finalRecommendation: Rt2JarvisRewriteEvalRecommendation;
  finalConfidence: number;
  reasonCodes: string[];
}

export interface Rt2JarvisRewriteProposalInput {
  targetType: "wiki_page" | "daily_wiki_page" | "graph_node" | "graph_edge" | "work_artifact" | "document";
  targetId: string;
  targetKey: string;
  projectId?: string | null;
  title: string;
  before: string;
  after: string;
  rationale?: string;
  citations?: Rt2JarvisRewriteCitationEvidence[];
  contradictionIds?: string[];
  providerEval?: Partial<Rt2JarvisRewriteEvalRubric> & {
    status?: Exclude<Rt2JarvisRewriteEvalProviderStatus, "not_run">;
    errorMessage?: string;
  };
}

export interface Rt2JarvisRewriteProposal {
  id: string;
  companyId: string;
  projectId: string | null;
  targetType: Rt2JarvisRewriteProposalInput["targetType"];
  targetId: string;
  targetKey: string;
  title: string;
  status: Rt2JarvisRewriteProposalStatus;
  riskLevel: Rt2JarvisRewriteRiskLevel;
  proposedDiff: Rt2JarvisRewriteDiff;
  rationale: string | null;
  citations: Rt2JarvisRewriteCitationEvidence[];
  contradictionIds: string[];
  approvalId: string | null;
  approvalRoute: string | null;
  latestEval: Rt2JarvisRewriteEvalComparison | null;
  createdBy: string;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface Rt2JarvisRewriteEvalRecord {
  id: string;
  proposalId: string;
  companyId: string;
  providerStatus: Rt2JarvisRewriteEvalProviderStatus;
  fallbackStatus: Rt2JarvisRewriteEvalFallbackStatus;
  providerRubric: Rt2JarvisRewriteEvalRubric | null;
  fallbackRubric: Rt2JarvisRewriteEvalRubric;
  comparison: Rt2JarvisRewriteEvalComparison;
  createdAt: Date | string;
}

export interface Rt2JarvisRewriteProposalList {
  companyId: string;
  proposals: Rt2JarvisRewriteProposal[];
  stats: {
    total: number;
    proposed: number;
    approvalRequested: number;
    approved: number;
    applied: number;
    rejected: number;
    blocked: number;
    highRisk: number;
    providerUnavailable: number;
    disagreement: number;
    lowConfidence: number;
  };
}

export interface Rt2JarvisReverseDesignedTask {
  title: string;
  description: string;
  suggestedTodos: string[];
  deliverableType: string;
  evidence: string[];
  rationale: string;
  confidence: number;
}

export interface Rt2JarvisReverseDesignProposal {
  companyId: string;
  expectedDeliverable: {
    title: string;
    type: string;
    description: string | null;
  };
  runId: string;
  tasks: Rt2JarvisReverseDesignedTask[];
  rationale: string;
}

export interface Rt2JarvisSkillCapability {
  injectionId: string;
  companyId: string;
  agentId: string;
  skillId: string | null;
  skillKey: string;
  injectionType: string;
  status: string;
  approvalId: string | null;
  approvalStatus: Rt2ApprovalStatus | null;
  effectivenessScore: number;
  usageCount: number;
  lastUsedAt: Date | null;
  activatedAt: Date | null;
  expiresAt: Date | null;
  policy: {
    governed: boolean;
    reason: string;
  };
}

export interface Rt2JarvisGroundedCitation {
  id: string;
  label: string;
  sourceType: string;
  sourceId: string;
  sourceKey: string;
  projectId: string | null;
  snippet: string;
  confidence: string;
  freshness: "fresh" | "stale" | "unknown";
  contradictionStatus: "none" | "unknown" | "unresolved" | "resolved";
  score: number;
  target: {
    kind: "task" | "work_object" | "wiki_page" | "daily_wiki_page" | "graph_node" | "graph_edge" | "contradiction_item" | "document";
    path: string;
    params: Record<string, string>;
  };
}

export interface Rt2JarvisGroundingWarning {
  type: "stale_evidence" | "unresolved_contradiction";
  severity: "warning" | "blocker";
  message: string;
  citationId: string;
}

export interface Rt2JarvisTaskAdvice {
  taskIssueId: string;
  companyId: string;
  projectId: string;
  evidence: {
    taskTitle: string;
    todoCount: number;
    openTodoCount: number;
    deliverableCount: number;
    submittedDeliverableCount: number;
    activeParticipantCount: number;
    wikiPageKeys: string[];
    graphNodeKeys: string[];
  };
  grounding: {
    query: string;
    citations: Rt2JarvisGroundedCitation[];
    warnings: Rt2JarvisGroundingWarning[];
    retrieval: {
      searchType: "hybrid-semantic";
      resultCount: number;
      projectScoped: boolean;
    };
  };
  suggestions: string[];
  insights: string[];
  nextSteps: Array<{
    todoIssueId: string;
    title: string;
    status: string;
    assigneeUserId: string | null;
  }>;
}
