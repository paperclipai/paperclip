import type {
  IssueCommentAuthorType,
  IssueCommentMetadataRowType,
  IssueCommentPresentationKind,
  IssueCommentPresentationTone,
  IssueExecutionMonitorClearReason,
  IssueExecutionMonitorKind,
  IssueExecutionMonitorRecoveryPolicy,
  IssueExecutionMonitorStateStatus,
  IssueExecutionDecisionOutcome,
  IssueMonitorScheduledBy,
  IssueExecutionPolicyMode,
  IssueReferenceSourceKind,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueHarnessKind,
  IssueOriginKind,
  IssuePriority,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionStatus,
  IssueWorkMode,
  ModelProfileKey,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionKind,
  IssueThreadInteractionStatus,
  IssueStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";
import type {
  LowTrustReviewPresetPolicy,
  SourceTrustMetadata,
  TrustAuthorizationPolicy,
} from "../trust-policy.js";

export type { IssueWorkMode };

export interface IssueAncestorProject {
  id: string;
  name: string;
  description: string | null;
  status: string;
  goalId: string | null;
  workspaces: ProjectWorkspace[];
  primaryWorkspace: ProjectWorkspace | null;
}

export interface IssueAncestorGoal {
  id: string;
  title: string;
  description: string | null;
  level: string;
  status: string;
}

export interface IssueAncestor {
  id: string;
  identifier: string | null;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  projectId: string | null;
  goalId: string | null;
  project: IssueAncestorProject | null;
  goal: IssueAncestorGoal | null;
}

export interface IssueLabel {
  id: string;
  companyId: string;
  name: string;
  color: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueAssigneeAdapterOverrides {
  modelProfile?: ModelProfileKey;
  adapterConfig?: Record<string, unknown>;
  useProjectWorkspace?: boolean;
}

export type DocumentFormat = "markdown";

export interface IssueDocumentSummary {
  id: string;
  companyId: string;
  issueId: string;
  key: string;
  title: string | null;
  format: DocumentFormat;
  latestRevisionId: string | null;
  latestRevisionNumber: number;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  lockedAt: Date | null;
  lockedByAgentId: string | null;
  lockedByUserId: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueDocument extends IssueDocumentSummary {
  body: string;
}

export interface DocumentRevision {
  id: string;
  companyId: string;
  documentId: string;
  issueId: string;
  key: string;
  revisionNumber: number;
  title: string | null;
  format: DocumentFormat;
  body: string;
  changeSummary: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
}

export interface LegacyPlanDocument {
  key: "plan";
  body: string;
  source: "issue_description";
}

export type AcceptedPlanDecompositionStatus = "in_flight" | "completed";

export interface AcceptedPlanDecompositionChild {
  projectId?: string | null;
  projectWorkspaceId?: string | null;
  goalId?: string | null;
  blockedByIssueIds?: string[];
  title: string;
  description?: string | null;
  status: IssueStatus;
  workMode: IssueWorkMode;
  harnessKind?: IssueHarnessKind | null;
  priority: IssuePriority;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  requestDepth?: number;
  billingCode?: string | null;
  assigneeAdapterOverrides?: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionWorkspaceId?: string | null;
  executionWorkspacePreference?: string | null;
  executionWorkspaceSettings?: IssueExecutionWorkspaceSettings | null;
  labelIds?: string[];
  acceptanceCriteria?: string[];
  blockParentUntilDone?: boolean;
}

export interface AcceptedPlanDecomposition {
  id: string;
  companyId: string;
  sourceIssueId: string;
  acceptedPlanRevisionId: string;
  acceptedInteractionId: string | null;
  status: AcceptedPlanDecompositionStatus;
  requestFingerprint: string;
  requestedChildCount: number;
  childIssueIds: string[];
  ownerAgentId: string | null;
  ownerUserId: string | null;
  ownerRunId: string | null;
  completedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export interface AcceptedPlanDecompositionResult {
  decomposition: AcceptedPlanDecomposition;
  childIssueIds: string[];
  newlyCreatedChildIssueIds: string[];
}

export interface AcceptedPlanDecompositionChildIssue {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface AcceptedPlanDecompositionSummary extends AcceptedPlanDecomposition {
  acceptedPlanRevisionNumber: number | null;
  childIssues: AcceptedPlanDecompositionChildIssue[];
}

export interface IssueRelationIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  terminalBlockers?: IssueRelationIssueSummary[];
  activeRecoveryAction?: IssueRecoveryAction | null;
}

export type IssueBlockerDiagnosticFlag =
  | "done_but_blocking"
  | "cancelled_blocker_in_set"
  | "workspace_finalize_pending";

export interface IssueBlockerDiagnosticIssueSummary {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueBlockerDiagnosticNode extends IssueBlockerDiagnosticIssueSummary {
  isUnresolved: boolean;
  isDependencyReady: boolean;
  isPendingFinalize: boolean;
  flags: IssueBlockerDiagnosticFlag[];
}

export interface IssueBlockerDiagnosticsReadiness {
  allBlockersDone: boolean;
  isDependencyReady: boolean;
  unresolvedBlockerCount: number;
  pendingFinalizeBlockerCount: number;
}

export interface IssueBlockerDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  readiness: IssueBlockerDiagnosticsReadiness | null;
  blockers: IssueBlockerDiagnosticNode[];
  omittedUnauthorizedBlockerCount: number | null;
  truncated: boolean;
  caps: {
    maxBlockers: number;
  };
}

export type IssueWakeDiagnosticWakeFailureClass = "failed" | "cancelled" | "skipped";

export interface IssueWakeDiagnosticWakeRequest {
  kind: "wake_request";
  agentId: string | null;
  source: string;
  reason: string | null;
  status: string;
  coalescedCount: number;
  runId: string | null;
  requestedAt: string;
  claimedAt: string | null;
  finishedAt: string | null;
  failureClass: IssueWakeDiagnosticWakeFailureClass | null;
}

export interface IssueWakeDiagnosticActivityRecord {
  kind: "activity";
  action: string;
  entityType: string;
  agentId: string | null;
  runId: string | null;
  createdAt: string;
  source: string | null;
  requestedReason: string | null;
  previousReason: string | null;
  rootIssueId: string | null;
  holdId: string | null;
  summary: string;
}

export type IssueWakeDiagnosticEvent =
  | IssueWakeDiagnosticWakeRequest
  | IssueWakeDiagnosticActivityRecord;

export interface IssueWakeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  events: IssueWakeDiagnosticEvent[];
  wakeRequestCount: number;
  activityRecordCount: number;
  truncated: boolean;
  truncatedSections: {
    wakeRequests: boolean;
    activityRecords: boolean;
  };
  caps: {
    maxWakeRequests: number;
    maxActivityRecords: number;
    lookbackDays: number;
  };
}

export interface IssueSubtreeDiagnosticNode {
  issue: IssueBlockerDiagnosticIssueSummary;
  parentId: string | null;
  depth: number;
  diagnosis: string | null;
  likelyReason: string | null;
  blockers: IssueBlockerDiagnosticNode[];
  blockerReadiness: IssueBlockerDiagnosticsReadiness | null;
  omittedUnauthorizedBlockerCount: number | null;
  wakeEvents: IssueWakeDiagnosticEvent[];
  wakeRequestCount: number;
  activityRecordCount: number;
  truncated: boolean;
  truncatedSections: {
    blockers: boolean;
    wakeRequests: boolean;
    activityRecords: boolean;
  };
}

export type IssueSubtreeDiagnosticEdge =
  | {
    kind: "parent";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "blocks";
    fromIssueId: string;
    toIssueId: string;
    timestamp: string | null;
  }
  | {
    kind: "wake_request";
    issueId: string;
    agentId: string | null;
    reason: string | null;
    status: string;
    timestamp: string;
  }
  | {
    kind: "activity";
    issueId: string;
    action: string;
    timestamp: string;
  };

export interface IssueSubtreeDiagnosticsResponse {
  issue: IssueBlockerDiagnosticIssueSummary;
  diagnosis: string | null;
  likelyReason: string | null;
  nodes: IssueSubtreeDiagnosticNode[];
  edges: IssueSubtreeDiagnosticEdge[];
  nodeCount: number;
  omittedUnauthorizedNodeCount: number | null;
  truncated: boolean;
  truncatedSections: {
    nodes: boolean;
    depth: boolean;
    blockers: boolean;
    wakeRequests: boolean;
    activityRecords: boolean;
  };
  caps: {
    maxDepth: number;
    maxNodes: number;
    maxBlockersPerNode: number;
    maxWakeRequestsPerNode: number;
    maxActivityRecordsPerNode: number;
    lookbackDays: number;
  };
}

export type IssueBlockerAttentionState = "none" | "covered" | "stalled" | "needs_attention";

export type IssueBlockerAttentionReason =
  | "active_child"
  | "active_dependency"
  | "stalled_review"
  | "attention_required"
  | null;

export interface IssueBlockerAttention {
  state: IssueBlockerAttentionState;
  reason: IssueBlockerAttentionReason;
  unresolvedBlockerCount: number;
  coveredBlockerCount: number;
  stalledBlockerCount: number;
  attentionBlockerCount: number;
  sampleBlockerIdentifier: string | null;
  sampleStalledBlockerIdentifier: string | null;
}

export type IssueInboxAttentionKind = "blocked";

export type IssueBlockedInboxState =
  | "needs_attention"
  | "awaiting_decision"
  | "external_wait"
  | "recovery_open"
  | "missing_disposition";

export type IssueBlockedInboxSeverity = "critical" | "high" | "medium" | "low";

export type IssueBlockedInboxReason =
  | "blocked_by_unassigned_issue"
  | "blocked_by_assigned_backlog_issue"
  | "blocked_by_uninvokable_assignee"
  | "blocked_by_cancelled_issue"
  | "blocked_chain_stalled"
  | "invalid_review_participant"
  | "in_review_without_action_path"
  | "missing_successful_run_disposition"
  | "pending_board_decision"
  | "pending_user_decision"
  | "external_owner_action"
  | "open_recovery_issue";

export type IssueBlockedInboxOwnerType = "agent" | "user" | "board" | "external" | "unknown";

export interface IssueBlockedInboxIssueRef {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
}

export interface IssueBlockedInboxOwner {
  type: IssueBlockedInboxOwnerType;
  agentId: string | null;
  userId: string | null;
  label: string | null;
}

export interface IssueBlockedInboxAction {
  label: string;
  detail: string | null;
}

export interface IssueBlockedInboxAttention {
  kind: IssueInboxAttentionKind;
  state: IssueBlockedInboxState;
  reason: IssueBlockedInboxReason;
  severity: IssueBlockedInboxSeverity;
  stoppedSinceAt: string | null;
  owner: IssueBlockedInboxOwner;
  action: IssueBlockedInboxAction;
  sourceIssue: IssueBlockedInboxIssueRef | null;
  leafIssue: IssueBlockedInboxIssueRef | null;
  recoveryIssue: IssueBlockedInboxIssueRef | null;
  approvalId: string | null;
  interactionId: string | null;
  sampleIssueIdentifier: string | null;
  redaction: {
    externalDetailsRedacted: boolean;
    secretFieldsOmitted: true;
  };
}

export type IssueProductivityReviewTrigger =
  | "no_comment_streak"
  | "long_active_duration"
  | "high_churn";

export interface IssueProductivityReview {
  reviewIssueId: string;
  reviewIdentifier: string | null;
  status: IssueStatus;
  priority: IssuePriority;
  trigger: IssueProductivityReviewTrigger | null;
  noCommentStreak: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueRecoveryAction {
  id: string;
  companyId: string;
  sourceIssueId: string;
  recoveryIssueId: string | null;
  kind: IssueRecoveryActionKind;
  status: IssueRecoveryActionStatus;
  ownerType: IssueRecoveryActionOwnerType;
  ownerAgentId: string | null;
  ownerUserId: string | null;
  previousOwnerAgentId: string | null;
  returnOwnerAgentId: string | null;
  cause: string;
  fingerprint: string;
  evidence: Record<string, unknown>;
  nextAction: string;
  wakePolicy: Record<string, unknown> | null;
  monitorPolicy: Record<string, unknown> | null;
  attemptCount: number;
  maxAttempts: number | null;
  timeoutAt: Date | string | null;
  lastAttemptAt: Date | string | null;
  outcome: IssueRecoveryActionOutcome | null;
  resolutionNote: string | null;
  resolvedAt: Date | string | null;
  createdAt: Date | string;
  updatedAt: Date | string;
}

export type SuccessfulRunHandoffStateKind = "required" | "resolved" | "escalated";

export interface SuccessfulRunHandoffState {
  state: SuccessfulRunHandoffStateKind;
  required: boolean;
  hasLiveContinuation: boolean;
  liveRunId?: string | null;
  sourceRunId: string | null;
  correctiveRunId: string | null;
  assigneeAgentId: string | null;
  detectedProgressSummary: string | null;
  createdAt: Date | string | null;
}

export type IssueScheduledRetryStatus = "scheduled_retry" | "queued" | "running" | "cancelled";

export interface IssueScheduledRetry {
  runId: string;
  status: IssueScheduledRetryStatus;
  agentId: string;
  agentName: string | null;
  retryOfRunId: string | null;
  scheduledRetryAt: Date | string | null;
  scheduledRetryAttempt: number;
  scheduledRetryReason: string | null;
  retryExhaustedReason?: string | null;
  error?: string | null;
  errorCode?: string | null;
}

export type IssueRetryNowOutcome =
  | "promoted"
  | "already_promoted"
  | "no_scheduled_retry"
  | "gate_suppressed";

export interface IssueRetryNowResponse {
  outcome: IssueRetryNowOutcome;
  message: string;
  scheduledRetry: IssueScheduledRetry | null;
}

export interface IssueRelation {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: "blocks";
  relatedIssue: IssueRelationIssueSummary;
}

export interface IssueReferenceSource {
  kind: IssueReferenceSourceKind;
  sourceRecordId: string | null;
  label: string;
  matchedText: string | null;
}

export interface IssueRelatedWorkItem {
  issue: IssueRelationIssueSummary;
  mentionCount: number;
  sources: IssueReferenceSource[];
}

export interface IssueRelatedWorkSummary {
  outbound: IssueRelatedWorkItem[];
  inbound: IssueRelatedWorkItem[];
}

export interface IssueExecutionStagePrincipal {
  type: "agent" | "user";
  agentId?: string | null;
  userId?: string | null;
}

export interface IssueExecutionStageParticipant extends IssueExecutionStagePrincipal {
  id: string;
}

export interface IssueExecutionStage {
  id: string;
  type: IssueExecutionStageType;
  approvalsNeeded: 1;
  participants: IssueExecutionStageParticipant[];
}

export interface IssueExecutionMonitorPolicy {
  nextCheckAt: string;
  notes: string | null;
  scheduledBy: IssueMonitorScheduledBy;
  kind?: IssueExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: IssueExecutionMonitorRecoveryPolicy | null;
}

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
  monitor?: IssueExecutionMonitorPolicy | null;
  reviewPreset?: LowTrustReviewPresetPolicy;
  authorizationPolicy?: TrustAuthorizationPolicy;
}

export interface IssueExecutionMonitorState {
  status: IssueExecutionMonitorStateStatus;
  nextCheckAt: string | null;
  lastTriggeredAt: string | null;
  attemptCount: number;
  notes: string | null;
  scheduledBy: IssueMonitorScheduledBy | null;
  kind?: IssueExecutionMonitorKind | null;
  serviceName?: string | null;
  externalRef?: string | null;
  timeoutAt?: string | null;
  maxAttempts?: number | null;
  recoveryPolicy?: IssueExecutionMonitorRecoveryPolicy | null;
  clearedAt: string | null;
  clearReason: IssueExecutionMonitorClearReason | null;
}

export interface IssueReviewRequest {
  instructions: string;
}

export interface IssueExecutionState {
  status: IssueExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: IssueExecutionStageType | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  reviewRequest: IssueReviewRequest | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: IssueExecutionDecisionOutcome | null;
  monitor?: IssueExecutionMonitorState | null;
}

export interface IssueExecutionDecision {
  id: string;
  companyId: string;
  issueId: string;
  stageId: string;
  stageType: IssueExecutionStageType;
  actorAgentId: string | null;
  actorUserId: string | null;
  outcome: IssueExecutionDecisionOutcome;
  body: string;
  createdByRunId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type IssueWatchdogStatus = "active" | "disabled";

export interface IssueWatchdogSummary {
  id: string;
  companyId: string;
  issueId: string;
  watchdogAgentId: string;
  instructions: string | null;
  status: IssueWatchdogStatus;
  watchdogIssueId: string | null;
  lastObservedFingerprint: string | null;
  lastReviewedFingerprint: string | null;
  lastTriggeredAt: Date | null;
  lastCompletedAt: Date | null;
  triggerCount: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueWatchdog extends IssueWatchdogSummary {
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdByRunId: string | null;
  updatedByAgentId: string | null;
  updatedByUserId: string | null;
  updatedByRunId: string | null;
}

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  workMode: IssueWorkMode;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  responsibleUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  monitorNextCheckAt?: Date | null;
  monitorLastTriggeredAt?: Date | null;
  monitorAttemptCount?: number;
  monitorNotes?: string | null;
  monitorScheduledBy?: IssueMonitorScheduledBy | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  sourceTrust?: SourceTrustMetadata | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  productivityReview?: IssueProductivityReview | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  watchdog?: IssueWatchdogSummary | null;
  scheduledRetry?: IssueScheduledRetry | null;
  liveDescendantCount?: number;
  relatedWork?: IssueRelatedWorkSummary;
  referencedIssueIdentifiers?: string[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  archivedAt?: Date | null;
  archivedByActorType?: "user" | "agent" | null;
  archivedByAgentId?: string | null;
  archivedByRunId?: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type CompactIssue = Pick<
  Issue,
  | "id"
  | "companyId"
  | "projectId"
  | "projectWorkspaceId"
  | "goalId"
  | "parentId"
  | "title"
  | "description"
  | "status"
  | "workMode"
  | "priority"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "checkoutRunId"
  | "executionRunId"
  | "executionAgentNameKey"
  | "executionLockedAt"
  | "createdByAgentId"
  | "createdByUserId"
  | "issueNumber"
  | "identifier"
  | "originKind"
  | "originId"
  | "originRunId"
  | "requestDepth"
  | "billingCode"
  | "executionWorkspaceId"
  | "startedAt"
  | "completedAt"
  | "cancelledAt"
  | "createdAt"
  | "updatedAt"
> & {
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  blockedInboxAttention?: IssueBlockedInboxAttention | null;
  productivityReview?: IssueProductivityReview | null;
  scheduledRetry?: IssueScheduledRetry | null;
  liveDescendantCount?: number;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  archivedAt?: Date | null;
  archivedByActorType?: "user" | "agent" | null;
  archivedByAgentId?: string | null;
  archivedByRunId?: string | null;
  activeRecoveryAction: IssueRecoveryAction | null;
  successfulRunHandoff: SuccessfulRunHandoffState | null;
};

/**
 * Where a comment's derived (non-stored-author) agent attribution came from,
 * in descending confidence:
 * - `run_id`: comment carries a `createdByRunId`/`derivedCreatedByRunId` whose
 *   run resolves directly to an agent (lossless).
 * - `run_log_comment_post`: a run log within the comment window contains the
 *   `comment id: {id}` post marker (lossless: the run recorded posting it).
 *
 * Only lossless signals are used. Pure run-window timing overlap is NOT a
 * source — it cannot distinguish an agent comment from a human board comment
 * that coincided with a run (Option A).
 */
export type IssueCommentDerivedAuthorSource =
  | "run_id"
  | "run_log_comment_post";

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorType: IssueCommentAuthorType;
  authorAgentId: string | null;
  authorUserId: string | null;
  createdByRunId?: string | null;
  derivedAuthorAgentId?: string | null;
  derivedCreatedByRunId?: string | null;
  derivedAuthorSource?: IssueCommentDerivedAuthorSource | null;
  body: string;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  deletedAt?: Date | null;
  deletedByType?: "agent" | "user" | null;
  deletedByAgentId?: string | null;
  deletedByUserId?: string | null;
  deletedByRunId?: string | null;
  sourceTrust?: SourceTrustMetadata | null;
  followUpRequested?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

interface IssueCommentMetadataRowBase {
  type: IssueCommentMetadataRowType;
  label?: string | null;
}

export interface IssueCommentMetadataTextRow extends IssueCommentMetadataRowBase {
  type: "text";
  text: string;
}

export interface IssueCommentMetadataCodeRow extends IssueCommentMetadataRowBase {
  type: "code";
  code: string;
  language?: string | null;
}

export interface IssueCommentMetadataKeyValueRow extends IssueCommentMetadataRowBase {
  type: "key_value";
  label: string;
  value: string;
}

export interface IssueCommentMetadataIssueLinkRow extends IssueCommentMetadataRowBase {
  type: "issue_link";
  issueId?: string | null;
  identifier?: string | null;
  title?: string | null;
}

export interface IssueCommentMetadataAgentLinkRow extends IssueCommentMetadataRowBase {
  type: "agent_link";
  agentId: string;
  name?: string | null;
}

export interface IssueCommentMetadataRunLinkRow extends IssueCommentMetadataRowBase {
  type: "run_link";
  runId: string;
  title?: string | null;
}

export type IssueCommentMetadataRow =
  | IssueCommentMetadataTextRow
  | IssueCommentMetadataCodeRow
  | IssueCommentMetadataKeyValueRow
  | IssueCommentMetadataIssueLinkRow
  | IssueCommentMetadataAgentLinkRow
  | IssueCommentMetadataRunLinkRow;

export interface IssueCommentMetadataSection {
  title?: string | null;
  rows: IssueCommentMetadataRow[];
}

export interface IssueCommentMetadata {
  version: 1;
  sourceRunId?: string | null;
  sections: IssueCommentMetadataSection[];
}

export interface IssueCommentPresentation {
  kind: IssueCommentPresentationKind;
  tone: IssueCommentPresentationTone;
  title?: string | null;
  detailsDefaultOpen: boolean;
}

export interface IssueThreadInteractionActorFields {
  createdByAgentId?: string | null;
  createdByUserId?: string | null;
  resolvedByAgentId?: string | null;
  resolvedByUserId?: string | null;
}

export interface SuggestedTaskDraft {
  clientKey: string;
  parentClientKey?: string | null;
  parentId?: string | null;
  title: string;
  description?: string | null;
  priority?: IssuePriority | null;
  workMode?: IssueWorkMode | null;
  assigneeAgentId?: string | null;
  assigneeUserId?: string | null;
  projectId?: string | null;
  goalId?: string | null;
  billingCode?: string | null;
  labels?: string[];
  hiddenInPreview?: boolean;
}

export interface SuggestTasksPayload {
  version: 1;
  defaultParentId?: string | null;
  tasks: SuggestedTaskDraft[];
}

export interface SuggestTasksResultCreatedTask {
  clientKey: string;
  issueId: string;
  identifier?: string | null;
  title?: string | null;
  parentIssueId?: string | null;
  parentIdentifier?: string | null;
}

export interface SuggestTasksResult {
  version: 1;
  createdTasks?: SuggestTasksResultCreatedTask[];
  skippedClientKeys?: string[];
  rejectionReason?: string | null;
}

export interface AskUserQuestionsQuestionOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface AskUserQuestionsQuestion {
  id: string;
  prompt: string;
  helpText?: string | null;
  selectionMode: "single" | "multi";
  required?: boolean;
  options: AskUserQuestionsQuestionOption[];
}

export interface AskUserQuestionsPayload {
  version: 1;
  title?: string | null;
  submitLabel?: string | null;
  supersedeOnUserComment?: boolean;
  questions: AskUserQuestionsQuestion[];
}

export interface AskUserQuestionsAnswer {
  questionId: string;
  optionIds: string[];
  otherText?: string | null;
}

export interface AskUserQuestionsResult {
  version: 1;
  answers: AskUserQuestionsAnswer[];
  cancelled?: true;
  cancellationReason?: string | null;
  expirationReason?: "superseded_by_comment";
  commentId?: string | null;
  summaryMarkdown?: string | null;
}

export interface RequestConfirmationIssueDocumentTarget {
  type: "issue_document";
  issueId?: string | null;
  documentId?: string | null;
  key: string;
  revisionId: string;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export interface RequestConfirmationCustomTarget {
  type: "custom";
  key: string;
  revisionId?: string | null;
  revisionNumber?: number | null;
  label?: string | null;
  href?: string | null;
}

export type RequestConfirmationTarget =
  | RequestConfirmationIssueDocumentTarget
  | RequestConfirmationCustomTarget;

/**
 * Enrichment block carried on a `request_confirmation` interaction when it gates
 * a write/destructive MCP tool call (PAP-13726 §D1). Its presence flips the feed
 * card into the dedicated tool-approval rendering (PAP-13745). Arguments are
 * redacted server-side before this reaches the client.
 */
export interface RequestConfirmationToolActionPayload {
  version: 1;
  actionRequestId: string;
  invocationId: string;
  toolName: string;
  toolDisplayName: string;
  connectionId: string | null;
  applicationId: string | null;
  appDisplayName: string | null;
  risk: "write" | "destructive";
  previewMarkdown: string;
  argumentsSummaryJson: string;
  argumentsHash: string;
  expiresAt: string;
}

/**
 * Lifecycle status written back onto the resolved interaction once the operator
 * approves. `approve = run`, so the terminal states are executed/failed/expired —
 * never a bare "accepted".
 */
export interface RequestConfirmationToolActionResult {
  version: 1;
  status: "approved" | "executing" | "executed" | "failed" | "expired";
  errorCode?: string | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
  resultHref?: string | null;
  updatedAt: string;
}

export interface RequestConfirmationPayload {
  version: 1;
  prompt: string;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  detailsMarkdown?: string | null;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
  toolAction?: RequestConfirmationToolActionPayload;
}

export interface RequestCheckboxConfirmationOption {
  id: string;
  label: string;
  description?: string | null;
}

export interface RequestCheckboxConfirmationPayload {
  version: 1;
  prompt: string;
  detailsMarkdown?: string | null;
  options: RequestCheckboxConfirmationOption[];
  defaultSelectedOptionIds?: string[];
  minSelected?: number;
  maxSelected?: number | null;
  acceptLabel?: string | null;
  rejectLabel?: string | null;
  rejectRequiresReason?: boolean;
  rejectReasonLabel?: string | null;
  allowDeclineReason?: boolean;
  declineReasonPlaceholder?: string | null;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
}

export type RequestItemVerdictValue = "approve" | "reject" | "defer";

export interface RequestItemVerdictsItem {
  id: string;
  label: string;
  description?: string | null;
  previewMarkdown?: string | null;
  href?: string | null;
  attachmentId?: string | null;
}

export interface RequestItemVerdictsPayload {
  version: 1;
  prompt: string;
  detailsMarkdown?: string | null;
  items: RequestItemVerdictsItem[];
  verdicts?: RequestItemVerdictValue[];
  requireReasonOn?: RequestItemVerdictValue[];
  reasonLabel?: string | null;
  allowBulkApprove?: boolean;
  supersedeOnUserComment?: boolean;
  target?: RequestConfirmationTarget | null;
}

export interface RequestConfirmationResult {
  version: 1;
  outcome: "accepted" | "rejected" | "superseded_by_comment" | "stale_target";
  reason?: string | null;
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
  resumeFailure?: {
    status: "retrying" | "needs_attention";
    errorCode: string | null;
    attempt: number;
    maxAttempts: number;
    runId?: string | null;
    retryRunId?: string | null;
    recoveryActionId?: string | null;
    updatedAt?: string | null;
  } | null;
  toolAction?: RequestConfirmationToolActionResult;
}

export interface RequestCheckboxConfirmationResult extends RequestConfirmationResult {
  selectedOptionIds?: string[];
}

export interface RequestItemVerdictsResultItem {
  id: string;
  verdict: RequestItemVerdictValue;
  reason?: string | null;
  resolvedByUserId: string;
  resolvedAt: Date | string;
  commentId?: string | null;
}

export interface RequestItemVerdictsResult {
  version: 1;
  outcome: "resolved" | "superseded_by_comment" | "stale_target" | "cancelled";
  complete: boolean;
  items: RequestItemVerdictsResultItem[];
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
}

export interface IssueThreadInteractionBase extends IssueThreadInteractionActorFields {
  id: string;
  companyId: string;
  issueId: string;
  kind: IssueThreadInteractionKind;
  idempotencyKey?: string | null;
  sourceCommentId?: string | null;
  sourceRunId?: string | null;
  title?: string | null;
  summary?: string | null;
  status: IssueThreadInteractionStatus;
  continuationPolicy: IssueThreadInteractionContinuationPolicy;
  createdAt: Date | string;
  updatedAt: Date | string;
  resolvedAt?: Date | string | null;
}

export interface SuggestTasksInteraction extends IssueThreadInteractionBase {
  kind: "suggest_tasks";
  payload: SuggestTasksPayload;
  result?: SuggestTasksResult | null;
}

export interface AskUserQuestionsInteraction extends IssueThreadInteractionBase {
  kind: "ask_user_questions";
  payload: AskUserQuestionsPayload;
  result?: AskUserQuestionsResult | null;
}

export interface RequestConfirmationInteraction extends IssueThreadInteractionBase {
  kind: "request_confirmation";
  payload: RequestConfirmationPayload;
  result?: RequestConfirmationResult | null;
}

export interface RequestCheckboxConfirmationInteraction extends IssueThreadInteractionBase {
  kind: "request_checkbox_confirmation";
  payload: RequestCheckboxConfirmationPayload;
  result?: RequestCheckboxConfirmationResult | null;
}

export interface RequestItemVerdictsInteraction extends IssueThreadInteractionBase {
  kind: "request_item_verdicts";
  payload: RequestItemVerdictsPayload;
  result?: RequestItemVerdictsResult | null;
}

export type IssueThreadInteraction =
  | SuggestTasksInteraction
  | AskUserQuestionsInteraction
  | RequestConfirmationInteraction
  | RequestCheckboxConfirmationInteraction
  | RequestItemVerdictsInteraction;

export type IssueThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload
  | RequestCheckboxConfirmationPayload
  | RequestItemVerdictsPayload;

export type IssueThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult
  | RequestCheckboxConfirmationResult
  | RequestItemVerdictsResult;

export interface IssueAttachment {
  id: string;
  companyId: string;
  issueId: string;
  issueCommentId: string | null;
  assetId: string;
  provider: string;
  objectKey: string;
  contentType: string;
  byteSize: number;
  sha256: string;
  originalFilename: string | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
  contentPath: string;
  openPath?: string;
  downloadPath?: string;
}
