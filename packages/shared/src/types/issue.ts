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
  IssueOriginKind,
  IssuePriority,
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
  IssueDispositionFindingBundle,
  IssueFinalDisposition,
  IssueDispositionEvidenceRef,
  IssueFinalDispositionRecord as CanonicalIssueFinalDispositionRecord,
} from "../issue-disposition.js";
export type {
  IssueDispositionFinding,
  IssueDispositionFindingBundle,
  IssueDispositionFindingBundleKind,
  IssueDispositionEvidenceRefKind,
  IssueDispositionEvidenceRef,
  IssueDispositionSourceClass,
  IssueDispositionParentBlockerIntention,
  IssueDispositionTransitionInput,
  IssueDispositionTransitionResult,
  IssueDispositionTransitionIntention,
  IssueDispositionTransitionMissingPrecondition,
  IssueDispositionIdempotencyKey,
  IssueDispositionIdempotencyKeyInput,
  IssueFinalDisposition,
  IssueFinalDispositionSource,
  IssueDispositionUsefulOutputClass,
  IssueDispositionNextGate,
  IssueDispositionProjection,
  IssueDispositionVerdict,
  IssueDispositionProjectionFreshness,
} from "../issue-disposition.js";
import type {
  MissionControlIssuePolicy,
  MissionControlValidatorReport,
  MissionControlValidatorVerdict,
} from "../mission-control.js";

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

export interface IssueValidationHistoryEntry {
  id: string;
  issueId: string;
  source: "validator_report" | "execution_decision";
  label: string;
  verdict: MissionControlValidatorVerdict | null;
  completionScore: number | null;
  report: MissionControlValidatorReport | null;
  summary: string | null;
  criteriaChecked: string[];
  evidence: string[];
  blockingIssues: string[];
  exactFixIfFailed: string | null;
  stageId: string | null;
  stageType: IssueExecutionStageType | null;
  decisionOutcome: IssueExecutionDecisionOutcome | null;
  revisionNumber: number | null;
  bodyPreview: string | null;
  actorAgentId: string | null;
  actorUserId: string | null;
  createdByRunId: string | null;
  createdAt: Date;
}

export interface IssueValidationHistory {
  issueId: string;
  latest: IssueValidationHistoryEntry | null;
  entries: IssueValidationHistoryEntry[];
}

export type IssueTreeObservabilityTimelineKind = "run" | "cost" | "error" | "activity";
export type IssueTreeObservabilitySeverity = "info" | "success" | "warning" | "error";

export interface IssueTreeObservabilitySummary {
  issueId: string;
  issueCount: number;
  activeIssueCount: number;
  doneIssueCount: number;
  cancelledIssueCount: number;
  blockedIssueCount: number;
  runCount: number;
  activeRunCount: number;
  failedRunCount: number;
  errorEventCount: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  runtimeMs: number;
  lastActivityAt: Date | null;
}

export interface IssueTreeObservabilityNode {
  id: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  parentId: string | null;
  depth: number;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  runCount: number;
  activeRunCount: number;
  failedRunCount: number;
  errorEventCount: number;
  costCents: number;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  runtimeMs: number;
  lastActivityAt: Date | null;
  latestRunStatus: string | null;
  latestRunId: string | null;
}

export interface IssueTreeObservabilityTimelineEntry {
  id: string;
  kind: IssueTreeObservabilityTimelineKind;
  severity: IssueTreeObservabilitySeverity;
  issueId: string;
  issueIdentifier: string | null;
  issueTitle: string;
  runId: string | null;
  timestamp: Date;
  label: string;
  message: string | null;
  costCents: number | null;
}

export interface IssueTreeObservability {
  issueId: string;
  generatedAt: Date;
  summary: IssueTreeObservabilitySummary;
  nodes: IssueTreeObservabilityNode[];
  timeline: IssueTreeObservabilityTimelineEntry[];
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

export interface IssueFinalDeliveryTelegramDestination {
  platform: "telegram";
  chatId: string;
  threadId?: string | null;
  messageId?: string | null;
}

export interface IssueFinalDeliverySlackDestination {
  platform: "slack";
  channelId: string;
  threadTs?: string | null;
  messageTs?: string | null;
}

export type IssueFinalDeliveryDestination =
  | IssueFinalDeliveryTelegramDestination
  | IssueFinalDeliverySlackDestination;

export interface IssueFinalDeliveryPolicy {
  enabled: boolean;
  destination: IssueFinalDeliveryDestination;
}

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
  monitor?: IssueExecutionMonitorPolicy | null;
  missionControl?: MissionControlIssuePolicy | null;
  finalDelivery?: IssueFinalDeliveryPolicy | null;
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
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  blockerAttention?: IssueBlockerAttention;
  productivityReview?: IssueProductivityReview | null;
  successfulRunHandoff?: SuccessfulRunHandoffState | null;
  scheduledRetry?: IssueScheduledRetry | null;
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
  body: string;
  presentation: IssueCommentPresentation | null;
  metadata: IssueCommentMetadata | null;
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

export type IssueFinalDispositionRecord = CanonicalIssueFinalDispositionRecord;

export interface IssueCommentMetadataDispositionRow extends IssueCommentMetadataRowBase {
  type: "disposition";
  value: IssueFinalDisposition;
  reason?: string | null;
  evidenceRefs: IssueDispositionEvidenceRef[];
  idempotencyKey?: string | null;
  findingBundles?: IssueDispositionFindingBundle[];
  finalDisposition?: IssueFinalDispositionRecord | null;
}

export type IssueCommentMetadataRow =
  | IssueCommentMetadataTextRow
  | IssueCommentMetadataCodeRow
  | IssueCommentMetadataKeyValueRow
  | IssueCommentMetadataIssueLinkRow
  | IssueCommentMetadataAgentLinkRow
  | IssueCommentMetadataRunLinkRow
  | IssueCommentMetadataDispositionRow;

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
}

export interface RequestConfirmationResult {
  version: 1;
  outcome: "accepted" | "rejected" | "superseded_by_comment" | "stale_target";
  reason?: string | null;
  commentId?: string | null;
  staleTarget?: RequestConfirmationTarget | null;
}

export interface IssueFinalDeliveryArtifact {
  id?: string | null;
  type: string;
  title: string;
  url?: string | null;
  summary?: string | null;
  isPrimary: boolean;
}

export interface IssueFinalDeliveryPayload {
  version: 1;
  destination: IssueFinalDeliveryDestination;
  issue: {
    id: string;
    identifier?: string | null;
    title: string;
  };
  message: {
    format: "markdown";
    body: string;
  };
  artifacts: IssueFinalDeliveryArtifact[];
  queuedAt?: string;
}

export interface IssueFinalDeliveryResult {
  version: 1;
  outcome: "sending" | "delivered" | "failed" | "skipped";
  deliveredAt?: string | null;
  externalMessageId?: string | null;
  error?: string | null;
  attemptCount?: number;
  lastAttemptAt?: string | null;
  nextAttemptAt?: string | null;
  retryable?: boolean;
  terminal?: boolean;
  claimToken?: string | null;
  claimedAt?: string | null;
  claimExpiresAt?: string | null;
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

export interface FinalDeliveryInteraction extends IssueThreadInteractionBase {
  kind: "final_delivery";
  payload: IssueFinalDeliveryPayload;
  result?: IssueFinalDeliveryResult | null;
}

export type IssueThreadInteraction =
  | SuggestTasksInteraction
  | AskUserQuestionsInteraction
  | RequestConfirmationInteraction
  | FinalDeliveryInteraction;

export type IssueThreadInteractionPayload =
  | SuggestTasksPayload
  | AskUserQuestionsPayload
  | RequestConfirmationPayload
  | IssueFinalDeliveryPayload;

export type IssueThreadInteractionResult =
  | SuggestTasksResult
  | AskUserQuestionsResult
  | RequestConfirmationResult
  | IssueFinalDeliveryResult;

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
