import { NATIVE_STATUS_ARBITER_POLICY_VERSION, type NativeAuthoritativeIssueStatus, type NativeStatusDecision } from "./status-arbiter.js";

export type NativeReconciliationFacts = {
  equivalentAttentionFamily?: boolean;
  canonicalReplay?: boolean;
  callerMaterialConflict?: boolean;
  workspaceOperationPending?: boolean;
  undeliveredEffectCount?: number;
  authoritativeStatusChanged?: boolean;
  newEvidenceSatisfiesContract?: boolean;
  hasPendingChildCompletion?: boolean;
  dependencyResolved?: boolean;
  authorizedResume?: boolean;
  statusVersionAdvanced?: boolean;
};


export function resolveNativeReconciliationStatus(input: {
  facts: NativeReconciliationFacts;
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
}): NativeStatusDecision {
  const preserve = (reasonCode: string, effects: NativeStatusDecision["effects"]): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "preserve",
    toStatus: input.priorIssueStatus,
    reasonCode,
    unblockDescriptor: null,
    effects,
  });
  const continuation = (reasonCode: string, effects: NativeStatusDecision["effects"] = []): NativeStatusDecision => ({
    policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
    statusAction: "in_progress",
    toStatus: "in_progress",
    reasonCode,
    unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation",
      continuationKind: "same_agent",
      summary: `Continue native reconciliation after ${reasonCode}.`,
      idempotencyKey: `native-reconciliation:${reasonCode}`,
      agentId: input.agentId,
    }, ...effects],
  });

  if (input.facts.equivalentAttentionFamily) {
    return preserve("attention_duplicate_suppressed", [{ kind: "link_canonical_request" }]);
  }

  if (input.facts.callerMaterialConflict) {
    return preserve("structured_result_replay_conflict", [{
      kind: "record_finalization_error",
      cause: "structured_result_replay_conflict",
      nextAction: "Use a fresh canonical result identity.",
      agentId: input.agentId,
    }]);
  }
  if (input.facts.authoritativeStatusChanged) {
    return preserve("prior_status_terminal_preserved", [{ kind: "append_superseding_assessment" }]);
  }
  if (input.facts.statusVersionAdvanced) {
    return preserve("arbitration_conflict_reloaded", [
      { kind: "increment_status_version" },
      { kind: "schedule_reconciliation" },
    ]);
  }
  if (input.facts.newEvidenceSatisfiesContract) {
    if (input.facts.hasPendingChildCompletion) {
      return {
        policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
        statusAction: "in_progress",
        toStatus: "in_progress",
        reasonCode: "native_child_completion_pending",
        unblockDescriptor: null,
        effects: [{ kind: "release_checkout" }],
      };
    }
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "decision_superseded_by_new_evidence",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  if (input.facts.dependencyResolved) return continuation("dependency_resolved");
  if (input.facts.authorizedResume) return continuation("authorized_resume");
  if ((input.facts.undeliveredEffectCount ?? 0) > 0) {
    return continuation("live_continuation_registered", [{ kind: "dispatch_pending_effect" }]);
  }
  if (input.facts.workspaceOperationPending) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "resume_workspace_operation" }, { kind: "release_checkout" }],
    };
  }
  if (input.facts.canonicalReplay) {
    return {
      policyVersion: NATIVE_STATUS_ARBITER_POLICY_VERSION,
      statusAction: "done",
      toStatus: "done",
      reasonCode: "completion_contract_satisfied",
      unblockDescriptor: null,
      effects: [{ kind: "release_checkout" }],
    };
  }
  throw new Error("native_reconciliation_facts_invalid");
}
