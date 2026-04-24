import type {
  AgentRole,
  IssueBoardStateKind,
  IssueExecutionDecisionOutcome,
  IssueExecutionPolicyMode,
  IssueExecutionStageType,
  IssueWorkflowArtifactKind,
  IssueWorkflowLanePhase,
  IssueWorkflowLaneRole,
  IssueWorkflowTemplateKey,
  IssueExecutionStateStatus,
  IssueNextActionType,
  IssueRecoveryDisposition,
  IssueOriginKind,
  IssueRoutineExecutionRole,
  IssuePriority,
  IssueWorkIntent,
  IssueStallReasonCode,
  IssueStatus,
  IssueRelationType,
} from "../constants.js";
import type { Goal } from "./goal.js";
import type { Project, ProjectWorkspace } from "./project.js";
import type { ExecutionWorkspace, IssueExecutionWorkspaceSettings } from "./workspace-runtime.js";
import type { IssueWorkProduct, IssueWorkProductType } from "./work-product.js";

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
}

export interface IssueRelation {
  id: string;
  companyId: string;
  issueId: string;
  relatedIssueId: string;
  type: IssueRelationType;
  relatedIssue: IssueRelationIssueSummary;
}

export interface IssueRecoveryTransition {
  successorIssueId: string;
  disposition: IssueRecoveryDisposition;
}

export interface IssueBoardStateAction {
  type: IssueNextActionType;
  label: string;
  targetEntity: "issue" | "agent";
  targetId: string;
}

export interface IssueBoardState {
  kind: IssueBoardStateKind;
  headline: string;
  reasonCode: IssueStallReasonCode | null;
  actorType: "issue" | "agent" | "board" | "system" | null;
  actorId: string | null;
  primaryAction: IssueBoardStateAction | null;
}

export interface IssuePrimaryBlocker {
  issueId: string;
  identifier: string | null;
  title: string;
  blockedIssueCount: number;
  pathLength: number;
}

export interface IssueRootBlocker extends IssuePrimaryBlocker {}

export interface IssueBlockerPathNode {
  issueId: string;
  identifier: string | null;
  title: string;
  status: IssueStatus;
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
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

export interface IssueExecutionPolicy {
  mode: IssueExecutionPolicyMode;
  commentRequired: boolean;
  stages: IssueExecutionStage[];
}

export interface IssueExecutionState {
  status: IssueExecutionStateStatus;
  currentStageId: string | null;
  currentStageIndex: number | null;
  currentStageType: IssueExecutionStageType | null;
  currentParticipant: IssueExecutionStagePrincipal | null;
  returnAssignee: IssueExecutionStagePrincipal | null;
  completedStageIds: string[];
  lastDecisionId: string | null;
  lastDecisionOutcome: IssueExecutionDecisionOutcome | null;
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

export type IssueQaReviewDimension = "pass" | "warn" | "fail" | "na" | "unknown";
export type IssueQaReviewOverall = "pass" | "warn" | "fail" | "unknown";
export type IssueQaGateReasonCode =
  | "invalid_status_transition"
  | "qa_gate_requires_qa_assignee"
  | "qa_gate_no_eligible_qa_agent"
  | "qa_gate_requires_in_review"
  | "qa_gate_missing_qa_comment"
  | "qa_gate_missing_qa_summary"
  | "qa_gate_missing_test_coverage_verdict"
  | "qa_gate_missing_qa_pass"
  | "qa_gate_missing_release_confirmation"
  | "qa_gate_missing_verification"
  | "qa_gate_failing_review"
  | "qa_gate_failing_verification";

export type IssueCommentPublicationStatus =
  | "not_applicable"
  | "satisfied"
  | "retry_queued"
  | "retry_exhausted";

export type IssueMergeState =
  | "not_applicable"
  | "pending"
  | "ready"
  | "blocked"
  | "merged";

export interface IssueMergeStatus {
  enabled: boolean;
  state: IssueMergeState;
  targetBranch: string | null;
  sourceBranch: string | null;
  repoRoot: string | null;
  reason: string | null;
  mergedCommit: string | null;
  mergedAt: Date | null;
  lastAttemptedAt: Date | null;
  lastIssueCommentStatus: IssueCommentPublicationStatus | null;
  createdByRuntime: boolean | null;
  branchProvenanceSource: string | null;
}
export interface IssueQaReviewState {
  codeQuality: IssueQaReviewDimension;
  errorHandling: IssueQaReviewDimension;
  testCoverage: IssueQaReviewDimension;
  commentQuality: IssueQaReviewDimension;
  docsImpact: IssueQaReviewDimension;
  overall: IssueQaReviewOverall;
  stale: boolean;
  latestDecisionOutcome: IssueExecutionDecisionOutcome | null;
}

export interface IssueQaGate {
  isDeliveryScoped: boolean;
  canShip: boolean;
  missingRequirements: IssueQaGateReasonCode[];
  lastQaSummaryAt: Date | null;
  review: IssueQaReviewState;
}

export interface IssueWorkflowArtifactRequirement {
  key: string;
  label: string;
  kind: IssueWorkflowArtifactKind;
  blocking: boolean;
  documentKey?: string | null;
  workProductTypes?: IssueWorkProductType[] | null;
  commentMarkers?: string[] | null;
}

export interface IssueWorkflowArtifactStatus {
  key: string;
  label: string;
  kind: IssueWorkflowArtifactKind;
  blocking: boolean;
  satisfied: boolean;
  stale: boolean;
  detail: string | null;
}

export interface IssueWorkflowLaneSummary {
  issueId: string | null;
  role: IssueWorkflowLaneRole;
  title: string;
  status: IssueStatus | "missing";
  phase: IssueWorkflowLanePhase;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  workspaceMode: string | null;
  blockedByRoles: IssueWorkflowLaneRole[];
  ready: boolean;
  unresolvedOwnership: boolean;
  artifactStatuses: IssueWorkflowArtifactStatus[];
  blockingReasons: string[];
}

export interface IssueWorkflowSummary {
  templateKey: IssueWorkflowTemplateKey;
  isBlocked: boolean;
  blockingReasons: string[];
  activeRoles: IssueWorkflowLaneRole[];
  waitingRoles: IssueWorkflowLaneRole[];
  ownerNeededRoles: IssueWorkflowLaneRole[];
  lanes: IssueWorkflowLaneSummary[];
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
  priority: IssuePriority;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  workIntent?: IssueWorkIntent | null;
  qaReviewerAgentId?: string | null;
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
  routineBoundRunId?: string | null;
  routineIssueRole?: IssueRoutineExecutionRole | null;
  requestDepth: number;
  billingCode: string | null;
  assigneeAdapterOverrides: IssueAssigneeAdapterOverrides | null;
  executionPolicy?: IssueExecutionPolicy | null;
  executionState?: IssueExecutionState | null;
  executionWorkspaceId: string | null;
  executionWorkspacePreference: string | null;
  executionWorkspaceSettings: IssueExecutionWorkspaceSettings | null;
  workflowTemplateKey?: IssueWorkflowTemplateKey | null;
  workflowLaneRole?: AgentRole | IssueWorkflowLaneRole | null;
  workflowRequiredArtifacts?: IssueWorkflowArtifactRequirement[] | null;
  workflowInvalidatedAt?: Date | null;
  workflowArtifactStatus?: IssueWorkflowArtifactStatus[] | null;
  workflowSummary?: IssueWorkflowSummary | null;
  startedAt: Date | null;
  completedAt: Date | null;
  cancelledAt: Date | null;
  hiddenAt: Date | null;
  labelIds?: string[];
  labels?: IssueLabel[];
  blockedBy?: IssueRelationIssueSummary[];
  blocks?: IssueRelationIssueSummary[];
  recoverySource?: IssueRelationIssueSummary | null;
  recoverySuccessor?: IssueRelationIssueSummary | null;
  boardState?: IssueBoardState | null;
  primaryBlocker?: IssuePrimaryBlocker | null;
  rootBlockers?: IssueRootBlocker[];
  blockerPath?: IssueBlockerPathNode[];
  planDocument?: IssueDocument | null;
  documentSummaries?: IssueDocumentSummary[];
  legacyPlanDocument?: LegacyPlanDocument | null;
  project?: Project | null;
  goal?: Goal | null;
  currentExecutionWorkspace?: ExecutionWorkspace | null;
  workProducts?: IssueWorkProduct[];
  reviewItems?: IssueReviewItem[];
  reviewPackSurface?: IssueReviewPackSurface | null;
  mentionedProjects?: Project[];
  myLastTouchAt?: Date | null;
  lastExternalCommentAt?: Date | null;
  lastActivityAt?: Date | null;
  isUnreadForMe?: boolean;
  qaGate?: IssueQaGate | null;
  mergeStatus?: IssueMergeStatus | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface IssueComment {
  id: string;
  companyId: string;
  issueId: string;
  authorAgentId: string | null;
  authorUserId: string | null;
  body: string;
  createdAt: Date;
  updatedAt: Date;
}

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

export type IssueReviewItemGroup = "review_now" | "references" | "hidden_context";

export type IssueReviewItemKind =
  | "image"
  | "file"
  | "document"
  | "marketplace_link"
  | "work_product"
  | "generic_link"
  | "missing";

export type IssueReviewItemPreviewState = "ready" | "partial" | "missing" | "unsupported";

export type IssueReviewItemStatus = "new" | "reviewed" | "stale" | "unavailable";

export type IssueReviewItemSourceType =
  | "issue_description"
  | "issue_comment"
  | "attachment"
  | "document"
  | "work_product";

export interface IssueReviewItemSourceRef {
  sourceType: IssueReviewItemSourceType;
  sourceId: string;
  commentId?: string | null;
  authorAgentId?: string | null;
  authorUserId?: string | null;
  createdAt: Date;
}

export interface IssueReviewItemResolvedTarget {
  url?: string | null;
  path?: string | null;
  attachmentId?: string | null;
  documentKey?: string | null;
  workProductId?: string | null;
}

export interface IssueReviewItem {
  id: string;
  kind: IssueReviewItemKind;
  group: IssueReviewItemGroup;
  title: string;
  subtitle: string | null;
  summary: string | null;
  previewState: IssueReviewItemPreviewState;
  status: IssueReviewItemStatus;
  thumbnailUrl: string | null;
  resolvedTarget: IssueReviewItemResolvedTarget;
  sourceRefs: IssueReviewItemSourceRef[];
  mentionCount: number;
  metadata: Record<string, unknown> | null;
}

export type IssueReviewHintSeverity = "info" | "warning" | "critical";

export interface IssueReviewHint {
  code: string;
  label: string;
  severity: IssueReviewHintSeverity;
  detail: string | null;
}

export type IssueReviewActionTargetType = "item" | "issue" | "agent" | "comment";

export interface IssueReviewActionTarget {
  type: IssueReviewActionTargetType;
  value: string;
}

export type IssueReviewPackStatus = "ready" | "warning" | "blocked" | "reviewed";

export interface IssueReviewPack {
  id: string;
  title: string;
  summary: string | null;
  reason: string;
  primaryItemIds: string[];
  evidenceItemIds: string[];
  warningCodes: string[];
  hints: IssueReviewHint[];
  status: IssueReviewPackStatus;
  nextActionLabel: string | null;
  nextActionTarget: IssueReviewActionTarget | null;
  mentionCount: number;
  sourceRefs: IssueReviewItemSourceRef[];
}

export interface IssueReviewBlocker {
  id: string;
  title: string;
  summary: string | null;
  actionLabel: string | null;
  actionTarget: IssueReviewActionTarget | null;
  severity: IssueReviewHintSeverity;
}

export interface IssueReviewPackSurface {
  blockers: IssueReviewBlocker[];
  heroPack: IssueReviewPack | null;
  queue: IssueReviewPack[];
  evidence: string[];
}

export type IssueFilePreviewKind = "text" | "image" | "unsupported" | "missing";

export interface IssueFilePreview {
  path: string;
  absolutePath: string | null;
  exists: boolean;
  kind: IssueFilePreviewKind;
  contentType: string | null;
  byteSize: number | null;
  snippet: string | null;
  contentPath: string | null;
}
