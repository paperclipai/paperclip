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
  IssueFactoryLaneKind,
  IssueFactoryTopologyMode,
  IssueReferenceSourceKind,
  IssueExecutionStageType,
  IssueExecutionStateStatus,
  IssueOriginKind,
  IssuePriority,
  IssueRecoveryActionKind,
  IssueRecoveryActionOutcome,
  IssueRecoveryActionOwnerType,
  IssueRecoveryActionStatus,
  IssueWorkItemType,
  IssueWorkMode,
  ModelProfileKey,
  IssueThreadInteractionContinuationPolicy,
  IssueThreadInteractionKind,
  IssueThreadInteractionStatus,
  IssueStatus,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { WorkCycle } from "./work-cycle.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct } from "./work-product.js";
import type { FactoryPolicyV1 } from "./ai-factory-policy.js";

export type { IssueWorkItemType, IssueWorkMode };

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

export type IssueExecutionContractWorkProductType =
  | "preview_url"
  | "runtime_service"
  | "pull_request"
  | "branch"
  | "commit"
  | "artifact"
  | "document";

export type IssueExecutionContractRequiredOutput = Record<string, unknown> & (
  | {
      workProductType: IssueExecutionContractWorkProductType;
      work_product_type?: IssueExecutionContractWorkProductType;
      type?: IssueExecutionContractWorkProductType;
    }
  | {
      workProductType?: IssueExecutionContractWorkProductType;
      work_product_type: IssueExecutionContractWorkProductType;
      type?: IssueExecutionContractWorkProductType;
    }
  | {
      workProductType?: IssueExecutionContractWorkProductType;
      work_product_type?: IssueExecutionContractWorkProductType;
      type: IssueExecutionContractWorkProductType;
    }
);

export type IssueExecutionContractRequiredOutputs =
  | IssueExecutionContractWorkProductType
  | IssueExecutionContractRequiredOutput
  | Array<IssueExecutionContractWorkProductType | IssueExecutionContractRequiredOutput>;

export interface IssueExecutionContractCore extends Record<string, unknown> {
  objective?: string;
  why?: string;
  owner?: string | Record<string, unknown>;
  sourceOfTruth?: unknown;
  source_of_truth?: unknown;
  acceptanceChecks?: unknown;
  acceptance_checks?: unknown;
  constraints?: unknown;
  evidenceRequired?: unknown;
  evidence_required?: unknown;
  requiredOutputs?: IssueExecutionContractRequiredOutputs;
  required_outputs?: IssueExecutionContractRequiredOutputs;
  handoffNotes?: Record<string, unknown>;
  handoff_notes?: Record<string, unknown>;
}

export interface IssueExecutionContract extends Record<string, unknown> {
  schemaVersion?: number;
  schema_version?: number;
  revision?: number;
  supersedesRevision?: number | null;
  supersedes_revision?: number | null;
  contractType?: string;
  contract_type?: string;
  taskType?: string;
  task_type?: string;
  core?: IssueExecutionContractCore;
  extensions?: Record<string, unknown> | null;
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
  /** Stable company-policy key (for example implementation or live_qa). */
  key?: string | null;
  type: IssueExecutionStageType;
  /** Human-readable role selector retained in the snapshotted policy. */
  role?: string | null;
  /** Require a participant other than the lane coordinator/return assignee. */
  independent?: boolean;
  /** Stage key to reactivate when this stage requests changes. */
  returnToStageKey?: string | null;
  /** Structured delivery gates that must be satisfied before this stage advances. */
  evidenceGates?: string[];
  approvalsNeeded: 1;
  participants: IssueExecutionStageParticipant[];
}

export interface IssueFactoryExecutionPolicy {
  schemaVersion: 1;
  laneKind: IssueFactoryLaneKind;
  topologyMode: IssueFactoryTopologyMode;
  controlIssueId?: string | null;
  coordinator: IssueExecutionStagePrincipal;
  policyKey: string;
  policyVersion: string;
  policyHash: string;
  maxExecutionLanes: number;
  /** Frozen company-policy input used to construct this execution lane. */
  policySnapshot?: FactoryPolicyV1;
  /** Whether production-only stages were selected for this lane. */
  production?: boolean;
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
  factory?: IssueFactoryExecutionPolicy | null;
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
  /**
   * Monotonic activation revision for typed workflow stages. Delivery evidence
   * is stamped with this value so evidence from a prior QA/fix iteration cannot
   * be replayed after the workflow rewinds.
   */
  stageRevision?: number;
  currentStageActivatedAt?: string | null;
  completedStageRevisions?: Record<string, number>;
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

export interface Issue {
  id: string;
  companyId: string;
  projectId: string | null;
  cycleId?: string | null;
  projectWorkspaceId: string | null;
  goalId: string | null;
  parentId: string | null;
  ancestors?: IssueAncestor[];
  title: string;
  description: string | null;
  status: IssueStatus;
  workMode: IssueWorkMode;
  workItemType?: IssueWorkItemType;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  checkoutRunId: string | null;
  executionRunId: string | null;
  executionAgentNameKey: string | null;
  executionLockedAt: Date | null;
  createdByAgentId: string | null;
  createdByUserId: string | null;
  issueNumber: number | null;
  identifier: string | null;
  originKind?: IssueOriginKind;
  originId?: string | null;
  originRunId?: string | null;
  originFingerprint?: string | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionContract?: IssueExecutionContract | null;
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
  dueDate: Date | null;
  workLeadDays: number | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  visibility: "private" | "company";
  hiddenAt: Date | null;
  storyPoints?: number | null;
  estimateHours?: number | null;
  actualHumanSeconds?: number | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  productivityReview?: IssueProductivityReview | null;
  activeRecoveryAction?: IssueRecoveryAction | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
  relatedWork?: IssueRelatedWorkSummary;
  referencedIssueIdentifiers?: string[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  cycle?: WorkCycle | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  mentionedProjects?: Project[];
  actualAiSeconds?: number;
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

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
  derivedAuthorSource?: "run_log_comment_post" | null;
  body: string;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
  attachments?: IssueAttachment[];
  followUpRequested?: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueCollaborator {
  id: string;
  issueId: string;
  principalType: "user" | "agent";
  principalId: string;
  reason: "creator" | "explicit" | "assignment" | "mention";
  displayName: string | null;
  email?: string | null;
  createdAt: Date;
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
  executionContract?: IssueExecutionContract | null;
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
  cancelled?: true;
  cancellationReason?: string | null;
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

export type CapabilityPreflightReasonKind =
  | "missing_capability"
  | "missing_authority"
  | "policy_approval"
  | "irreversible_action"
  | "user_requested";

export type CapabilityPreflightCheckStatus = "available" | "unavailable" | "not_applicable";

export interface CapabilityPreflightCheck {
  capability: string;
  status: CapabilityPreflightCheckStatus;
  evidence: string;
}

/** Machine-auditable proof that an agent exhausted safe execution paths before pausing. */
export interface CapabilityPreflightV1 {
  version: 1;
  reasonKind: CapabilityPreflightReasonKind;
  checks: CapabilityPreflightCheck[];
  alternativesConsidered: string[];
  minimumDecision: string;
}

export interface AskUserQuestionsPayload {
  version: 1;
  title?: string | null;
  submitLabel?: string | null;
  /** Machine-readable context for the decision without overloading user-facing copy. */
  context?: Record<string, unknown> | null;
  capabilityPreflight?: CapabilityPreflightV1 | null;
  questions: AskUserQuestionsQuestion[];
}

export interface AskUserQuestionsAnswer {
  questionId: string;
  optionIds: string[];
}

export interface AskUserQuestionsResult {
  version: 1;
  answers: AskUserQuestionsAnswer[];
  cancelled?: true;
  cancellationReason?: string | null;
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
  capabilityPreflight?: CapabilityPreflightV1 | null;
}

export interface RequestConfirmationResult {
  version: 1;
  outcome: "accepted" | "rejected" | "cancelled" | "superseded_by_comment" | "stale_target";
  reason?: string | null;
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

export type IssueThreadInteraction =
  | SuggestTasksInteraction
  | AskUserQuestionsInteraction
  | RequestConfirmationInteraction;

export type IssueThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload;

export type IssueThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult;

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
}
