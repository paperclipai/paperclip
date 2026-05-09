export type AutonomyJsonValue =
  | string
  | number
  | boolean
  | null
  | AutonomyJsonValue[]
  | { [key: string]: AutonomyJsonValue };

export type AutonomyRunKernelState =
  | "planned"
  | "preflight"
  | "preflight_failed"
  | "authorized"
  | "queued"
  | "running"
  | "evidence_extraction"
  | "evidence_validation"
  | "issue_update"
  | "continuation_decision"
  | "terminal";

export type AutonomyTerminalClassification =
  | "succeeded_with_evidence"
  | "blocked_with_owner"
  | "approval_required_visible"
  | "failed_preflight"
  | "failed_auth"
  | "failed_agent_runtime"
  | "failed_no_evidence"
  | "failed_invalid_evidence"
  | "failed_policy_violation"
  | "failed_budget"
  | "failed_controller_invariant"
  | "failed_validator_error"
  | "cancelled_by_policy"
  | "cancelled_by_user"
  | "timed_out";

export type AutonomyEvidenceType =
  | "commit"
  | "diff"
  | "test_run"
  | "build"
  | "deployment"
  | "published_asset"
  | "document"
  | "screenshot"
  | "external_api_check"
  | "app_store_state"
  | "human_device_result"
  | "blocked_dependency"
  | "approval_request"
  | "approval_decision"
  | "issue_transition"
  | "run_log"
  | "work_product"
  | "validator_result";

export type AutonomyEvidenceStatus = "pending" | "validating" | "accepted" | "rejected" | "superseded";

export type AutonomyEvidenceVerdict = "pending" | "accepted" | "rejected" | "validator_error";

export type AutonomyIncidentType =
  | "AUTH_STALE_AGENT_CODEX"
  | "AGENT_API_UNAUTHORIZED"
  | "WORKSPACE_MISSING"
  | "HIDDEN_APPROVAL_BLOCKER"
  | "RUN_SUCCEEDED_WITHOUT_EVIDENCE"
  | "RUN_FAILED_NO_EVIDENCE"
  | "META_WORK_ATTEMPTED"
  | "AGENT_CREATED_UNAUTHORIZED_ISSUE"
  | "VALIDATOR_FAILED"
  | "LANE_BUDGET_EXCEEDED"
  | "CONTROLLER_INVARIANT_BROKEN"
  | "DEPENDENCY_GRAPH_INVALID"
  | "APPROVAL_EXPIRED"
  | "ISSUE_CONTRACT_MISSING"
  | "LANE_STOPPED";

export type AutonomyIncidentSeverity = "info" | "warning" | "error" | "critical";

export type AutonomyIncidentStatus = "open" | "acknowledged" | "resolved" | "suppressed";

export type AutonomyLaneStatus =
  | "healthy"
  | "running"
  | "blocked"
  | "approval_required"
  | "degraded"
  | "stopped";

export type AutonomyApprovalGateStatus =
  | "pending"
  | "approved"
  | "rejected"
  | "expired"
  | "cancelled"
  | "failed_invariant";

export type AutonomyActorType = "user" | "agent" | "system" | "kernel";

export type AutonomySourceType =
  | "heartbeat_run"
  | "heartbeat_run_event"
  | "issue"
  | "approval"
  | "issue_approval"
  | "budget"
  | "routine"
  | "productivity_review"
  | "recovery_watchdog"
  | "kernel"
  | "external";

export interface AutonomyIncident {
  id: string;
  companyId: string;
  type: AutonomyIncidentType;
  severity: AutonomyIncidentSeverity;
  status: AutonomyIncidentStatus;
  laneKey: string | null;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  sourceType: AutonomySourceType;
  sourceId: string | null;
  title: string;
  message: string;
  remediation: string | null;
  stopsLane: boolean;
  metadata: Record<string, AutonomyJsonValue> | null;
  acknowledgedByUserId: string | null;
  acknowledgedAt: string | null;
  resolvedByUserId: string | null;
  resolvedAt: string | null;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomyEvidenceEntry {
  id: string;
  companyId: string;
  type: AutonomyEvidenceType;
  status: AutonomyEvidenceStatus;
  verdict: AutonomyEvidenceVerdict;
  laneKey: string | null;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  sourceType: AutonomySourceType;
  sourceId: string | null;
  title: string;
  summary: string | null;
  uri: string | null;
  payload: Record<string, AutonomyJsonValue> | null;
  validatorName: string | null;
  validatorVersion: string | null;
  validatorMessage: string | null;
  validatedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomyRunTransition {
  id: string;
  companyId: string;
  runId: string;
  issueId: string | null;
  agentId: string | null;
  laneKey: string | null;
  fromState: AutonomyRunKernelState | null;
  toState: AutonomyRunKernelState;
  terminalClassification: AutonomyTerminalClassification | null;
  reason: string | null;
  actorType: AutonomyActorType;
  actorId: string | null;
  evidenceEntryIds: string[];
  incidentIds: string[];
  metadata: Record<string, AutonomyJsonValue> | null;
  transitionedAt: string;
  createdAt: string;
}

export interface ApprovalGateSummary {
  id: string;
  companyId: string;
  status: AutonomyApprovalGateStatus;
  approvalId: string | null;
  laneKey: string | null;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  governedAction: string;
  risk: string | null;
  policySource: string | null;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  acceptActionLabel: string | null;
  rejectActionLabel: string | null;
  expiresAt: string | null;
  decidedByUserId: string | null;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface CompanyLaneStatus {
  companyId: string;
  laneKey: string;
  laneName: string;
  status: AutonomyLaneStatus;
  statusReason: string | null;
  activeRunId: string | null;
  activeIssueId: string | null;
  activeAgentId: string | null;
  queuedRunCount: number;
  openIncidentCount: number;
  criticalIncidentCount: number;
  pendingApprovalCount: number;
  lastTransition: AutonomyRunTransition | null;
  stoppedByIncidentId: string | null;
  updatedAt: string;
}

export interface AgentContractSummary {
  id: string;
  companyId: string;
  agentId: string;
  laneKey: string | null;
  name: string;
  version: number;
  status: "draft" | "active" | "retired";
  allowedIssueTypes: string[];
  requiredEvidenceTypes: AutonomyEvidenceType[];
  allowedEvidenceTypes: AutonomyEvidenceType[];
  requiresApprovalFor: string[];
  maxRunDurationSeconds: number | null;
  activatedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AutonomyInboxItem {
  id: string;
  companyId: string;
  kind: "incident" | "approval_gate" | "evidence_validation" | "lane_block";
  severity: AutonomyIncidentSeverity;
  status: AutonomyIncidentStatus | AutonomyApprovalGateStatus | AutonomyEvidenceStatus | AutonomyLaneStatus;
  title: string;
  summary: string | null;
  laneKey: string | null;
  runId: string | null;
  issueId: string | null;
  agentId: string | null;
  incident: AutonomyIncident | null;
  approvalGate: ApprovalGateSummary | null;
  evidenceEntry: AutonomyEvidenceEntry | null;
  createdAt: string;
  updatedAt: string;
}
