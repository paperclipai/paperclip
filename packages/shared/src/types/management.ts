import type {
  AgentRole,
  AgentStatus,
  ApprovalStatus,
  CompanyStatus,
  HeartbeatRunStatus,
  IssuePriority,
  IssueRecoveryActionKind,
  IssueRecoveryActionStatus,
  IssueStatus,
  PauseReason,
  ProjectStatus,
  RunLivenessState,
} from "../constants.js";

export interface ManagementCompanyHealthSummary {
  activeRunCount: number;
  attentionRunCount: number;
  blockedIssueCount: number;
  recoveryActionCount: number;
  pendingApprovalCount: number;
  pausedAgentCount: number;
  lastRunStartedAt: Date | null;
}

export interface ManagementCompanySummary {
  id: string;
  name: string;
  description: string | null;
  status: CompanyStatus;
  pauseReason: PauseReason | null;
  pausedAt: Date | null;
  issuePrefix: string;
  agentCount: number;
  activeAgentCount: number;
  pausedAgentCount: number;
  projectCount: number;
  activeProjectCount: number;
  openIssueCount: number;
  blockedIssueCount: number;
  pendingApprovalCount: number;
  activeRunCount: number;
  attentionRunCount: number;
  recoveryActionCount: number;
  lastRunStartedAt: Date | null;
  updatedAt: Date;
}

export interface ManagementAgentSummary {
  id: string;
  companyId: string;
  name: string;
  role: AgentRole;
  title: string | null;
  status: AgentStatus;
  reportsTo: string | null;
  lastHeartbeatAt: Date | null;
  updatedAt: Date;
}

export interface ManagementProjectSummary {
  id: string;
  companyId: string;
  goalId: string | null;
  name: string;
  description: string | null;
  status: ProjectStatus;
  leadAgentId: string | null;
  targetDate: string | null;
  openIssueCount: number;
  blockedIssueCount: number;
  updatedAt: Date;
}

export interface ManagementApprovalSummary {
  id: string;
  companyId: string;
  type: string;
  status: ApprovalStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  decidedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  payloadSummary: Record<string, unknown> | null;
}

export interface ManagementIssueBlockerSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
}

export interface ManagementIssueRecoverySummary {
  id: string;
  kind: IssueRecoveryActionKind;
  status: IssueRecoveryActionStatus;
  nextAction: string;
  ownerAgentId: string | null;
  timeoutAt: Date | null;
  updatedAt: Date;
}

export interface ManagementIssueSummary {
  id: string;
  identifier: string | null;
  companyId: string;
  projectId: string | null;
  projectName: string | null;
  parentId: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  executionRunId: string | null;
  monitorNextCheckAt: Date | null;
  blockedByCount: number;
  unresolvedBlockerCount: number;
  blockedBy: ManagementIssueBlockerSummary[];
  activeRecoveryAction: ManagementIssueRecoverySummary | null;
  updatedAt: Date;
}

export interface ManagementRunSummary {
  id: string;
  companyId: string;
  agentId: string;
  agentName: string | null;
  status: HeartbeatRunStatus;
  livenessState: RunLivenessState | null;
  invocationSource: string;
  triggerDetail: string | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  lastOutputAt: Date | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  errorCode: string | null;
  resultSummary: Record<string, unknown> | null;
}

export interface ManagementAnalyzerWindow {
  since: Date;
  until: Date;
  hours: number;
}

export interface ManagementAnalyzerAccessSummary {
  mode: "same_company" | "cross_company_grant";
  excerptPolicy: "full" | "redacted";
  grantId: string | null;
}

export interface ManagementAnalyzerMetricSummary {
  openIssueCount: number;
  blockedIssueCount: number;
  staleOpenIssueCount: number;
  issuesCreated: number;
  issuesCompleted: number;
  issuesMovedToBlocked: number;
  issuesCancelled: number;
  issuesReopened: number;
  statusChangeCount: number;
  assignmentChangeCount: number;
  boardCommentCount: number;
  boardActionCount: number;
  approvalCreatedCount: number;
  approvalApprovedCount: number;
  approvalRejectedCount: number;
  approvalRevisionRequestedCount: number;
  activeApprovalCount: number;
  heartbeatRunCount: number;
  attentionHeartbeatRunCount: number;
  timerAttentionHeartbeatRunCount: number;
  failedHeartbeatRunCount: number;
  routineRunCount: number;
  failedRoutineRunCount: number;
}

export interface ManagementAnalyzerActionCount {
  action: string;
  count: number;
}

export interface ManagementAnalyzerBoardCommentEvidence {
  commentId: string;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  createdAt: Date;
  authorUserId: string | null;
  bodyExcerpt: string | null;
  issueApiPath: string;
  commentApiPath: string;
  issueAppPath: string | null;
}

export interface ManagementAnalyzerBoardActionEvidence {
  activityId: string;
  action: string;
  createdAt: Date;
  entityType: string;
  entityId: string;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  detailsSummary: Record<string, unknown> | null;
  issueApiPath: string | null;
  issueAppPath: string | null;
}

export interface ManagementAnalyzerStatusChangeEvidence {
  activityId: string;
  createdAt: Date;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  actorType: "agent" | "user" | "system" | "plugin";
  actorId: string;
  status: string | null;
  previousStatus: string | null;
  assigneeAgentId: string | null;
  previousAssigneeAgentId: string | null;
  assigneeUserId: string | null;
  previousAssigneeUserId: string | null;
  issueApiPath: string;
  issueAppPath: string | null;
}

export interface ManagementAnalyzerApprovalEvidence {
  approvalId: string;
  type: string;
  status: ApprovalStatus;
  requestedByAgentId: string | null;
  requestedByUserId: string | null;
  decidedByUserId: string | null;
  createdAt: Date;
  decidedAt: Date | null;
  payloadSummary: Record<string, unknown> | null;
  approvalApiPath: string;
}

export interface ManagementAnalyzerRunEvidence {
  runId: string;
  status: HeartbeatRunStatus;
  livenessState: RunLivenessState | null;
  attentionCategory: "issue_run" | "timer_telemetry";
  invocationSource: string;
  startedAt: Date | null;
  finishedAt: Date | null;
  issueId: string | null;
  issueIdentifier: string | null;
  issueTitle: string | null;
  resultSummary: Record<string, unknown> | null;
  runIssuesApiPath: string;
  issueApiPath: string | null;
  issueAppPath: string | null;
}

export interface ManagementAnalyzerRoutineRunEvidence {
  routineRunId: string;
  routineId: string;
  routineTitle: string;
  status: string;
  source: string;
  triggeredAt: Date;
  failureReason: string | null;
  linkedIssueId: string | null;
  linkedIssueIdentifier: string | null;
  linkedIssueTitle: string | null;
  routineRunsApiPath: string;
  issueApiPath: string | null;
  issueAppPath: string | null;
}

export interface ManagementAnalyzerSnapshotEvidence {
  boardComments: ManagementAnalyzerBoardCommentEvidence[];
  boardActions: ManagementAnalyzerBoardActionEvidence[];
  statusChanges: ManagementAnalyzerStatusChangeEvidence[];
  approvals: ManagementAnalyzerApprovalEvidence[];
  attentionRuns: ManagementAnalyzerRunEvidence[];
  routineRuns: ManagementAnalyzerRoutineRunEvidence[];
  blockedIssues: ManagementIssueSummary[];
}

export interface ManagementAnalyzerSnapshotResponse {
  company: ManagementCompanySummary;
  health: ManagementCompanyHealthSummary;
  window: ManagementAnalyzerWindow;
  access: ManagementAnalyzerAccessSummary;
  metrics: ManagementAnalyzerMetricSummary;
  boardActionBreakdown: ManagementAnalyzerActionCount[];
  evidence: ManagementAnalyzerSnapshotEvidence;
}

export interface ManagementCompanyListResponse {
  companies: ManagementCompanySummary[];
}

export interface ManagementCompanyDetailResponse {
  company: ManagementCompanySummary;
  health: ManagementCompanyHealthSummary;
  agents: ManagementAgentSummary[];
  projects: ManagementProjectSummary[];
  approvals: ManagementApprovalSummary[];
}

export interface ManagementIssueListResponse {
  issues: ManagementIssueSummary[];
  nextOffset: number | null;
}

export interface ManagementRunListResponse {
  runs: ManagementRunSummary[];
  nextOffset: number | null;
}
