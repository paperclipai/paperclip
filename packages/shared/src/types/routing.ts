export const ROUTING_POLICY_VERSION = "routing-policy/v1";

export const PROVIDER_FAMILIES = ["anthropic", "openai", "meta", "deepseek"] as const;
export type ProviderFamily = (typeof PROVIDER_FAMILIES)[number];

export const ATTEMPT_ROLES = ["worker", "advisor", "reviewer", "rescuer"] as const;
export type AttemptRole = (typeof ATTEMPT_ROLES)[number];

export const TASK_CLASSES = [
  "feature_standard",
  "feature_critical",
  "migration",
  "bug_fast",
  "bug_invariant",
  "security_recovery",
  "mechanical",
] as const;
export type TaskClass = (typeof TASK_CLASSES)[number];

export const ROUTE_REASONS = [
  "cross-layer",
  "persistent-schema",
  "security-sensitive",
  "recovery-invariant",
  "concurrency-invariant",
  "known-reproduction",
  "mechanical-cutover",
  "review-rejected",
  "repeated-failure",
  "provider-unavailable",
  "budget-limited",
] as const;
export type RouteReason = (typeof ROUTE_REASONS)[number];

export const TASK_RISK_FLAGS = [
  "auth",
  "persistence",
  "recovery",
  "concurrency",
  "destructive-mutation",
  "repository-identity",
  "multiple-authority-seams",
] as const;
export type TaskRiskFlag = (typeof TASK_RISK_FLAGS)[number];

export const TASK_AFFECTED_LAYERS = [
  "db",
  "shared",
  "server",
  "runtime",
  "ui",
  "external-integration",
] as const;
export type TaskAffectedLayer = (typeof TASK_AFFECTED_LAYERS)[number];

export interface TaskFacts {
  taskClass: TaskClass;
  riskFlags: TaskRiskFlag[];
  affectedLayers: TaskAffectedLayer[];
  reproductionKnown: boolean;
  acceptanceDefined: boolean;
  /** True when the task still has an unresolved architectural decision; cheap pools are refused. */
  architecturalDecisionOpen: boolean;
  /** True when the change has user-observable or durable consequences; drives "consequential" review. */
  consequential: boolean;
}

/**
 * Reviewer families that may review a worker of the given family. Anthropic and
 * OpenAI must cross each other; mechanical (meta/deepseek) workers are reviewed by
 * one of the two authority families. No family may review itself.
 */
export const REVIEWER_FAMILIES_FOR_WORKER: Record<ProviderFamily, readonly ProviderFamily[]> = {
  anthropic: ["openai"],
  openai: ["anthropic"],
  meta: ["anthropic", "openai"],
  deepseek: ["anthropic", "openai"],
};

/** Task classes whose review requirement cannot be waived by a route rule. */
export const REVIEW_MANDATORY_TASK_CLASSES: Record<TaskClass, boolean> = {
  feature_standard: true,
  feature_critical: true,
  migration: true,
  bug_fast: false,
  bug_invariant: true,
  security_recovery: true,
  mechanical: false,
};

/** Task classes that must fail closed (no reviewer fallback across a same-family path, no waiver). */
export const FAIL_CLOSED_TASK_CLASSES: Record<TaskClass, boolean> = {
  feature_standard: false,
  feature_critical: true,
  migration: true,
  bug_fast: false,
  bug_invariant: false,
  security_recovery: true,
  mechanical: false,
};

/**
 * Explicit route states. `routed` is the only state that selects a worker; every
 * other state is a typed refusal that the operator surface must show verbatim.
 */
export const ROUTE_DECISION_STATES = [
  "routed",
  "classification-required",
  "no-capable-worker",
  "reviewer-family-conflict",
  "reviewer-unavailable",
  "budget-limited",
  "escalation-required",
] as const;
export type RouteDecisionState = (typeof ROUTE_DECISION_STATES)[number];

export const ROUTE_REVISION_KINDS = ["initial", "escalation", "fallback", "override", "rescue"] as const;
export type RouteRevisionKind = (typeof ROUTE_REVISION_KINDS)[number];

export const ROUTE_ESCALATION_REASONS = [
  "repeated-failure-fingerprint",
  "architectural-review-rejection",
  "dirty-terminal-attempt",
  "verification-failing-at-terminal-attempt",
  "scope-crossed-critical-risk",
  "no-artifact-within-wall-clock",
  "no-durable-action-path",
  "repeated-correction-against-rejected-invariant",
] as const;
export type RouteEscalationReason = (typeof ROUTE_ESCALATION_REASONS)[number];

export const ROUTE_ADVISOR_MODES = ["none", "optional", "required"] as const;
export type RouteAdvisorMode = (typeof ROUTE_ADVISOR_MODES)[number];

export const ROUTE_REVIEW_REQUIREMENTS = ["always", "consequential", "none"] as const;
export type RouteReviewRequirement = (typeof ROUTE_REVIEW_REQUIREMENTS)[number];

export const ROUTE_REVIEWER_FALLBACK_POLICIES = ["fallback", "fail_closed"] as const;
export type RouteReviewerFallbackPolicy = (typeof ROUTE_REVIEWER_FALLBACK_POLICIES)[number];

export interface ExecutionProfile {
  id: string;
  companyId: string;
  name: string;
  providerFamily: ProviderFamily;
  agentId: string;
  model: string;
  effort: string;
  roleCapabilities: AttemptRole[];
  enabled: boolean;
  maxConcurrentAttempts: number;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RouteRule {
  id: string;
  companyId: string;
  taskClass: TaskClass;
  workerProfileId: string | null;
  advisorProfileId: string | null;
  advisorMode: RouteAdvisorMode;
  reviewerProfileId: string | null;
  reviewerFallbackProfileId: string | null;
  reviewRequirement: RouteReviewRequirement;
  reviewerFallbackPolicy: RouteReviewerFallbackPolicy;
  rescueProfileId: string | null;
  maxAttempts: number;
  maxWallClockMinutes: number;
  maxCostCents: number | null;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface RouteDecisionParticipant {
  profileId: string;
  agentId: string;
  providerFamily: ProviderFamily;
  model: string;
  effort: string;
}

export interface RouteDecision {
  id: string;
  companyId: string;
  issueId: string;
  revision: number;
  supersedesDecisionId: string | null;
  revisionKind: RouteRevisionKind;
  policyVersion: string;
  taskClass: TaskClass;
  /** Task class after deterministic promotion (may differ from `facts.taskClass`). */
  effectiveTaskClass: TaskClass;
  facts: TaskFacts | null;
  state: RouteDecisionState;
  worker: RouteDecisionParticipant | null;
  advisor: RouteDecisionParticipant | null;
  advisorMode: RouteAdvisorMode;
  reviewer: RouteDecisionParticipant | null;
  reviewerFallback: RouteDecisionParticipant | null;
  rescue: RouteDecisionParticipant | null;
  requireCrossFamilyReview: boolean;
  maxAttempts: number;
  maxWallClockMinutes: number;
  maxCostCents: number | null;
  reasonCodes: RouteReason[];
  escalationReason: RouteEscalationReason | null;
  note: string | null;
  createdByType: "user" | "agent" | "system";
  createdByUserId: string | null;
  createdByAgentId: string | null;
  createdAt: Date;
}

export interface RoutePoolClaim {
  id: string;
  companyId: string;
  profileId: string;
  decisionId: string;
  issueId: string;
  role: AttemptRole;
  runId: string | null;
  claimedAt: Date;
  releasedAt: Date | null;
  releaseReason: string | null;
}

export interface IssueRouting {
  issueId: string;
  current: RouteDecision | null;
  history: RouteDecision[];
  activeClaims: RoutePoolClaim[];
  reviewIssueId: string | null;
  /** Number of completed advisor rounds recorded against the current decision. */
  advisorRoundsUsed: number;
}

export interface RouteRuleDefaultsResult {
  rules: RouteRule[];
  unresolvedTaskClasses: TaskClass[];
}
