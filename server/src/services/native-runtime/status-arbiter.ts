import type { NativeEvidenceAssessment } from "./evidence-classifier.js";

export const NATIVE_STATUS_ARBITER_POLICY_VERSION = "phase6-v2";

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
  | { kind: "bind_reviewer"; prompt: string }
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
  const complete =
    input.assessment.reportedDisposition === "done" &&
    input.assessment.objectiveSatisfied &&
    input.assessment.allCriteriaSatisfied &&
    input.assessment.verificationPassed &&
    !input.assessment.hasBlockingRemainingWork;
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
  if (input.assessment.reportedDisposition === "needs_review") {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "in_review",
      toStatus: "in_review",
      reasonCode: "completion_review_required",
      unblockDescriptor: null,
      effects: [
        {
          kind: "bind_reviewer",
          prompt: "Review the persisted native-run evidence and confirm whether this issue may be completed.",
        },
        { kind: "notify_owner", agentId: input.agentId, reason: "completion_review_required" },
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
