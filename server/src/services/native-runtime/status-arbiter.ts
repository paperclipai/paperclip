import type { NativeEvidenceAssessment } from "./evidence-classifier.js";

export const NATIVE_STATUS_ARBITER_POLICY_VERSION = "phase6-v3";

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
      prompt: string;
      detailsMarkdown?: string | null;
      ownerUserId?: string | null;
      ownerAgentId?: string | null;
    }
  | { kind: "notify_owner"; agentId: string; reason: string }
  | {
      kind: "enqueue_continuation";
      continuationKind: "same_agent" | "retry" | "delegated_issue" | "response_wake" | "monitor";
      summary: string;
      idempotencyKey: string;
      agentId: string;
    }
  | { kind: "bind_blocker"; owner: { agentId: string } | "board"; action: string }
  | { kind: "schedule_retry"; cause: string; summary: string; agentId: string }
  | { kind: "record_finalization_error"; cause: string; nextAction: string; agentId: string }
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
  | { kind: "record_recovery"; cause: string; nextAction: string; agentId: string }
  | { kind: "release_checkout" };

export interface NativeStatusDecision {
  policyVersion: typeof NATIVE_STATUS_ARBITER_POLICY_VERSION;
  statusAction: NativeAuthoritativeIssueStatus | "preserve";
  toStatus: NativeAuthoritativeIssueStatus;
  reasonCode: string | null;
  unblockDescriptor: { owner: { agentId: string } | "board"; action: string } | null;
  effects: NativeStatusEffect[];
}

/** Pure authority boundary: model prose is evidence, never a status command. */
export function arbitrateNativeStatus(input: {
  assessment: NativeEvidenceAssessment;
  terminalState: "succeeded" | "failed" | "cancelled";
  workspaceFinalizeStatus: "succeeded" | "failed";
  governanceGate?: NativeGovernanceGate | null;
  completionClaimPolicyAccepted?: boolean;
  allowIncompleteContinuation?: boolean;
  /**
   * True when the issue already has a durable unresolved dependency edge.
   * A "current_track" result cannot remain in_progress in that state because
   * checkout is intentionally gated until the dependency resolves.
   */
  hasUnresolvedIssueBlockers?: boolean;
  /** A governance interaction created by this run was accepted before the run settled. */
  governanceResolvedForRun?: boolean;
  reviewOwnerUserId?: string | null;
  agentId: string;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
}): NativeStatusDecision {
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
      effects: [{
        kind: "record_finalization_error",
        cause: "workspace_finalization_failed",
        nextAction: "Repair and re-run workspace finalization for the persisted native result.",
        agentId: input.agentId,
      }],
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
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "run_failed_partial_evidence_preserved",
      unblockDescriptor: null,
      effects: [{
        kind: "schedule_retry",
        cause: "native_run_failed",
        summary: "Resume the persisted native run without opening a second provider session.",
        agentId: input.agentId,
      }],
    };
  }
  if (input.governanceGate) {
    if (
      input.assessment.reportedDisposition === "yielded"
      && input.assessment.continuation?.kind === "response_wake"
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
        { kind: "notify_owner", agentId: input.agentId, reason: "governed_gate_pending" },
      ],
    };
  }
  if (
    input.governanceResolvedForRun === true
    && ["needs_review", "blocked"].includes(input.assessment.reportedDisposition)
    && input.assessment.attentionRequests.length > 0
    && input.assessment.attentionRequests.every((request) =>
      request.ownerClass === "human" && ["review", "approval"].includes(request.kind)
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
  if (
    input.hasUnresolvedIssueBlockers === true
    && ["done", "blocked"].includes(input.assessment.reportedDisposition)
  ) {
    const owner = input.assessment.blocker?.boardOwned ? "board" as const : { agentId: input.agentId };
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "blocked",
      toStatus: "blocked",
      reasonCode: "durable_dependency_blocker_bound",
      unblockDescriptor: {
        owner,
        action: input.assessment.blocker?.unblockAction
          ?? "Wait for the issue's durable dependency blockers to complete.",
      },
      // Dependency completion owns the wake. Do not immediately rerun the
      // blocked issue merely because the provider mislabeled its scope/status.
      effects: [],
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
    input.assessment.criterionAssessments.every((entry) => entry.claimStatus === "satisfied") &&
    !input.assessment.hasFailedVerification &&
    input.assessment.attentionRequests.length === 0 &&
    !input.assessment.hasBlockingRemainingWork;
  const complete = evidenceComplete || policyClaimComplete;
  if (complete) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: input.completionClaimPolicyAccepted
        ? "completion_claim_policy_accepted"
        : "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (
    input.assessment.reportedDisposition === "needs_review"
    || input.assessment.reportedDisposition === "done"
    || input.assessment.attentionRequests.length > 0
  ) {
    const failedVerification = input.assessment.verificationAssessments
      .filter((entry) => entry.claimStatus === "failed")
      .map((entry) => entry.commandOrCheck);
    const unrunVerification = input.assessment.verificationCaveats
      .map((entry) => entry.commandOrCheck);
    const attention = input.assessment.attentionRequests.map((entry) => entry.summary);
    const reasonCode = failedVerification.length > 0
      ? "completion_claim_conflict"
      : attention.length > 0
        ? "actionable_attention_pending"
        : input.completionClaimPolicyAccepted === true
          ? "completion_claim_incomplete"
          : "external_verification_required";
    const reviewReasons = [
      ...failedVerification.map((value) => `Failed verification: ${value}`),
      ...unrunVerification.map((value) => `Verification not run: ${value}`),
      ...attention.map((value) => `Action required: ${value}`),
    ];
    const reviewPrompt = [
      "Review the persisted native-run evidence and confirm whether this issue may be completed.",
      ...reviewReasons.slice(0, 5),
    ].join("\n").slice(0, 1_000);
    const detailsMarkdown = [
      reviewReasons.length > 0 ? `## Missing or conflicting verification\n${reviewReasons.map((value) => `- ${value}`).join("\n")}` : null,
      input.assessment.acceptedEvidenceRefs.length > 0
        ? `## Accepted evidence\n${input.assessment.acceptedEvidenceRefs.map((value) => `- \`${value}\``).join("\n")}`
        : "## Accepted evidence\nNo durable accepted evidence was recorded.",
    ].filter(Boolean).join("\n\n").slice(0, 20_000);
    const requestedAgentOwner = input.assessment.attentionRequests
      .find((entry) => entry.ownerClass === "agent" && entry.targetAgentId)?.targetAgentId ?? null;
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode,
      unblockDescriptor: null,
      effects: [
        {
          kind: "bind_reviewer",
          prompt: reviewPrompt,
          detailsMarkdown,
          ownerUserId: requestedAgentOwner ? null : input.reviewOwnerUserId ?? null,
          ownerAgentId: requestedAgentOwner,
        },
      ],
    };
  }
  if (input.assessment.reportedDisposition === "blocked" && input.assessment.blocker) {
    const owner = input.assessment.blocker.boardOwned ? "board" as const : { agentId: input.agentId };
    if (input.assessment.blocker.scope === "task_wide") {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "blocked",
        toStatus: "blocked",
        reasonCode: "task_wide_blocker_bound",
        unblockDescriptor: { owner, action: input.assessment.blocker.unblockAction },
        effects: [
          { kind: "bind_blocker", owner, action: input.assessment.blocker.unblockAction },
          { kind: "notify_owner", agentId: input.agentId, reason: "task_wide_blocker_bound" },
        ],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "turn_waiting_other_track_live",
      unblockDescriptor: null,
      effects: [{
        kind: "enqueue_continuation",
        continuationKind: "same_agent",
        summary: `Continue another productive track while resolving: ${input.assessment.blocker.unblockAction}`,
        idempotencyKey: `native-track-blocked:${input.assessment.blocker.unblockAction}`,
        agentId: input.agentId,
      }],
    };
  }
  if (input.assessment.reportedDisposition === "yielded" && input.assessment.continuation) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_progress",
      toStatus: "in_progress",
      reasonCode: "live_continuation_registered",
      unblockDescriptor: null,
      effects: [{
        kind: "enqueue_continuation",
        continuationKind: input.assessment.continuation.kind,
        summary: input.assessment.continuation.summary,
        idempotencyKey: input.assessment.continuation.idempotencyKey,
        agentId: input.agentId,
      }],
    };
  }
  if (input.allowIncompleteContinuation === false) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "preserve",
      toStatus: input.priorIssueStatus,
      reasonCode: "prior_status_preserved_no_live_path",
      unblockDescriptor: null,
      effects: [{
        kind: "record_finalization_error",
        cause: "completion_evidence_incomplete",
        nextAction: "Bind a durable continuation or a named recovery owner before changing issue status.",
        agentId: input.agentId,
      }],
    };
  }
  return {
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode: "completion_evidence_incomplete",
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: "same_agent",
      summary: "Continue work on the missing or unverifiable completion-contract evidence.",
      idempotencyKey: "native-completion-incomplete",
      agentId: input.agentId,
    }],
  };
}
