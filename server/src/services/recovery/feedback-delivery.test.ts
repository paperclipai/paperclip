import { describe, expect, it } from "vitest";
import {
  FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
  FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
  STRANDED_FEEDBACK_DELIVERY_BACKSTOP_SOURCE,
  buildFeedbackDeliveryFingerprint,
  buildFeedbackDeliveryRetryIdempotencyKey,
  decideStrandedFeedbackDeliveryBackstop,
  readFeedbackDeliveryRunContext,
  type StrandedFeedbackDeliveryBackstopProbe,
} from "./feedback-delivery.js";

const COMPANY_ID = "company-1";
const ISSUE_ID = "issue-1";
const AGENT_ID = "agent-1";
const ROOT_WAKE_ID = "wake-root-1";
const COMMENT_ID = "comment-1";

const openProbe: StrandedFeedbackDeliveryBackstopProbe = {
  hasActiveExecutionPath: false,
  hasPendingWakeInteraction: false,
  hasPendingApproval: false,
  hasPersistedDurableWaitPath: false,
  hasQueuedIssueWake: false,
  hasActiveRecoveryAction: false,
  hasExistingRetryWake: false,
  assigneeInvokable: true,
  assigneeHold: null,
  budgetBlocked: false,
  pauseHeld: false,
};

function failedFeedbackRun(overrides: Record<string, unknown> = {}) {
  const {
    contextSnapshot: contextOverrides,
    ...runOverrides
  } = overrides as { contextSnapshot?: Record<string, unknown> } & Record<string, unknown>;
  return {
    id: "run-1",
    agentId: AGENT_ID,
    status: "failed",
    errorCode: "process_lost",
    wakeupRequestId: ROOT_WAKE_ID,
    contextSnapshot: {
      issueId: ISSUE_ID,
      taskId: ISSUE_ID,
      wakeReason: "issue_commented",
      wakeCommentIds: [COMMENT_ID],
      ...(contextOverrides ?? {}),
    },
    scheduledRetryReason: null,
    scheduledRetryAttempt: null,
    ...runOverrides,
  };
}

function decide(input: {
  probe?: Partial<StrandedFeedbackDeliveryBackstopProbe>;
  issue?: Partial<{
    id: string;
    status: string;
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
  }>;
  latestRun?: ReturnType<typeof failedFeedbackRun> | null;
  hasTypedReviewParticipant?: boolean;
  rootWakeRequestedByActorType?: string | null;
} = {}) {
  return decideStrandedFeedbackDeliveryBackstop({
    companyId: COMPANY_ID,
    issue: {
      id: ISSUE_ID,
      status: "in_review",
      assigneeAgentId: AGENT_ID,
      assigneeUserId: null,
      ...(input.issue ?? {}),
    },
    hasTypedReviewParticipant: input.hasTypedReviewParticipant ?? false,
    latestRun: input.latestRun === undefined ? failedFeedbackRun() : input.latestRun,
    rootWakeRequestedByActorType: input.rootWakeRequestedByActorType ?? "user",
    probe: { ...openProbe, ...(input.probe ?? {}) },
  });
}

const FINGERPRINT = buildFeedbackDeliveryFingerprint({
  companyId: COMPANY_ID,
  issueId: ISSUE_ID,
  agentId: AGENT_ID,
  rootWakeupRequestId: ROOT_WAKE_ID,
});

describe("stranded feedback delivery backstop", () => {
  it("requeues exactly one normal-model recovery for the original assignee", () => {
    const decision = decide();

    expect(decision).toMatchObject({
      kind: "requeue",
      generation: 1,
      idempotencyKey: buildFeedbackDeliveryRetryIdempotencyKey({
        fingerprint: FINGERPRINT,
        generation: 1,
      }),
      payload: {
        issueId: ISSUE_ID,
        retryOfRunId: "run-1",
        feedbackDeliveryRootWakeupRequestId: ROOT_WAKE_ID,
        feedbackDeliveryRetryGeneration: 1,
        feedbackDeliveryBackstop: true,
        wakeCommentIds: [COMMENT_ID],
        commentId: COMMENT_ID,
      },
      contextSnapshot: {
        wakeReason: FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
        source: STRANDED_FEEDBACK_DELIVERY_BACKSTOP_SOURCE,
      },
    });
    if (decision.kind !== "requeue") throw new Error("expected a requeue decision");
    // Normal-model recovery must not carry the cheap/status-only guard hints.
    expect(decision.contextSnapshot.modelProfile).toBeUndefined();
    expect(decision.contextSnapshot.recoveryIntent).toBeUndefined();
    expect(decision.delivery.agentId).toBe(AGENT_ID);
  });

  it("shares the immediate lane's fingerprint and replay key so there is never a second lane", () => {
    const immediate = readFeedbackDeliveryRunContext({
      companyId: COMPANY_ID,
      run: failedFeedbackRun(),
    });
    const decision = decide();

    expect(immediate?.fingerprint).toBe(FINGERPRINT);
    if (decision.kind !== "requeue") throw new Error("expected a requeue decision");
    expect(decision.idempotencyKey).toBe(
      buildFeedbackDeliveryRetryIdempotencyKey({ fingerprint: immediate!.fingerprint, generation: 1 }),
    );
  });

  it("skips when the immediate lane already queued the same replay generation", () => {
    expect(decide({ probe: { hasExistingRetryWake: true } })).toEqual({
      kind: "skip",
      reason: "feedback delivery replay wake already exists",
    });
  });

  it("skips when any recovery action already owns the issue", () => {
    expect(decide({ probe: { hasActiveRecoveryAction: true } })).toEqual({
      kind: "skip",
      reason: "issue already has an active recovery action",
    });
  });

  it("opens one explicit recovery action once automatic replay is exhausted", () => {
    const exhausted = failedFeedbackRun({
      contextSnapshot: {
        wakeReason: FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
        feedbackDeliveryRootWakeupRequestId: ROOT_WAKE_ID,
        feedbackDeliveryRetryGeneration: FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
        wakeCommentIds: [COMMENT_ID],
      },
      wakeupRequestId: "wake-retry-1",
    });

    const decision = decide({ latestRun: exhausted });
    expect(decision).toMatchObject({ kind: "recovery_action", reason: "retry_exhausted" });
    if (decision.kind !== "recovery_action") throw new Error("expected a recovery action");
    // The exhausted generation keeps the original root wake fingerprint so it
    // lands on the immediate lane's action instead of creating a new one.
    expect(decision.delivery.fingerprint).toBe(FINGERPRINT);
    expect(decision.delivery.generation).toBe(FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES);
  });

  it("reads the exhausted generation from a scheduled retry run that lost its context hint", () => {
    const decision = decide({
      latestRun: failedFeedbackRun({
        contextSnapshot: {
          wakeReason: FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
          feedbackDeliveryRootWakeupRequestId: ROOT_WAKE_ID,
          wakeCommentIds: [COMMENT_ID],
        },
        scheduledRetryReason: "feedback_delivery_retry",
        scheduledRetryAttempt: 1,
      }),
    });

    expect(decision).toMatchObject({ kind: "recovery_action", reason: "retry_exhausted" });
  });

  it("cannot loop: a replayed generation never requeues another replay", () => {
    let run = failedFeedbackRun();
    const generations: number[] = [];
    for (let round = 0; round < 5; round += 1) {
      const decision = decide({ latestRun: run });
      if (decision.kind !== "requeue") {
        expect(decision).toMatchObject({ kind: "recovery_action" });
        break;
      }
      generations.push(decision.generation);
      // Simulate the replay run also failing without handling the feedback.
      run = failedFeedbackRun({
        contextSnapshot: decision.contextSnapshot as Record<string, unknown>,
        wakeupRequestId: `wake-retry-${decision.generation}`,
      });
    }

    expect(generations).toEqual([1]);
  });

  it.each([
    ["a paused assignee", { assigneeInvokable: false, assigneeHold: "paused" as const }],
    ["a budget-blocked assignee", { budgetBlocked: true }],
  ])("still records exhausted feedback for %s, because the action never wakes anyone", (_label, probe) => {
    const decision = decide({
      probe,
      latestRun: failedFeedbackRun({
        contextSnapshot: {
          wakeReason: FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
          feedbackDeliveryRootWakeupRequestId: ROOT_WAKE_ID,
          feedbackDeliveryRetryGeneration: FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
          wakeCommentIds: [COMMENT_ID],
        },
        wakeupRequestId: "wake-retry-1",
      }),
    });

    expect(decision).toMatchObject({ kind: "recovery_action", reason: "retry_exhausted" });
  });

  it("routes to an explicit recovery action when the original assignee is not invokable", () => {
    expect(decide({ probe: { assigneeInvokable: false, assigneeHold: null } })).toMatchObject({
      kind: "recovery_action",
      reason: "assignee_not_invokable",
    });
  });

  it.each([
    ["a pending Board interaction", { hasPendingWakeInteraction: true }, "issue has a pending waking interaction"],
    ["a pending approval", { hasPendingApproval: true }, "issue has a pending approval"],
    ["a monitor or blocker wait", { hasPersistedDurableWaitPath: true }, "issue has a persisted durable wait path"],
    ["an active run", { hasActiveExecutionPath: true }, "issue already has an active execution path"],
    ["a queued wake", { hasQueuedIssueWake: true }, "issue already has a queued wake"],
    ["a pause hold", { pauseHeld: true }, "automatic recovery is suppressed by a pause hold"],
    ["a budget block", { budgetBlocked: true }, "assignee invocation is budget blocked"],
    [
      "a paused assignee",
      { assigneeInvokable: false, assigneeHold: "paused" as const },
      "assignee is held (paused)",
    ],
    [
      "an assignee awaiting approval",
      { assigneeInvokable: false, assigneeHold: "pending_approval" as const },
      "assignee is held (pending_approval)",
    ],
  ])("leaves a legitimate wait untouched: %s", (_label, probe, reason) => {
    expect(decide({ probe })).toEqual({ kind: "skip", reason });
  });

  it.each([
    ["done", "done"],
    ["cancelled", "cancelled"],
    ["in_progress", "in_progress"],
    ["blocked", "blocked"],
  ])("leaves %s issues untouched", (_label, status) => {
    expect(decide({ issue: { status } })).toEqual({ kind: "skip", reason: "issue is not in review" });
  });

  it("leaves human-owned reviews untouched", () => {
    expect(decide({ issue: { assigneeUserId: "user-1" } })).toEqual({
      kind: "skip",
      reason: "review is owned by a user",
    });
  });

  it("leaves reviews with a typed execution participant to the participant lane", () => {
    expect(decide({ hasTypedReviewParticipant: true })).toEqual({
      kind: "skip",
      reason: "review issue has a typed execution participant",
    });
  });

  it("ignores a latest run that carried no feedback context", () => {
    expect(
      decide({
        latestRun: failedFeedbackRun({
          contextSnapshot: { issueId: ISSUE_ID, wakeReason: "issue_assigned" },
        }),
      }),
    ).toEqual({ kind: "skip", reason: "latest failed run carried no feedback delivery context" });
  });

  it("ignores feedback whose root wake did not come from a user", () => {
    expect(decide({ rootWakeRequestedByActorType: "agent" })).toEqual({
      kind: "skip",
      reason: "feedback wake did not originate from a user",
    });
  });

  it.each([
    ["succeeded", "succeeded"],
    ["running", "running"],
    ["cancelled", "cancelled"],
    ["interrupted", "interrupted"],
  ])("ignores a latest run in status %s", (_label, status) => {
    expect(decide({ latestRun: failedFeedbackRun({ status }) })).toEqual({
      kind: "skip",
      reason: "latest run did not fail",
    });
  });

  it("ignores a failed feedback run owned by a different agent", () => {
    expect(decide({ latestRun: failedFeedbackRun({ agentId: "agent-2" }) })).toEqual({
      kind: "skip",
      reason: "latest failed run belongs to a different agent",
    });
  });

  it("ignores a review issue with no runs at all", () => {
    expect(decide({ latestRun: null })).toEqual({ kind: "skip", reason: "review issue has no latest run" });
  });

  it("accepts an explicit resume wake with no comment ids", () => {
    expect(
      decide({
        latestRun: failedFeedbackRun({
          contextSnapshot: {
            issueId: ISSUE_ID,
            wakeReason: "issue_status_changed",
            resumeIntent: true,
          },
        }),
      }),
    ).toMatchObject({ kind: "requeue", generation: 1 });
  });
});
