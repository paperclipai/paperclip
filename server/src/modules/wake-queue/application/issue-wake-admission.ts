import { canActorRetryConversation, isConversation, isConversationExecutionWake, isWaitingConversation } from "../../../lib/conversation-wake-policy.js";
import type { RunSummary } from "./types.js";

type ConversationWakeIssue = {
  conversationAgentId: string | null;
  conversationUserId: string | null;
  conversationState: string | null;
  status: string;
  originKind: string | null;
};

export function createIssueWakePreflight(readIssue: (companyId: string, issueId: string) => Promise<ConversationWakeIssue | null>) {
  return async function preflightIssueWake(input: {
    companyId: string;
    issueId: string;
    agentId: string;
    reason: string | null;
    wakeReason: string | null;
    requestedByActorId?: string | null;
    manualUserWake?: boolean;
    taskRetryActorId: string | null;
    hasIndependentConversationWakeCause: boolean;
    annotationQuestionReaction?: boolean;
  }): Promise<
    | { kind: "eligible"; onboardingCompletion: boolean }
    | { kind: "skipped" }
    | { kind: "conversation_owner_required"; action: "start" | "retry" }
  > {
    const issue = await readIssue(input.companyId, input.issueId);
    if (input.taskRetryActorId && issue && !canActorRetryConversation(issue, input.taskRetryActorId)) {
      return { kind: "conversation_owner_required", action: "retry" };
    }
    const onboardingCompletion = input.reason === "issue_children_completed" && issue?.originKind === "onboarding_first_task";
    if (issue && isConversation(issue)) {
      if (input.reason === "onboarding_chat_greeting" && (issue.originKind !== "onboarding_chat"
        || issue.conversationUserId !== input.requestedByActorId)) return { kind: "skipped" };
      if (input.manualUserWake && issue.conversationUserId !== input.requestedByActorId) {
        return { kind: "conversation_owner_required", action: "start" };
      }
      if (input.annotationQuestionReaction && issue.conversationUserId !== input.requestedByActorId) {
        return { kind: "skipped" };
      }
      if (isConversationExecutionWake(issue, input.reason ?? input.wakeReason)
        || input.agentId !== issue.conversationAgentId
        || (isWaitingConversation(issue) && !input.hasIndependentConversationWakeCause)) {
        return { kind: "skipped" };
      }
    }
    return { kind: "eligible", onboardingCompletion };
  };
}

export type IssueWakeAdmissionOutcome<Run> =
  | { kind: "queued" | "coalesced" | "replayed"; run: Run }
  | { kind: "durable"; receipt: { runId: string | null } }
  | { kind: "deferred"; admitted?: boolean }
  | { kind: "skipped" };

export type IssueWakeAdmissionEffects<Run> = {
  saved?(): void;
  publishIssueActivity(): void;
  executeIssueActions(): Promise<void>;
  cancelledRuns: readonly Run[];
  emitCancelledRun(run: Run): Promise<unknown>;
  readRun(runId: string): Promise<Run | null>;
  publishQueuedRun(run: RunSummary): void;
  attachSetupRequest(): Promise<unknown>;
  dispatch(): Promise<unknown>;
};

/** Hand off only a committed admission. A contended authorization rolls back. */
export async function admitIssueWake<Run extends RunSummary & { status: string }>(
  commit: () => Promise<IssueWakeAdmissionOutcome<Run> | null>,
  effects: IssueWakeAdmissionEffects<Run>,
): Promise<Run | null> {
  const outcome = await commit();
  if (!outcome) return null;

  if (outcome.kind !== "deferred" && outcome.kind !== "skipped") effects.saved?.();
  effects.publishIssueActivity();
  await effects.executeIssueActions();

  // Cancellation telemetry does not gate dispatch or the admission result.
  for (const run of effects.cancelledRuns) void effects.emitCancelledRun(run);

  if (outcome.kind === "durable") {
    return outcome.receipt.runId ? effects.readRun(outcome.receipt.runId) : null;
  }
  if (outcome.kind === "deferred" || outcome.kind === "skipped") return null;

  if (outcome.kind === "queued") effects.publishQueuedRun(outcome.run);
  if (outcome.kind !== "replayed" || outcome.run.status === "queued") {
    await effects.attachSetupRequest();
    await effects.dispatch();
  }
  return outcome.run;
}
