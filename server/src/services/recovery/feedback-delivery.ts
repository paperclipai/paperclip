import { withRecoveryModelProfileHint } from "./model-profile-hint.js";

export const FEEDBACK_DELIVERY_RETRY_REASON = "feedback_delivery_retry";
export const FEEDBACK_DELIVERY_RETRY_WAKE_REASON = "feedback_delivery_retry";
export const FEEDBACK_DELIVERY_RECOVERY_CAUSE = "feedback_delivery_exhausted";
export const FEEDBACK_DELIVERY_RECOVERY_ACTION_KIND = "feedback_delivery" as const;
export const FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES = 1;
export const FEEDBACK_DELIVERY_WAKE_COMMENT_IDS_KEY = "wakeCommentIds";

export const STRANDED_FEEDBACK_DELIVERY_BACKSTOP_SOURCE = "issue.stranded_feedback_delivery_backstop";
export const STRANDED_FEEDBACK_DELIVERY_BACKSTOP_INSTRUCTION =
  "Human feedback on this in-review issue was never durably handled: the run created for it failed and no reviewer, " +
  "interaction, approval, monitor, active run, or queued wake remained. Handle the outstanding comment(s) now and " +
  "record a valid disposition. This is the only automatic backstop wake for this feedback batch.";
export const STRANDED_FEEDBACK_DELIVERY_BACKSTOP_NEXT_ACTION =
  "Handle the outstanding human feedback comment(s) on this in-review issue and record a valid disposition, " +
  "or state the exact blocker and named unblock owner. Automatic feedback replay is exhausted.";

// Feedback delivery is a human-input contract, so only wakes whose root request
// came from a user create a delivery obligation.
export const FEEDBACK_DELIVERY_ROOT_WAKE_ACTOR_TYPE = "user";

const FEEDBACK_DELIVERY_WAKE_REASONS = [
  "issue_commented",
  "issue_reopened_via_comment",
  FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
] as const;
const FEEDBACK_DELIVERY_RESUME_WAKE_REASONS = [
  "issue_assigned",
  "issue_status_changed",
  "issue_commented",
  "issue_reopened_via_comment",
] as const;

function readNonEmptyString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

export function buildFeedbackDeliveryFingerprint(input: {
  companyId: string;
  issueId: string;
  agentId: string;
  rootWakeupRequestId: string;
}) {
  return [
    "feedback_delivery",
    input.companyId,
    input.issueId,
    input.agentId,
    input.rootWakeupRequestId,
  ].join(":");
}

/**
 * Both delivery lanes (immediate terminalization in heartbeat and the periodic
 * backstop in recovery) derive the replay wake key from this function, so a
 * generation can only ever be queued once no matter which lane notices first.
 */
export function buildFeedbackDeliveryRetryIdempotencyKey(input: {
  fingerprint: string;
  generation: number;
}) {
  return `${input.fingerprint}:generation:${input.generation}`;
}

export function readFeedbackDeliveryWakeCommentIds(
  contextSnapshot: Record<string, unknown> | null | undefined,
): string[] {
  const merged: string[] = [];
  const append = (value: unknown) => {
    const normalized = readNonEmptyString(value);
    if (!normalized || merged.includes(normalized)) return;
    merged.push(normalized);
  };

  const batched = contextSnapshot?.[FEEDBACK_DELIVERY_WAKE_COMMENT_IDS_KEY];
  if (Array.isArray(batched)) {
    for (const entry of batched) append(entry);
  }
  append(contextSnapshot?.wakeCommentId);
  append(contextSnapshot?.commentId);
  return merged;
}

export function carriesExplicitFeedbackResume(
  contextSnapshot: Record<string, unknown> | null | undefined,
) {
  return contextSnapshot?.resumeIntent === true || contextSnapshot?.followUpRequested === true;
}

export function isEligibleFeedbackDeliveryWake(input: {
  wakeReason: string | null;
  carriesExplicitResume: boolean;
}) {
  if (!input.wakeReason) return false;
  if ((FEEDBACK_DELIVERY_WAKE_REASONS as readonly string[]).includes(input.wakeReason)) return true;
  return (
    input.carriesExplicitResume &&
    (FEEDBACK_DELIVERY_RESUME_WAKE_REASONS as readonly string[]).includes(input.wakeReason)
  );
}

export function readFeedbackDeliveryRetryGeneration(input: {
  contextSnapshot: Record<string, unknown> | null | undefined;
  scheduledRetryReason?: string | null;
  scheduledRetryAttempt?: number | null;
}) {
  const raw = input.contextSnapshot?.feedbackDeliveryRetryGeneration;
  const fromContext = typeof raw === "number" ? raw : null;
  const fromRun = input.scheduledRetryReason === FEEDBACK_DELIVERY_RETRY_REASON
    ? input.scheduledRetryAttempt ?? 0
    : 0;
  return Math.max(0, Math.floor(fromContext ?? fromRun));
}

export type FeedbackDeliveryRunContext = {
  issueId: string;
  agentId: string;
  rootWakeupRequestId: string;
  commentIds: string[];
  generation: number;
  fingerprint: string;
};

/**
 * Pure half of feedback-delivery context extraction: everything both lanes can
 * decide from the run row alone. Callers still confirm the root wake was
 * user-requested, which needs a lookup.
 */
export function readFeedbackDeliveryRunContext(input: {
  companyId: string;
  run: {
    id: string;
    agentId: string;
    wakeupRequestId: string | null;
    contextSnapshot: unknown;
    scheduledRetryReason?: string | null;
    scheduledRetryAttempt?: number | null;
  };
}): FeedbackDeliveryRunContext | null {
  const context = (typeof input.run.contextSnapshot === "object" && input.run.contextSnapshot !== null
    ? input.run.contextSnapshot
    : {}) as Record<string, unknown>;
  const issueId = readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
  const rootWakeupRequestId =
    readNonEmptyString(context.feedbackDeliveryRootWakeupRequestId) ?? input.run.wakeupRequestId;
  if (!issueId || !rootWakeupRequestId) return null;

  const commentIds = readFeedbackDeliveryWakeCommentIds(context);
  const carriesExplicitResume = carriesExplicitFeedbackResume(context);
  if (
    !isEligibleFeedbackDeliveryWake({
      wakeReason: readNonEmptyString(context.wakeReason),
      carriesExplicitResume,
    })
  ) {
    return null;
  }
  if (commentIds.length === 0 && !carriesExplicitResume) return null;

  return {
    issueId,
    agentId: input.run.agentId,
    rootWakeupRequestId,
    commentIds,
    generation: readFeedbackDeliveryRetryGeneration({
      contextSnapshot: context,
      scheduledRetryReason: input.run.scheduledRetryReason ?? null,
      scheduledRetryAttempt: input.run.scheduledRetryAttempt ?? null,
    }),
    fingerprint: buildFeedbackDeliveryFingerprint({
      companyId: input.companyId,
      issueId,
      agentId: input.run.agentId,
      rootWakeupRequestId,
    }),
  };
}

export type StrandedFeedbackDeliveryBackstopDecision =
  | {
      kind: "requeue";
      delivery: FeedbackDeliveryRunContext;
      generation: number;
      idempotencyKey: string;
      payload: Record<string, unknown>;
      contextSnapshot: Record<string, unknown>;
    }
  | {
      kind: "recovery_action";
      delivery: FeedbackDeliveryRunContext;
      reason: "retry_exhausted" | "assignee_not_invokable";
    }
  | { kind: "skip"; reason: string };

export type StrandedFeedbackDeliveryBackstopProbe = {
  /** Any live or queued-for-execution run on the issue, regardless of agent. */
  hasActiveExecutionPath: boolean;
  hasPendingWakeInteraction: boolean;
  hasPendingApproval: boolean;
  /** Monitor check or an unresolved `blocks` dependency. */
  hasPersistedDurableWaitPath: boolean;
  hasQueuedIssueWake: boolean;
  /** Any active/escalated recovery action already owns this issue. */
  hasActiveRecoveryAction: boolean;
  /** A wake already exists for the replay idempotency key this lane would use. */
  hasExistingRetryWake: boolean;
  assigneeInvokable: boolean;
  /**
   * Set when the assignee is deliberately held (operator pause, or still
   * awaiting approval). That is a legitimate wait, not stranded feedback, so it
   * is left alone rather than routed to a takeover owner.
   */
  assigneeHold: "paused" | "pending_approval" | null;
  budgetBlocked: boolean;
  pauseHeld: boolean;
};

/**
 * Narrow reconciliation backstop for review feedback that immediate
 * terminalization missed: agent-assigned `in_review` with no typed review
 * participant, no interaction/approval/monitor/user owner, no active run or
 * queued wake, and a failed latest run that carried user feedback context.
 */
export function decideStrandedFeedbackDeliveryBackstop(input: {
  companyId: string;
  issue: {
    id: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  };
  hasTypedReviewParticipant: boolean;
  latestRun: {
    id: string;
    agentId: string;
    status: string;
    errorCode: string | null;
    wakeupRequestId: string | null;
    contextSnapshot: unknown;
    scheduledRetryReason?: string | null;
    scheduledRetryAttempt?: number | null;
  } | null;
  rootWakeRequestedByActorType: string | null;
  probe: StrandedFeedbackDeliveryBackstopProbe;
  maxAutomaticRetries?: number;
}): StrandedFeedbackDeliveryBackstopDecision {
  if (input.issue.status !== "in_review") {
    return { kind: "skip", reason: "issue is not in review" };
  }
  if (input.issue.assigneeUserId) {
    return { kind: "skip", reason: "review is owned by a user" };
  }
  if (!input.issue.assigneeAgentId) {
    return { kind: "skip", reason: "review issue has no agent assignee" };
  }
  if (input.hasTypedReviewParticipant) {
    return { kind: "skip", reason: "review issue has a typed execution participant" };
  }
  if (!input.latestRun) {
    return { kind: "skip", reason: "review issue has no latest run" };
  }
  if (input.latestRun.status !== "failed" && input.latestRun.status !== "timed_out") {
    return { kind: "skip", reason: "latest run did not fail" };
  }
  if (input.latestRun.agentId !== input.issue.assigneeAgentId) {
    return { kind: "skip", reason: "latest failed run belongs to a different agent" };
  }

  const delivery = readFeedbackDeliveryRunContext({
    companyId: input.companyId,
    run: input.latestRun,
  });
  if (!delivery || delivery.issueId !== input.issue.id) {
    return { kind: "skip", reason: "latest failed run carried no feedback delivery context" };
  }
  if (input.rootWakeRequestedByActorType !== FEEDBACK_DELIVERY_ROOT_WAKE_ACTOR_TYPE) {
    return { kind: "skip", reason: "feedback wake did not originate from a user" };
  }

  const probe = input.probe;
  if (probe.hasActiveExecutionPath) return { kind: "skip", reason: "issue already has an active execution path" };
  if (probe.hasPendingWakeInteraction) return { kind: "skip", reason: "issue has a pending waking interaction" };
  if (probe.hasPendingApproval) return { kind: "skip", reason: "issue has a pending approval" };
  if (probe.hasPersistedDurableWaitPath) return { kind: "skip", reason: "issue has a persisted durable wait path" };
  if (probe.hasQueuedIssueWake) return { kind: "skip", reason: "issue already has a queued wake" };
  if (probe.pauseHeld) return { kind: "skip", reason: "automatic recovery is suppressed by a pause hold" };
  // The immediate lane owns this issue; never open a parallel second lane.
  if (probe.hasActiveRecoveryAction) return { kind: "skip", reason: "issue already has an active recovery action" };

  // Exhaustion is checked before the hold/budget gates: the recovery action is a
  // visibility record with a `manual_repair_required` wake policy, so recording
  // it never wakes a held or budget-gated assignee, and exhausted feedback must
  // not stay silently `in_review`.
  const maxAutomaticRetries = input.maxAutomaticRetries ?? FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES;
  if (delivery.generation >= maxAutomaticRetries) {
    return { kind: "recovery_action", delivery, reason: "retry_exhausted" };
  }

  // Replay would wake the assignee, so a deliberate hold or budget gate is a
  // legitimate wait that keeps its own lane as the single owner.
  if (probe.assigneeHold) {
    return { kind: "skip", reason: `assignee is held (${probe.assigneeHold})` };
  }
  if (probe.budgetBlocked) return { kind: "skip", reason: "assignee invocation is budget blocked" };

  if (!probe.assigneeInvokable) {
    return { kind: "recovery_action", delivery, reason: "assignee_not_invokable" };
  }

  const generation = delivery.generation + 1;
  const idempotencyKey = buildFeedbackDeliveryRetryIdempotencyKey({
    fingerprint: delivery.fingerprint,
    generation,
  });
  if (probe.hasExistingRetryWake) {
    return { kind: "skip", reason: "feedback delivery replay wake already exists" };
  }

  const latestCommentId = delivery.commentIds.at(-1);
  const payload = withRecoveryModelProfileHint({
    issueId: input.issue.id,
    taskId: input.issue.id,
    sourceIssueId: input.issue.id,
    retryOfRunId: input.latestRun.id,
    retryReason: FEEDBACK_DELIVERY_RETRY_REASON,
    feedbackDeliveryRootWakeupRequestId: delivery.rootWakeupRequestId,
    feedbackDeliverySourceRunId: input.latestRun.id,
    feedbackDeliveryRetryGeneration: generation,
    feedbackDeliveryBackstop: true,
    [FEEDBACK_DELIVERY_WAKE_COMMENT_IDS_KEY]: delivery.commentIds,
    ...(latestCommentId ? { commentId: latestCommentId, wakeCommentId: latestCommentId } : {}),
  }, "normal_model");

  return {
    kind: "requeue",
    delivery,
    generation,
    idempotencyKey,
    payload,
    contextSnapshot: withRecoveryModelProfileHint({
      ...payload,
      wakeReason: FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
      source: STRANDED_FEEDBACK_DELIVERY_BACKSTOP_SOURCE,
      instruction: STRANDED_FEEDBACK_DELIVERY_BACKSTOP_INSTRUCTION,
    }, "normal_model"),
  };
}
