import { COMPLETION_REVIEW_STAGE_REASON, COMPLETION_REVIEW_STAGE_REJECTED_REASON, type CompletionReviewStageEntry } from "../issue-execution-policy.js";
import type { NativeEvidenceAssessment } from "./evidence-classifier.js";
import type { IssueUnblockDescriptor } from "@paperclipai/shared";
import { NATIVE_MODEL_REJECTION_MESSAGE, NATIVE_PROVIDER_CAPACITY_MAX_RETRIES, NATIVE_PROVIDER_OVERLOADED_CODE, NATIVE_PROVIDER_OVERLOADED_MESSAGE } from "./native-provider-failure.js";
import { NATIVE_TOOL_RECEIPT_LIMIT_CODE, NATIVE_TOOL_RECEIPT_LIMIT_MAX_CONTINUATIONS } from "./native-tool-receipt-limit.js";
import { NATIVE_ENVIRONMENT_BLOCKER_CODE, NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_ACTION, NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE,
  NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES } from "./native-environment-blocker.js";
import { planNotProducedDecision } from "./plan-mode-status.js";
import { NATIVE_AGENT_BLOCKER_CONTINUATION_CODE, NATIVE_AGENT_BLOCKER_HANDOFF_CODE,
  NATIVE_AGENT_BLOCKER_MAX_CONTINUATIONS, NATIVE_AGENT_BLOCKER_MAX_PROGRESS_CONTINUATIONS,
  NATIVE_AGENT_BLOCKER_SPLIT_CODE, nativeAgentBlockerSplitAction } from "./native-agent-blocker.js";

export const NATIVE_STATUS_ARBITER_POLICY_VERSION = "phase6-v14";

/** The automatic continuation after a failed turn is used once per chain. */
export const NATIVE_RUN_FAILED_RETRY_CAUSE = "native_run_failed";
export const NATIVE_RESPONSE_WAKE_WAITING_REASON = "response_wake_waiting_for_input";
export const NATIVE_BLOCKER_SUPERSEDED_BY_QUEUED_REQUEST_CODE = "native_blocker_superseded_by_queued_request";
export const NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION =
  "The agent's turn failed again after Paperclip continued it automatically. The saved work is kept. Check the failed run, then Retry the task.";

export type NativeAuthoritativeIssueStatus =
  | "backlog"
  | "todo"
  | "in_progress"
  | "in_review"
  | "blocked"
  | "done"
  | "cancelled";

export type NativeGovernanceGate = {
  kind: "approval" | "interaction" | "execution_stage";
  id: string;
};

export type NativeStatusEffect =
  | { kind: "create_interaction"; gate?: NativeGovernanceGate; prompt?: string }
  | {
      kind: "bind_reviewer";
      requestKey?: string;
      prompt: string;
      detailsMarkdown?: string | null;
      ownerUserId?: string | null;
      ownerAgentId?: string | null;
    }
  | { kind: "notify_owner"; agentId: string; reason: string }
  | {
      kind: "enqueue_continuation";
      continuationKind:
        | "same_agent"
        | "retry"
        | "delegated_issue"
        | "response_wake"
        | "monitor";
      summary: string;
      idempotencyKey: string;
      agentId: string;
    }
  | {
      kind: "bind_blocker";
      owner: IssueUnblockDescriptor["owner"];
      action: string;
    }
  | { kind: "schedule_retry"; cause: string; summary: string; agentId: string; progressNextAction?: string }
  | {
      kind: "record_finalization_error";
      cause: string;
      nextAction: string;
      agentId: string;
    }
  | { kind: "release_run_resources" }
  | { kind: "create_delegated_issue"; agentId: string; summary: string }
  | { kind: "accept_replacement_turn" }
  | { kind: "cancel_continuations" }
  | { kind: "append_superseding_assessment" }
  | { kind: "dispatch_pending_effect" }
  | { kind: "increment_status_version" }
  | { kind: "schedule_reconciliation" }
  | { kind: "record_shadow_decision" }
  | { kind: "render_four_layers" }
  | { kind: "materialize_contract" }
  | { kind: "record_mode_labeled_divergence" }
  | { kind: "record_mode_native" }
  | { kind: "record_policy_version" }
  | { kind: "finish_as_native" }
  | { kind: "resume_workspace_operation" }
  | { kind: "record_expiry" }
  | { kind: "record_stale_response" }
  | { kind: "link_canonical_request" }
  | {
      kind: "record_recovery";
      cause: string;
      nextAction: string;
      agentId: string;
    }
  | { kind: "release_checkout" };

export interface NativeStatusDecision {
  policyVersion: typeof NATIVE_STATUS_ARBITER_POLICY_VERSION;
  statusAction: NativeAuthoritativeIssueStatus | "preserve";
  toStatus: NativeAuthoritativeIssueStatus;
  reasonCode: string | null;
  unblockDescriptor: {
    owner: IssueUnblockDescriptor["owner"];
    action: string;
  } | null;
  effects: NativeStatusEffect[];
  blockerOwnerKind?: string;
  /** Hand the task to this agent when a blocked report names another agent owner. */
  handoffAgentId?: string;
}

function humanBlockerOwner(blocker: NativeEvidenceAssessment["blocker"]): IssueUnblockDescriptor["owner"] {
  return blocker?.ownerUserId ? { userId: blocker.ownerUserId } : "board";
}

/** Resolve the saved unblock owner and optional handoff target for a blocker. */
function resolveBlockerHandoff(blocker: NativeEvidenceAssessment["blocker"], agentId: string, handoffLocked?: boolean):
  { owner: IssueUnblockDescriptor["owner"]; handoffAgentId?: string; namedOtherAgent: boolean } {
  const raw = blocker?.ownerAgentId ? { agentId: blocker.ownerAgentId }
    : blocker?.boardOwned ? humanBlockerOwner(blocker) : { agentId };
  const namedOtherAgent = typeof raw === "object" && "agentId" in raw && raw.agentId !== agentId;
  if (!namedOtherAgent) return { owner: raw, namedOtherAgent: false };
  return handoffLocked ? { owner: "board", namedOtherAgent: true } : { owner: raw, handoffAgentId: raw.agentId, namedOtherAgent: true };
}

/**
 * Completion is the current owner's decision. A run whose task was reassigned
 * away (to another agent or to a user) keeps its accepted result as history,
 * but its done report cannot close the new owner's task.
 */
export function ownsNativeTaskCompletion(
  issue: { assigneeAgentId: string | null; assigneeUserId: string | null },
  agentId: string,
) {
  return issue.assigneeAgentId === agentId && !issue.assigneeUserId;
}

export function heldByAnotherRun(issue: { executionRunId?: string | null }, runId: string) {
  return Boolean(issue.executionRunId && issue.executionRunId !== runId);
}

/**
 * The configured review policy decides a Done exactly as the issue route does:
 * a stage that starts turns Done into its review, and a refused transition
 * keeps the task open with a recovery note. Every Done-producing path applies it.
 */
export function gateDoneOnConfiguredReview(
  decision: NativeStatusDecision,
  stage: CompletionReviewStageEntry,
  agentId: string,
): NativeStatusDecision {
  if (decision.statusAction !== "done" || stage.kind === "none") return decision;
  if (stage.kind === "starts") {
    return { ...decision, statusAction: "in_review", toStatus: "in_review", reasonCode: COMPLETION_REVIEW_STAGE_REASON,
      unblockDescriptor: null, effects: [{ kind: "release_checkout" }] };
  }
  return { ...decision, statusAction: "in_progress", toStatus: "in_progress", reasonCode: COMPLETION_REVIEW_STAGE_REJECTED_REASON,
    unblockDescriptor: null, effects: [{ kind: "release_checkout" }, { kind: "record_recovery", cause: COMPLETION_REVIEW_STAGE_REJECTED_REASON,
      nextAction: `The task's configured review policy cannot start its review: ${stage.message} Correct the review stages or participants; do not mark the task done.`,
      agentId }] };
}

export function supersedeStaleOwnerCompletion(
  decision: NativeStatusDecision,
  issue: { status: string; assigneeAgentId: string | null; assigneeUserId: string | null;
    executionRunId?: string | null },
  agentId: string,
  runId?: string,
): NativeStatusDecision {
  if (decision.statusAction !== "done" && decision.reasonCode !== COMPLETION_REVIEW_STAGE_REASON) return decision;
  const ownerSuperseded = !ownsNativeTaskCompletion(issue, agentId);
  if (!ownerSuperseded && !(runId && heldByAnotherRun(issue, runId))) return decision;
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: issue.status as NativeAuthoritativeIssueStatus,
    reasonCode: ownerSuperseded ? "completion_owner_superseded" : "completion_run_superseded",
    unblockDescriptor: null,
    effects: [],
  };
}

/**
 * Effects that give the outgoing agent more work on the task, wake it, or bind
 * a blocker or reviewer to the task. None of them is valid once the task
 * belongs to a person.
 */
const OUTGOING_AGENT_TASK_EFFECTS: ReadonlySet<NativeStatusEffect["kind"]> = new Set([
  "enqueue_continuation", "schedule_retry", "notify_owner", "record_recovery",
  "bind_blocker", "bind_reviewer", "create_delegated_issue", "accept_replacement_turn",
]);

/**
 * A run that handed its own task to a person keeps running and finishes its
 * turn. Its result is history: it cannot move the person's task, wake or
 * retry the outgoing agent, or bind a blocker to the task. This also applies
 * to decisions that already preserve the status.
 *
 * Two effects stay. A governed request still opens its interaction: the gate
 * belongs to the request, not to the task owner. A failed workspace
 * finalization still records its repair, so the run's saved work is not lost.
 */
export function supersedeHandedOffDecision(
  decision: NativeStatusDecision,
  issue: { status: string; assigneeAgentId: string | null; assigneeUserId: string | null },
): NativeStatusDecision {
  if (issue.assigneeAgentId !== null || !issue.assigneeUserId) return decision;
  // A finalization error only stays for a failed workspace save: it repairs
  // and re-runs the save of the run's work. Other causes are task recovery.
  const effects = decision.effects.filter(effect => !OUTGOING_AGENT_TASK_EFFECTS.has(effect.kind)
    && !(effect.kind === "record_finalization_error" && effect.cause !== "workspace_finalization_failed"));
  const governed = effects.some(effect => effect.kind === "create_interaction");
  if (decision.statusAction === "preserve" || governed) {
    const { handoffAgentId: _handoff, ...rest } = decision;
    return effects.length === decision.effects.length && !decision.handoffAgentId
      ? decision
      : { ...rest, effects };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: issue.status as NativeAuthoritativeIssueStatus,
    reasonCode: "completion_owner_superseded",
    unblockDescriptor: null,
    effects,
  };
}

/** Pure authority boundary: model prose is evidence, never a status command. */
export function arbitrateNativeStatus(input: {
  assessment: NativeEvidenceAssessment;
  terminalState: "succeeded" | "failed" | "cancelled";
  workspaceFinalizeStatus: "succeeded" | "failed";
  governanceGate?: NativeGovernanceGate | null;
  completionClaimPolicyAccepted?: boolean;
  /** Canonical exact-output human verdicts, only for an explicitly opted-in requirement. */
  requiredQualityReviewSatisfied?: boolean;
  allowIncompleteContinuation?: boolean;
  /**
   * True when the issue already has a durable unresolved dependency edge.
   * A "current_track" result cannot remain in_progress in that state because
   * checkout is intentionally gated until the dependency resolves.
   */
  hasUnresolvedIssueBlockers?: boolean;
  /** A newer native child result still has an undelivered parent wake. */
  hasPendingChildCompletion?: boolean;
  /** A governance interaction created by this run was accepted before the run settled. */
  governanceResolvedForRun?: boolean;
  externalChatResponseWaitAuthorization?:
    "authorized" | "revoked" | "not_applicable";
  hasUnprovenPreservedResultStatus?: boolean;
  publishedExternalReview?: boolean;
  /** Server-verified accepted plan request and normal provider terminal. */
  planWaitAuthorized?: boolean;
  /** A Plan-mode run settled with no unanswered plan revision to review. */
  planNotProduced?: boolean;
  monitorWaitAuthorized?: boolean;
  caseHandoffAuthorized?: boolean;
  /** The saved timer already admitted another run and this run no longer owns checkout. */
  monitorWaitDispatched?: boolean;
  monitorWaitPreserved?: boolean;
  monitorWaitSuperseded?: boolean;
  boardResponseWaitAuthorized?: boolean;
  boardResponseWaitOrigin?: boolean;
  isConversation?: boolean;
  hasActivePauseHold?: boolean;
  /** The run only compacted the agent's context; it carries no task outcome. */
  contextCompactionRun?: boolean;
  reviewOwnerUserId?: string | null;
  /** Review decisions own task state; a reviewer's finish report cannot override them. */
  nativeReviewOutcome?: "resolved" | "pending" | "stale";
  toolCallLoopContinuation?: boolean;
  /**
   * This run, as the configured participant, recorded the approval that
   * completed the task's final execution-policy stage. That durable decision is
   * the completion authority for its done report, as the policy intends.
   */
  executionStageApprovedByRun?: boolean;
  /**
   * Done would start the task's configured review stage. That reviewer, not
   * the worker's evidence references, accepts the work, as on the issue route.
   */
  executionReviewStageStarts?: boolean;
  /** Re-derived from the committed runner terminal and pinned execution identity. */
  providerModelRejected?: boolean;
  providerOverloaded?: boolean;
  providerFailureSuperseded?: boolean;
  toolReceiptLimitStopped?: boolean;
  /** The current owner's blocked report names a system-owned environment or tool outage. */
  environmentBlocker?: boolean;
  agentBlockerRecoverable?: boolean;
  agentBlockerProgress?: boolean;
  /**
   * The agent that created this task, when it may take it back to split it:
   * set only once its progress continuations are spent and it was not asked before.
   */
  agentBlockerSplitOwnerAgentId?: string | null;
  /** The task cannot change agent assignee (conversation, external chat binding, non-owner run, or unassignable owner). */
  blockerHandoffLocked?: boolean;
  /** A chat request for this task and agent is waiting as a deferred wake behind this run. */
  hasQueuedChatRequest?: boolean;
  failureRetryCount?: number;
  /**
   * This run was itself the automatic continuation of an earlier failed turn.
   * Another failure needs a person's Retry, never another automatic wake.
   */
  failedTurnContinuationUsed?: boolean;
  agentId: string;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
}): NativeStatusDecision {
  if (input.contextCompactionRun) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "context_compaction_status_preserved",
      unblockDescriptor: null,
      effects: [],
    };
  }
  if (["done", "cancelled"].includes(input.priorIssueStatus)) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "terminal_status_preserved",
      unblockDescriptor: null,
      effects: [],
    };
  }
  if (input.workspaceFinalizeStatus !== "succeeded") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "finalization_failed_claim_preserved",
      unblockDescriptor: null,
      effects: [
        {
          kind: "record_finalization_error",
          cause: "workspace_finalization_failed",
          nextAction:
            "Repair and re-run workspace finalization for the persisted native result.",
          agentId: input.agentId,
        },
      ],
    };
  }
  if (input.providerFailureSuperseded) return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve", toStatus: input.priorIssueStatus,
    reasonCode: "provider_failure_authority_superseded", unblockDescriptor: null, effects: [],
  };
  if (input.caseHandoffAuthorized) return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve", toStatus: input.priorIssueStatus,
    reasonCode: "case_handoff_waiting_for_release", unblockDescriptor: null,
    effects: [{ kind: "release_checkout" }],
  };
  if (input.providerModelRejected && input.terminalState === "failed" &&
      input.nativeReviewOutcome !== "stale" && input.nativeReviewOutcome !== "resolved") {
    if (input.nativeReviewOutcome === "pending") {
      // The pending review is bound to the worker's status decision and
      // version. Preserve that authority so an explicit retry after a
      // configuration repair can resolve the same review. In particular,
      // do not create the normal unresolved-review recovery action.
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve",
        toStatus: input.priorIssueStatus,
        reasonCode: "native_provider_model_rejected",
        unblockDescriptor: null,
        effects: [{ kind: "release_checkout" }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "blocked",
      toStatus: "blocked",
      reasonCode: "native_provider_model_rejected",
      unblockDescriptor: { owner: "board", action: NATIVE_MODEL_REJECTION_MESSAGE },
      effects: [{ kind: "bind_blocker", owner: "board", action: NATIVE_MODEL_REJECTION_MESSAGE }],
    };
  }
  if (input.providerOverloaded && input.terminalState === "failed" &&
      input.nativeReviewOutcome !== "stale" && input.nativeReviewOutcome !== "resolved") {
    const held = input.governanceGate || input.hasUnresolvedIssueBlockers || input.hasActivePauseHold || input.priorIssueStatus === "blocked";
    const exhausted = (input.failureRetryCount ?? 0) >= NATIVE_PROVIDER_CAPACITY_MAX_RETRIES;
    if (held || (exhausted && input.nativeReviewOutcome === "pending")) return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: held ? "native_provider_overloaded_held" : "native_provider_overloaded_exhausted",
      unblockDescriptor: null, effects: [{ kind: "release_checkout" }],
    };
    if (exhausted) {
      const action = `${NATIVE_PROVIDER_OVERLOADED_MESSAGE} Automatic retries exhausted; retry later or choose a different model.`;
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked", toStatus: "blocked", reasonCode: "native_provider_overloaded_exhausted",
        unblockDescriptor: { owner: "board", action },
        effects: [{ kind: "bind_blocker", owner: "board", action }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: NATIVE_PROVIDER_OVERLOADED_CODE, unblockDescriptor: null,
      effects: [
        { kind: "schedule_retry", cause: NATIVE_PROVIDER_OVERLOADED_CODE, summary: "Retry after model capacity becomes available.", agentId: input.agentId },
        ...(input.nativeReviewOutcome === "pending" ? [{ kind: "release_checkout" as const }] : []),
      ],
    };
  }
  if (input.toolReceiptLimitStopped && input.terminalState !== "succeeded" && !input.nativeReviewOutcome &&
      !input.governanceGate && !input.hasUnresolvedIssueBlockers && !input.hasActivePauseHold &&
      input.priorIssueStatus !== "blocked" &&
      (input.failureRetryCount ?? 0) < NATIVE_TOOL_RECEIPT_LIMIT_MAX_CONTINUATIONS) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: NATIVE_TOOL_RECEIPT_LIMIT_CODE, unblockDescriptor: null,
      effects: [
        { kind: "schedule_retry", cause: NATIVE_TOOL_RECEIPT_LIMIT_CODE, summary: "Continue the task in a fresh session.", agentId: input.agentId },
        ...(input.terminalState === "cancelled" ? [{ kind: "release_run_resources" as const }] : []),
      ],
    };
  }
  if (input.nativeReviewOutcome) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: input.nativeReviewOutcome === "pending" ? "native_review_unresolved" : "native_review_action_finished",
      unblockDescriptor: null,
      effects: [
        { kind: "release_checkout" },
        ...(input.nativeReviewOutcome === "pending" && !input.toolCallLoopContinuation ? [{
          kind: "record_recovery" as const, cause: "native_review_unresolved",
          nextAction: "The named reviewer must resolve the pending completion review or explain the concrete blocker. Do not restart the worker's assignment or create another review request.",
          agentId: input.agentId,
        }] : []),
      ],
    };
  }
  if (input.terminalState !== "succeeded") {
    if (input.terminalState === "cancelled") {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve",
        toStatus: input.priorIssueStatus,
        reasonCode: "cancellation_run_only",
        unblockDescriptor: null,
        effects: [{ kind: "release_run_resources" }],
      };
    }
    if (input.failedTurnContinuationUsed) {
      // The automatic continuation already ran and failed too. Keep the work
      // and hand the next attempt to a person instead of waking again.
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "native_run_failed_continuation_exhausted",
        unblockDescriptor: { owner: "board", action: NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION },
        effects: [{ kind: "bind_blocker", owner: "board", action: NATIVE_RUN_FAILED_CONTINUATION_EXHAUSTED_ACTION }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "run_failed_partial_evidence_preserved",
      unblockDescriptor: null,
      effects: [
        {
          kind: "schedule_retry",
          cause: NATIVE_RUN_FAILED_RETRY_CAUSE,
          summary:
            "Resume the persisted native run without opening a second provider session.",
          agentId: input.agentId,
        },
      ],
    };
  }
  if (input.governanceGate) {
    if (
      input.assessment.reportedDisposition === "yielded" &&
      input.assessment.continuation?.kind === "response_wake"
    ) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "in_review",
        toStatus: "in_review",
        reasonCode: "governed_response_waiting",
        unblockDescriptor: null,
        // The existing interaction is the liveness path. Its authoritative
        // resolution owns the response wake; dispatching one now would start a
        // duplicate provider turn before the human has answered.
        effects: [{ kind: "create_interaction", gate: input.governanceGate }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "governed_gate_pending",
      unblockDescriptor: null,
      effects: [
        { kind: "create_interaction", gate: input.governanceGate },
        {
          kind: "notify_owner",
          agentId: input.agentId,
          reason: "governed_gate_pending",
        },
      ],
    };
  }
  if (
    input.governanceResolvedForRun === true &&
    ["needs_review", "blocked"].includes(
      input.assessment.reportedDisposition,
    ) &&
    input.assessment.attentionRequests.length > 0 &&
    input.assessment.attentionRequests.every(
      (request) =>
        request.ownerClass === "human" &&
        ["review", "approval"].includes(request.kind),
    )
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "governance_response_continuation_queued",
      unblockDescriptor: null,
      // The accepted interaction already queued the response wake. Creating a
      // second completion-review interaction here would strand that continuation.
      // Planning turns commonly report `blocked` while awaiting their own
      // confirmation; once accepted, that response wake is authoritative too.
      effects: [],
    };
  }
  const unfinishedResponseWait =
    !input.isConversation &&
    !["authorized", "revoked"].includes(input.externalChatResponseWaitAuthorization ?? "") &&
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake" &&
    input.assessment.hasBlockingRemainingWork;
  if (
    input.hasUnresolvedIssueBlockers === true &&
    (["done", "blocked"].includes(input.assessment.reportedDisposition) || unfinishedResponseWait || input.assessment.continuation?.kind === "monitor")
  ) {
    const { owner, handoffAgentId } = resolveBlockerHandoff(
      input.assessment.blocker, input.agentId, input.blockerHandoffLocked,
    );
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "blocked",
      toStatus: "blocked",
      reasonCode: "durable_dependency_blocker_bound",
      ...(handoffAgentId ? { handoffAgentId } : {}),
      unblockDescriptor: {
        owner,
        action:
          input.assessment.blocker?.unblockAction ??
          "Wait for the issue's durable dependency blockers to complete.",
      },
      // Dependency completion owns the wake (and wakes the current assignee,
      // which becomes handoffAgentId when a named agent takes over).
      effects: [],
    };
  }
  if (input.requiredQualityReviewSatisfied === false && input.assessment.reportedDisposition === "done") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress", toStatus: "in_progress",
      reasonCode: "required_quality_review_incomplete", unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }, { kind: "record_recovery", cause: "required_quality_review_incomplete",
        nextAction: "Request or resume the task's required quality review for exact output versions; do not repeat completed work or create a generic completion approval.", agentId: input.agentId }],
    };
  }
  const evidenceComplete =
    input.assessment.reportedDisposition === "done" &&
    input.assessment.objectiveSatisfied &&
    input.assessment.allCriteriaSatisfied &&
    input.assessment.verificationPassed &&
    !input.assessment.hasFailedVerification &&
    input.assessment.attentionRequests.length === 0 &&
    !input.assessment.hasBlockingRemainingWork;
  const policyClaimComplete =
    input.completionClaimPolicyAccepted === true &&
    input.assessment.reportedDisposition === "done" &&
    input.assessment.contractRevisionMatches &&
    input.assessment.objectiveClaimSatisfied &&
    input.assessment.criterionAssessments.length > 0 &&
    input.assessment.criterionAssessments.every(
      (entry) => entry.claimStatus === "satisfied",
    ) &&
    !input.assessment.hasFailedVerification &&
    input.assessment.attentionRequests.length === 0 &&
    !input.assessment.hasBlockingRemainingWork;
  const stageApprovalComplete =
    input.executionStageApprovedByRun === true &&
    input.assessment.reportedDisposition === "done" &&
    !input.assessment.hasFailedVerification &&
    input.assessment.attentionRequests.length === 0 &&
    !input.assessment.hasBlockingRemainingWork;
  const reviewStageClaim =
    input.executionReviewStageStarts === true &&
    input.assessment.reportedDisposition === "done" &&
    input.assessment.objectiveClaimSatisfied &&
    !input.assessment.hasFailedVerification &&
    input.assessment.attentionRequests.length === 0 &&
    !input.assessment.hasBlockingRemainingWork;
  const complete = evidenceComplete || policyClaimComplete || stageApprovalComplete || reviewStageClaim;
  if (complete && input.hasPendingChildCompletion) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "native_child_completion_pending",
      unblockDescriptor: null,
      // The durable outbox/deferred wake already owns exactly one continuation.
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (complete && input.executionReviewStageStarts === true) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: COMPLETION_REVIEW_STAGE_REASON,
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (complete) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: !evidenceComplete && !policyClaimComplete
        ? "execution_stage_approved"
        : input.completionClaimPolicyAccepted
          ? "completion_claim_policy_accepted"
          : "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  // A completion claim is not a request for human approval. Only a concrete,
  // explicitly reported attention request may create a review interaction.
  if (input.assessment.attentionRequests.length > 0) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "actionable_attention_pending",
      unblockDescriptor: null,
      effects: input.assessment.attentionRequests.map((request, index) => ({
        kind: "bind_reviewer",
        requestKey: `attention-${index}`,
        prompt: request.summary.slice(0, 1_000),
        detailsMarkdown: input.assessment.summary,
        ownerUserId: request.ownerClass === "agent" ? null : (input.reviewOwnerUserId ?? null),
        ownerAgentId: request.ownerClass === "agent" ? request.targetAgentId : null,
      })),
    };
  }
  // A newer chat request waits behind this run. It starts the next turn with
  // its own source binding and the full task history. A fresh-session
  // continuation would inherit this run's older request instead, and would
  // hold the task so the newer request never runs. Only a blocker that the
  // lanes below would continue automatically yields. A blocker for a person or
  // an external owner, or one whose automatic continuations are spent, is still
  // bound now.
  const blocker = input.assessment.blocker;
  const namedOtherAgent = Boolean(blocker?.ownerAgentId && blocker.ownerAgentId !== input.agentId);
  const retries = input.failureRetryCount ?? 0;
  const progressNextAction = input.agentBlockerProgress && !input.hasUnresolvedIssueBlockers
    ? blocker?.unblockAction.trim() : undefined;
  const agentContinuationAvailable = retries < NATIVE_AGENT_BLOCKER_MAX_CONTINUATIONS
    || (Boolean(progressNextAction) && retries < NATIVE_AGENT_BLOCKER_MAX_PROGRESS_CONTINUATIONS);
  const continuesAutomatically = Boolean(blocker) && !input.isConversation && !input.hasActivePauseHold && (
    (input.environmentBlocker === true && retries < NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES) ||
    (input.agentBlockerRecoverable === true && blocker!.scope === "task_wide" && !blocker!.boardOwned &&
      !namedOtherAgent && blocker!.ownerKind === "agent" && agentContinuationAvailable));
  if (input.assessment.reportedDisposition === "blocked" && input.hasQueuedChatRequest && continuesAutomatically) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: NATIVE_BLOCKER_SUPERSEDED_BY_QUEUED_REQUEST_CODE, unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (
    input.assessment.reportedDisposition === "blocked" &&
    input.assessment.blocker &&
    input.environmentBlocker &&
    !input.isConversation &&
    !input.hasActivePauseHold
  ) {
    if ((input.failureRetryCount ?? 0) < NATIVE_ENVIRONMENT_BLOCKER_MAX_RETRIES) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve", toStatus: input.priorIssueStatus,
        reasonCode: NATIVE_ENVIRONMENT_BLOCKER_CODE, unblockDescriptor: null,
        effects: [{ kind: "schedule_retry", cause: NATIVE_ENVIRONMENT_BLOCKER_CODE,
          summary: "Continue the task in a fresh session.", agentId: input.agentId }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "blocked", toStatus: "blocked",
      reasonCode: NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_CODE,
      blockerOwnerKind: input.assessment.blocker.ownerKind,
      unblockDescriptor: { owner: "board", action: NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_ACTION },
      effects: [{ kind: "bind_blocker", owner: "board", action: NATIVE_ENVIRONMENT_BLOCKER_EXHAUSTED_ACTION }],
    };
  }
  if (
    input.assessment.reportedDisposition === "blocked" &&
    input.assessment.blocker?.scope === "task_wide" &&
    !input.assessment.blocker.boardOwned &&
    !namedOtherAgent &&
    input.agentBlockerRecoverable &&
    !input.isConversation
  ) {
    if (input.assessment.blocker.ownerKind === "agent" && !input.hasActivePauseHold &&
        agentContinuationAvailable) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve", toStatus: input.priorIssueStatus,
        reasonCode: NATIVE_AGENT_BLOCKER_CONTINUATION_CODE, unblockDescriptor: null,
        effects: [{ kind: "schedule_retry", cause: NATIVE_AGENT_BLOCKER_CONTINUATION_CODE,
          summary: "Continue the task in a fresh session.", agentId: input.agentId,
          ...(progressNextAction ? { progressNextAction } : {}) }],
      };
    }
    // Every run saved work but the task still is not done: it is too large for
    // one agent turn chain. Its creator can split it better than the board.
    if (input.assessment.blocker.ownerKind === "agent" && !input.hasActivePauseHold &&
        progressNextAction && input.agentBlockerSplitOwnerAgentId) {
      const owner = { agentId: input.agentBlockerSplitOwnerAgentId };
      const action = nativeAgentBlockerSplitAction(progressNextAction);
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked", toStatus: "blocked",
        reasonCode: NATIVE_AGENT_BLOCKER_SPLIT_CODE,
        blockerOwnerKind: input.assessment.blocker.ownerKind,
        unblockDescriptor: { owner, action },
        effects: [{ kind: "bind_blocker", owner, action }],
      };
    }
    const action = input.assessment.blocker.unblockAction;
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "blocked", toStatus: "blocked",
      reasonCode: NATIVE_AGENT_BLOCKER_HANDOFF_CODE,
      blockerOwnerKind: input.assessment.blocker.ownerKind,
      unblockDescriptor: { owner: "board", action },
      effects: [{ kind: "bind_blocker", owner: "board", action }],
    };
  }
  if (
    input.assessment.reportedDisposition === "blocked" &&
    input.assessment.blocker
  ) {
    const { owner, handoffAgentId, namedOtherAgent } = resolveBlockerHandoff(
      input.assessment.blocker, input.agentId, input.blockerHandoffLocked,
    );
    const action = input.assessment.blocker.unblockAction;
    if (input.assessment.blocker.scope === "task_wide") {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "task_wide_blocker_bound",
        blockerOwnerKind: input.assessment.blocker.ownerKind,
        ...(handoffAgentId ? { handoffAgentId } : {}),
        unblockDescriptor: { owner, action },
        effects: [
          { kind: "bind_blocker", owner, action },
          // A named human or other-agent owner owns the next action; do not
          // also wake the reporting agent to repeat the blocked work.
          ...(input.assessment.blocker.ownerUserId || namedOtherAgent ? [] : [{
            kind: "notify_owner" as const, agentId: input.agentId, reason: "task_wide_blocker_bound",
          }]),
        ],
      };
    }
    const currentTrackOwner = handoffAgentId ? owner : humanBlockerOwner(input.assessment.blocker);
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "blocked",
      toStatus: "blocked",
      reasonCode: "current_track_blocker_waiting",
      blockerOwnerKind: input.assessment.blocker.ownerKind,
      ...(handoffAgentId ? { handoffAgentId } : {}),
      // A provider's current_track label is not evidence that another
      // authorized, productive track exists. Bind the actual unblock request
      // without waking the same agent to repeat the blocked work or old title.
      unblockDescriptor: { owner: currentTrackOwner, action },
      effects: [{ kind: "bind_blocker", owner: currentTrackOwner, action }],
    };
  }
  if (input.assessment.reportedDisposition === "yielded" && input.assessment.continuation?.kind === "monitor") {
    if (input.monitorWaitDispatched) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve", toStatus: input.priorIssueStatus,
        reasonCode: "scheduled_monitor_dispatched", unblockDescriptor: null,
        // Delivery already happened. Preserve successor ownership and never
        // re-arm its timer or repeat the completed provider turn.
        effects: [],
      };
    }
    if (input.monitorWaitSuperseded) return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: "scheduled_monitor_superseded", unblockDescriptor: null, effects: [],
    };
    if (input.monitorWaitPreserved) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "preserve", toStatus: input.priorIssueStatus,
        reasonCode: "scheduled_monitor_preserved", unblockDescriptor: null, effects: [],
      };
    }
    if (input.monitorWaitAuthorized) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: input.publishedExternalReview ? "in_review" : "preserve",
        toStatus: input.publishedExternalReview ? "in_review" : input.priorIssueStatus,
        reasonCode: "scheduled_monitor_waiting", unblockDescriptor: null,
        // The persisted timer owns delivery, never enqueue an immediate wake.
        effects: [{ kind: "release_checkout" }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: "monitor_wait_authority_lost", unblockDescriptor: null,
      effects: [{ kind: "record_finalization_error", cause: "monitor_wait_authority_lost",
        nextAction: "The scheduled monitor was cleared or became ineligible. Re-establish a valid task action path.",
        agentId: input.agentId }],
    };
  }
  if (
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake" &&
    input.externalChatResponseWaitAuthorization === "authorized"
  ) {
    if (input.hasUnprovenPreservedResultStatus) return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: "preserved_result_status_unproven", unblockDescriptor: null, effects: [],
    };
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: input.publishedExternalReview ? "in_review" : "in_progress",
      toStatus: input.publishedExternalReview ? "in_review" : "in_progress",
      reasonCode: "external_chat_response_waiting",
      unblockDescriptor: null,
      // The active, authorized provider conversation is the durable liveness
      // path. Only its next admitted message may enqueue the response wake.
      effects: [],
    };
  }
  if (
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake" &&
    input.externalChatResponseWaitAuthorization === "revoked"
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "external_chat_response_wait_authorization_lost",
      unblockDescriptor: null,
      // Revocation cannot be converted into an unrequested background run.
      effects: [],
    };
  }
  if (unfinishedResponseWait && input.hasActivePauseHold) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "response_wait_pause_preserved",
      unblockDescriptor: null,
      effects: [],
    };
  }
  // Before the passive board/response waits: a Plan-mode run, assigned or
  // comment-started, with no plan to review must not rest as a silent wait.
  if (input.planNotProduced === true && !input.isConversation && input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake") {
    return { policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION, ...planNotProducedDecision(input) };
  }
  if (
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake" &&
    input.boardResponseWaitAuthorized === true &&
    !unfinishedResponseWait
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "board_response_waiting",
      unblockDescriptor: null,
      // The committer proves the current Board cause again before persisting
      // the wait. Only a new user cause may wake this completed response.
      effects: [],
    };
  }
  if (
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake" &&
    input.boardResponseWaitOrigin &&
    !input.boardResponseWaitAuthorized
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "board_response_wait_superseded",
      unblockDescriptor: null,
      effects: [],
    };
  }
  if (
    input.planWaitAuthorized === true &&
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake"
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress", toStatus: "in_progress",
      reasonCode: "native_plan_accepted_waiting_for_continuation",
      unblockDescriptor: null,
      // An answered native plan is not task completion or permission to
      // change modes. Only a new explicit user cause may continue the work.
      effects: [],
    };
  }
  if (
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation?.kind === "response_wake" &&
    !unfinishedResponseWait
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: NATIVE_RESPONSE_WAKE_WAITING_REASON,
      unblockDescriptor: null,
      effects: [],
    };
  }
  if (
    input.assessment.reportedDisposition === "yielded" &&
    input.assessment.continuation &&
    input.assessment.continuation.kind !== "case_handoff" &&
    !unfinishedResponseWait
  ) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      unblockDescriptor: null,
      effects: [
        {
          kind: "enqueue_continuation",
          continuationKind: input.assessment.continuation.kind,
          summary: input.assessment.continuation.summary,
          idempotencyKey: input.assessment.continuation.idempotencyKey,
          agentId: input.agentId,
        },
      ],
    };
  }
  // A current response that admits blocking work must use the server's bounded
  // repair path, not a passive wait or a model-chosen continuation retry key.
  if (input.allowIncompleteContinuation === false) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "prior_status_preserved_no_live_path",
      unblockDescriptor: null,
      effects: [
        {
          kind: "record_finalization_error",
          cause: "completion_evidence_incomplete",
          nextAction:
            "Bind a durable continuation or a named recovery owner before changing issue status.",
          agentId: input.agentId,
        },
      ],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode: "completion_evidence_incomplete",
    unblockDescriptor: null,
    effects: [
      {
        kind: "enqueue_continuation",
        continuationKind: "same_agent",
        summary:
          "Finish the remaining work and report done, or explicitly request a named reviewer decision. Waiting for checks or an incomplete completion report does not require human approval.",
        idempotencyKey: "native-completion-incomplete",
        agentId: input.agentId,
      },
    ],
  };
}
