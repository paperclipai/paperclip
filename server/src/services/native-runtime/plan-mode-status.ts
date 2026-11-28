import type { NativeAuthoritativeIssueStatus, NativeStatusDecision } from "./status-arbiter.js";

export const PLAN_NOT_PRODUCED_REASON = "plan_mode_plan_not_produced";

/**
 * Plan mode waits only on a plan review. A Plan-mode run that yields a
 * response wait with no plan to review (none saved, or the current revision
 * already answered) must not rest as a silent wait. The agent is asked once to
 * save its plan (its review card then opens); after that, the task keeps its
 * status and shows a recovery step.
 */
export function planNotProducedDecision(input: {
  priorIssueStatus: NativeAuthoritativeIssueStatus;
  agentId: string;
  allowIncompleteContinuation?: boolean;
}): Omit<NativeStatusDecision, "policyVersion"> {
  if (input.allowIncompleteContinuation === false) {
    return {
      statusAction: "preserve", toStatus: input.priorIssueStatus,
      reasonCode: PLAN_NOT_PRODUCED_REASON, unblockDescriptor: null,
      effects: [{ kind: "record_finalization_error", cause: PLAN_NOT_PRODUCED_REASON,
        nextAction: "The agent finished in Plan mode without a new plan to review. Ask it to write the plan, or switch the task out of Plan mode.",
        agentId: input.agentId }],
    };
  }
  return {
    statusAction: "in_progress", toStatus: "in_progress",
    reasonCode: PLAN_NOT_PRODUCED_REASON, unblockDescriptor: null,
    effects: [{
      kind: "enqueue_continuation", continuationKind: "same_agent",
      summary: "This task is in Plan mode and there is no new plan to review. Save your plan (or the revised plan) to this task's Plan document; Paperclip then asks the user to approve it. If you need an answer first, ask a question instead of waiting.",
      // The bounded incomplete-report key: a second miss gets the recovery step.
      idempotencyKey: "native-completion-incomplete", agentId: input.agentId,
    }],
  };
}
