import type { IssueStatus, IssueExecutionStageType } from "./constants.js";

export const ISSUE_FINAL_DISPOSITION_VALUES = [
  "done",
  "blocked",
  "needs_fix",
  "needs_review",
  "needs_qa",
  "needs_approval",
  "duplicate",
  "superseded",
  "not_actionable",
] as const;
export type IssueFinalDisposition = (typeof ISSUE_FINAL_DISPOSITION_VALUES)[number];

export const ISSUE_DISPOSITION_SOURCE_CLASSES = [
  "agent",
  "user",
  "system",
  "reviewer",
  "qa_reviewer",
  "approval_owner",
] as const;
export type IssueDispositionSourceClass = (typeof ISSUE_DISPOSITION_SOURCE_CLASSES)[number];

export const ISSUE_DISPOSITION_PREVIEW_LABELS: Record<IssueFinalDisposition, string> = {
  done: "Done",
  blocked: "Blocked",
  needs_fix: "Needs Fix",
  needs_review: "Needs Review",
  needs_qa: "Needs QA",
  needs_approval: "Needs Approval",
  duplicate: "Duplicate",
  superseded: "Superseded",
  not_actionable: "Not Actionable",
};

export const ISSUE_DISPOSITION_PARENT_BLOCKER_INTENTIONS = [
  "none",
  "create_or_reuse_fix_subtask",
  "request_review",
  "request_qa_review",
  "request_approval",
  "remove_from_parent_blockers",
  "replace_with_canonical_issue",
  "replace_with_successor",
] as const;
export type IssueDispositionParentBlockerIntention = (typeof ISSUE_DISPOSITION_PARENT_BLOCKER_INTENTIONS)[number];

export const ISSUE_DISPOSITION_EVIDENCE_REF_KINDS = [
  "comment",
  "document",
  "issue",
  "run",
  "approval",
  "event",
  "external",
] as const;
export type IssueDispositionEvidenceRefKind = (typeof ISSUE_DISPOSITION_EVIDENCE_REF_KINDS)[number];

export const ISSUE_FINAL_DISPOSITION_SOURCES = [
  "agent_comment",
  "qa_verdict",
  "review_verdict",
  "approval_decision",
  "release_preflight",
  "recovery_classifier",
  "manual",
] as const;
export type IssueFinalDispositionSource = (typeof ISSUE_FINAL_DISPOSITION_SOURCES)[number];

export const ISSUE_DISPOSITION_USEFUL_OUTPUT_CLASSES = [
  "useful_output",
  "failed_with_useful_output",
  "successful_run_missing_state",
  "no_useful_output",
  "unknown",
] as const;
export type IssueDispositionUsefulOutputClass = (typeof ISSUE_DISPOSITION_USEFUL_OUTPUT_CLASSES)[number];

export const ISSUE_DISPOSITION_VERDICTS = ["pass", "fail", "request_changes", "pending", "not_applicable"] as const;
export type IssueDispositionVerdict = (typeof ISSUE_DISPOSITION_VERDICTS)[number];

export const ISSUE_DISPOSITION_NEXT_GATE_KINDS = [
  "qa",
  "review",
  "fix",
  "revalidation",
  "release_candidate",
  "approval",
  "release_hold",
  "spend_hold",
  "recovery",
  "done",
] as const;
export type IssueDispositionNextGateKind = (typeof ISSUE_DISPOSITION_NEXT_GATE_KINDS)[number];

export const ISSUE_DISPOSITION_PROJECTION_FRESHNESS_STATES = ["fresh", "stale", "rebuilding", "error"] as const;
export type IssueDispositionProjectionFreshnessState = (typeof ISSUE_DISPOSITION_PROJECTION_FRESHNESS_STATES)[number];

export const ISSUE_DISPOSITION_PROJECTION_FIELD_NAMES = [
  "finalDisposition",
  "finalDispositionSource",
  "usefulOutputClass",
  "canonicalBlockerGraph",
  "nextGate",
  "evidenceChain",
  "reviewVerdict",
  "qaVerdict",
  "recoveryDedupKey",
  "projectionFreshness",
] as const;
export type IssueDispositionProjectionFieldName = (typeof ISSUE_DISPOSITION_PROJECTION_FIELD_NAMES)[number];

export interface IssueDispositionEvidenceRefComment {
  kind: "comment";
  id: string;
  sourceRunId?: string | null;
}

export interface IssueDispositionEvidenceRefDocument {
  kind: "document";
  id: string;
  revisionId?: string | null;
}

export interface IssueDispositionEvidenceRefIssue {
  kind: "issue";
  id: string;
}

export interface IssueDispositionEvidenceRefRun {
  kind: "run";
  id: string;
}

export interface IssueDispositionEvidenceRefApproval {
  kind: "approval";
  id: string;
}

export interface IssueDispositionEvidenceRefEvent {
  kind: "event";
  id: string;
}

export interface IssueDispositionEvidenceRefExternal {
  kind: "external";
  uri: string;
  label?: string | null;
}

export type IssueDispositionEvidenceRef =
  | IssueDispositionEvidenceRefComment
  | IssueDispositionEvidenceRefDocument
  | IssueDispositionEvidenceRefIssue
  | IssueDispositionEvidenceRefRun
  | IssueDispositionEvidenceRefApproval
  | IssueDispositionEvidenceRefEvent
  | IssueDispositionEvidenceRefExternal;

export interface IssueDispositionFinding {
  id: string;
  severity: "blocker" | "major" | "minor";
  area: string;
  summary: string;
  evidenceRefs: IssueDispositionEvidenceRef[];
  acceptance: string;
}

export const ISSUE_DISPOSITION_FINDING_BUNDLE_KINDS = ["review", "qa"] as const;
export type IssueDispositionFindingBundleKind = (typeof ISSUE_DISPOSITION_FINDING_BUNDLE_KINDS)[number];

export interface IssueDispositionFindingBundle {
  kind: IssueDispositionFindingBundleKind;
  summary: string;
  findings: IssueDispositionFinding[];
}

export interface IssueDispositionActorRef {
  type: "agent" | "user" | "system";
  id?: string | null;
}

export interface IssueFinalDispositionRecord {
  value: IssueFinalDisposition;
  setAt: string;
  setByActor: IssueDispositionActorRef;
  sourceRunId?: string | null;
  sourceCommentId?: string | null;
  reason?: string | null;
  evidenceRefs: IssueDispositionEvidenceRef[];
  findingBundles?: IssueDispositionFindingBundle[];
  idempotencyKey: string;
  supersededBy?: {
    value: IssueFinalDisposition;
    setAt: string;
    sourceCommentId?: string | null;
  } | null;
}

export interface IssueDispositionCanonicalBlockerGraph {
  canonicalBlockerId?: string | null;
  coveredBlockerIds: string[];
  staleBlockerIds: string[];
  supersededBlockerIds: string[];
  parentExplanation?: string | null;
}

export interface IssueDispositionNextGate {
  kind: IssueDispositionNextGateKind;
  ownerAgentId?: string | null;
  ownerUserId?: string | null;
  action: string;
  evidenceRequired: string[];
  approvalId?: string | null;
  releaseHoldKind?: string | null;
}

export interface IssueDispositionEvidenceChainItem {
  id: string;
  source: IssueFinalDispositionSource;
  evidence: IssueDispositionEvidenceRef;
  gateDriving: boolean;
  redacted?: boolean;
}

export interface IssueDispositionProjectionFreshness {
  generatedAt: string;
  sourceEventCursor: string;
  staleMs: number;
  rebuildState: IssueDispositionProjectionFreshnessState;
}

export interface IssueDispositionProjection {
  finalDisposition: IssueFinalDisposition | null;
  finalDispositionSource: IssueFinalDispositionSource | null;
  usefulOutputClass: IssueDispositionUsefulOutputClass;
  canonicalBlockerGraph: IssueDispositionCanonicalBlockerGraph;
  nextGate: IssueDispositionNextGate;
  evidenceChain: IssueDispositionEvidenceChainItem[];
  reviewVerdict: IssueDispositionVerdict;
  qaVerdict: IssueDispositionVerdict;
  recoveryDedupKey: string | null;
  projectionFreshness: IssueDispositionProjectionFreshness;
}

export interface IssueDispositionTransitionInput {
  actorType: "agent" | "user" | "system";
  existingStatus: IssueStatus;
  nextDisposition: IssueFinalDisposition;
  hasReviewPath?: boolean;
  hasQaPath?: boolean;
  hasApprovalPath?: boolean;
  hasParentBlocker?: boolean;
  hasApprovedReviewDecisions?: boolean;
  hasApprovedApprovalDecisions?: boolean;
  hasFirstClassBlocker?: boolean;
  hasPriorChangesRequestedDecision?: boolean;
  hasCanonicalIssueRef?: boolean;
  hasSuccessorRef?: boolean;
  hasCauseClassification?: boolean;
}

export interface IssueDispositionTransitionIntention {
  targetStatus: IssueStatus;
  targetExecutionStageType?: IssueExecutionStageType | null;
  parentBlockerIntention: IssueDispositionParentBlockerIntention;
  previewLabel: string;
  sourceClass: IssueDispositionSourceClass;
}

export type IssueDispositionTransitionMissingPrecondition =
  | "review_path"
  | "qa_path"
  | "approval_path"
  | "approved_review_decisions"
  | "approved_approval_decisions"
  | "first_class_blocker"
  | "prior_changes_requested_decision"
  | "canonical_issue_ref"
  | "successor_ref"
  | "cause_classification";

export interface IssueDispositionTransitionError {
  ok: false;
  code: "invalid_disposition_transition";
  message: string;
  disposition: IssueFinalDisposition;
  validFromStatuses: ReadonlyArray<IssueStatus>;
  missing?: IssueDispositionTransitionMissingPrecondition;
}

export interface IssueDispositionIdempotencyKeyInput {
  issueId: string;
  sourceRunId: string;
  dispositionValue: IssueFinalDisposition;
}
export type IssueDispositionIdempotencyKey = IssueDispositionIdempotencyKeyInput;

export type IssueDispositionTransitionResult =
  | { ok: true; intention: IssueDispositionTransitionIntention }
  | IssueDispositionTransitionError;

type AgentInReviewDispositionInput = {
  actorType: "agent" | "user";
  existingStatus: IssueStatus;
  nextStatus: IssueStatus;
  nextAssigneeUserId: string | null;
  hasTypedExecutionParticipant: boolean;
  hasScheduledMonitor: boolean;
  hasPendingInteraction: boolean;
  hasPendingApproval: boolean;
};

type AgentInReviewDispositionValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: "invalid_issue_disposition";
      missing: "review_path";
      validReviewPaths: readonly string[];
      message: string;
    };

export const INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE =
  "invalid_issue_disposition: Agent-authored updates that move an issue to in_review must include a real review path. " +
  "This request would leave the issue in_review without anyone or anything owning the next action. " +
  "Keep working instead of moving to review, create a request_confirmation or ask_user_questions interaction, " +
  "link or request a pending approval, assign a human reviewer with assigneeUserId, set a typed executionState.currentParticipant through an execution policy, " +
  "or schedule an issue monitor for an external review/check. After creating one of those review paths, retry the status update.";

export const AGENT_IN_REVIEW_VALID_REVIEW_PATHS = [
  "pending_issue_thread_interaction",
  "linked_pending_approval",
  "human_assignee_user_id",
  "typed_execution_state_current_participant",
  "scheduled_issue_monitor",
] as const;

const TRANSITION_TABLE: Record<IssueFinalDisposition, {
  targetStatus: IssueStatus;
  targetExecutionStageType: IssueExecutionStageType | null;
  parentBlockerIntention: IssueDispositionParentBlockerIntention;
  validFromStatuses: IssueStatus[];
  requiredPath?: "review" | "qa" | "approval";
  sourceClass: IssueDispositionSourceClass;
  previewLabel: string;
}> = {
  done: {
    targetStatus: "done",
    targetExecutionStageType: null,
    parentBlockerIntention: "remove_from_parent_blockers",
    validFromStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
    sourceClass: "system",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.done,
  },
  blocked: {
    targetStatus: "blocked",
    targetExecutionStageType: null,
    parentBlockerIntention: "none",
    validFromStatuses: ["in_progress", "in_review", "blocked", "todo", "backlog"],
    sourceClass: "user",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.blocked,
  },
  needs_fix: {
    targetStatus: "in_progress",
    targetExecutionStageType: null,
    parentBlockerIntention: "create_or_reuse_fix_subtask",
    validFromStatuses: ["in_progress", "in_review", "blocked", "todo", "backlog"],
    sourceClass: "user",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.needs_fix,
  },
  needs_review: {
    targetStatus: "in_review",
    targetExecutionStageType: "review",
    parentBlockerIntention: "request_review",
    validFromStatuses: ["in_progress", "in_review", "blocked", "todo", "backlog"],
    requiredPath: "review",
    sourceClass: "reviewer",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.needs_review,
  },
  needs_qa: {
    targetStatus: "in_review",
    targetExecutionStageType: "review",
    parentBlockerIntention: "request_qa_review",
    validFromStatuses: ["in_progress", "in_review", "blocked", "todo", "backlog"],
    requiredPath: "qa",
    sourceClass: "qa_reviewer",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.needs_qa,
  },
  needs_approval: {
    targetStatus: "in_review",
    targetExecutionStageType: "approval",
    parentBlockerIntention: "request_approval",
    validFromStatuses: ["in_progress", "in_review", "blocked", "todo", "backlog"],
    requiredPath: "approval",
    sourceClass: "approval_owner",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.needs_approval,
  },
  duplicate: {
    targetStatus: "cancelled",
    targetExecutionStageType: null,
    parentBlockerIntention: "replace_with_canonical_issue",
    validFromStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
    sourceClass: "system",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.duplicate,
  },
  superseded: {
    targetStatus: "cancelled",
    targetExecutionStageType: null,
    parentBlockerIntention: "replace_with_successor",
    validFromStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
    sourceClass: "system",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.superseded,
  },
  not_actionable: {
    targetStatus: "cancelled",
    targetExecutionStageType: null,
    parentBlockerIntention: "remove_from_parent_blockers",
    validFromStatuses: ["backlog", "todo", "in_progress", "in_review", "blocked"],
    sourceClass: "system",
    previewLabel: ISSUE_DISPOSITION_PREVIEW_LABELS.not_actionable,
  },
};

export function validateAgentInReviewDisposition(
  input: AgentInReviewDispositionInput,
): AgentInReviewDispositionValidationResult {
  if (input.actorType !== "agent" || input.existingStatus === "in_review" || input.nextStatus !== "in_review") {
    return { ok: true };
  }
  if (typeof input.nextAssigneeUserId === "string" && input.nextAssigneeUserId.trim().length > 0) return { ok: true };
  if (input.hasTypedExecutionParticipant) return { ok: true };
  if (input.hasScheduledMonitor) return { ok: true };
  if (input.hasPendingInteraction) return { ok: true };
  if (input.hasPendingApproval) return { ok: true };
  return {
    ok: false,
    code: "invalid_issue_disposition",
    missing: "review_path",
    validReviewPaths: AGENT_IN_REVIEW_VALID_REVIEW_PATHS,
    message: INVALID_AGENT_IN_REVIEW_DISPOSITION_MESSAGE,
  };
}

function buildPreconditionError(
  input: IssueDispositionTransitionInput,
  transition: { validFromStatuses: IssueStatus[] },
  missing: IssueDispositionTransitionMissingPrecondition,
  message: string,
): IssueDispositionTransitionError {
  return {
    ok: false,
    code: "invalid_disposition_transition",
    message,
    disposition: input.nextDisposition,
    validFromStatuses: transition.validFromStatuses,
    missing,
  };
}

export function evaluateDispositionTransition(input: IssueDispositionTransitionInput): IssueDispositionTransitionResult {
  const transition = TRANSITION_TABLE[input.nextDisposition];

  if (!transition.validFromStatuses.includes(input.existingStatus)) {
    return {
      ok: false,
      code: "invalid_disposition_transition",
      message: `Cannot move from ${input.existingStatus} to disposition ${input.nextDisposition}.`,
      disposition: input.nextDisposition,
      validFromStatuses: transition.validFromStatuses,
    };
  }

  switch (input.nextDisposition) {
    case "done": {
      if (!input.hasApprovedReviewDecisions) {
        return buildPreconditionError(
          input,
          transition,
          "approved_review_decisions",
          "Disposition done requires every review stage to have an approved decision.",
        );
      }
      if (!input.hasApprovedApprovalDecisions) {
        return buildPreconditionError(
          input,
          transition,
          "approved_approval_decisions",
          "Disposition done requires every approval stage to have an approved decision.",
        );
      }
      break;
    }
    case "blocked": {
      if (!input.hasFirstClassBlocker) {
        return buildPreconditionError(
          input,
          transition,
          "first_class_blocker",
          "Disposition blocked requires at least one first-class blocker reference.",
        );
      }
      break;
    }
    case "needs_fix": {
      if (!input.hasPriorChangesRequestedDecision) {
        return buildPreconditionError(
          input,
          transition,
          "prior_changes_requested_decision",
          "Disposition needs_fix requires a prior review/QA changes_requested decision.",
        );
      }
      break;
    }
    case "needs_review": {
      if (!input.hasReviewPath) {
        return buildPreconditionError(
          input,
          transition,
          "review_path",
          `Disposition ${input.nextDisposition} requires a review path.`,
        );
      }
      break;
    }
    case "needs_qa": {
      if (!input.hasQaPath) {
        return buildPreconditionError(
          input,
          transition,
          "qa_path",
          `Disposition ${input.nextDisposition} requires a QA review path.`,
        );
      }
      break;
    }
    case "needs_approval": {
      if (!input.hasApprovalPath) {
        return buildPreconditionError(
          input,
          transition,
          "approval_path",
          `Disposition ${input.nextDisposition} requires an approval path.`,
        );
      }
      break;
    }
    case "duplicate": {
      if (!input.hasCanonicalIssueRef) {
        return buildPreconditionError(
          input,
          transition,
          "canonical_issue_ref",
          "Disposition duplicate requires a canonical issue reference.",
        );
      }
      break;
    }
    case "superseded": {
      if (!input.hasSuccessorRef) {
        return buildPreconditionError(
          input,
          transition,
          "successor_ref",
          "Disposition superseded requires a successor issue or document revision reference.",
        );
      }
      break;
    }
    case "not_actionable": {
      if (!input.hasCauseClassification) {
        return buildPreconditionError(
          input,
          transition,
          "cause_classification",
          "Disposition not_actionable requires a cause classification.",
        );
      }
      break;
    }
  }

  return {
    ok: true,
    intention: {
      targetStatus: transition.targetStatus,
      targetExecutionStageType: transition.targetExecutionStageType,
      parentBlockerIntention: transition.parentBlockerIntention,
      previewLabel: transition.previewLabel,
      sourceClass: transition.sourceClass,
    },
  };
}

export const ISSUE_DISPOSITION_IDEMPOTENCY_PREFIX = "disposition" as const;

export function buildIssueDispositionIdempotencyKey(input: IssueDispositionIdempotencyKeyInput): string {
  const safeIssueId = encodeURIComponent(input.issueId);
  const safeSourceRunId = encodeURIComponent(input.sourceRunId);
  const safeDispositionValue = encodeURIComponent(input.dispositionValue);
  return `${ISSUE_DISPOSITION_IDEMPOTENCY_PREFIX}:${safeIssueId}:${safeSourceRunId}:${safeDispositionValue}`;
}

export function parseIssueDispositionIdempotencyKey(key: string): {
  issueId: string;
  sourceRunId: string;
  dispositionValue: IssueFinalDisposition;
} | null {
  const [prefix, issueId, sourceRunId, dispositionValue] = key.split(":");
  if (prefix !== ISSUE_DISPOSITION_IDEMPOTENCY_PREFIX) return null;
  if (!issueId || !sourceRunId || !dispositionValue) return null;
  if (!isIssueFinalDisposition(dispositionValue)) return null;
  return {
    issueId: decodeURIComponent(issueId),
    sourceRunId: decodeURIComponent(sourceRunId),
    dispositionValue,
  };
}

export function issueDispositionPreviewLabel(disposition: IssueFinalDisposition): string {
  return ISSUE_DISPOSITION_PREVIEW_LABELS[disposition];
}

export function isIssueFinalDisposition(value: string): value is IssueFinalDisposition {
  return ISSUE_FINAL_DISPOSITION_VALUES.includes(value as IssueFinalDisposition);
}

export function isIssueDispositionSourceClass(value: string): value is IssueDispositionSourceClass {
  return ISSUE_DISPOSITION_SOURCE_CLASSES.includes(value as IssueDispositionSourceClass);
}
