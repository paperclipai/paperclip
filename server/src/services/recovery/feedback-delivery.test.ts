import { describe, expect, it } from "vitest";
import {
  FEEDBACK_DELIVERY_MAX_AUTOMATIC_RETRIES,
  FEEDBACK_DELIVERY_RETRY_WAKE_REASON,
  STRANDED_FEEDBACK_DELIVERY_BACKSTOP_SOURCE,
  buildFeedbackDeliveryFingerprint,
  buildFeedbackDeliveryRetryIdempotencyKey,
  canCoalesceFeedbackDeliveryRetry,
  collectFeedbackDispositionHandledCommentIds,
  decideStrandedFeedbackDeliveryBackstop,
  hasCompleteFeedbackDispositionCoverage,
  isSuccessfulFeedbackDeliveryRecoveryMatch,
  nextFeedbackDeliveryManualRetryAttempt,
  remainingFeedbackDispositionCommentIds,
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

describe("successful feedback delivery recovery matching", () => {
  const matchingRun = {
    companyId: COMPANY_ID,
    status: "succeeded",
    contextSnapshot: {
      issueId: ISSUE_ID,
      feedbackDeliveryRootWakeupRequestId: ROOT_WAKE_ID,
    },
  };
  const matchingAction = {
    companyId: COMPANY_ID,
    sourceIssueId: ISSUE_ID,
    kind: "feedback_delivery",
    status: "active",
    cause: "feedback_delivery_exhausted",
    evidence: { rootWakeupRequestId: ROOT_WAKE_ID, outstandingCommentIds: ["comment-1", "comment-2"] },
  };
  const matchingHandlingEvidence = {
    rootWakeupRequestId: ROOT_WAKE_ID,
    sourceCommentIds: ["comment-1", "comment-2"],
  };

  it("matches only a successful run for the same company, issue, and root wake", () => {
    expect(isSuccessfulFeedbackDeliveryRecoveryMatch({
      handlingEvidence: matchingHandlingEvidence,
      run: matchingRun,
      action: matchingAction,
    })).toBe(true);
  });

  it("rejects a successful run without same-run handling evidence", () => {
    expect(isSuccessfulFeedbackDeliveryRecoveryMatch({
      handlingEvidence: null,
      run: matchingRun,
      action: matchingAction,
    })).toBe(false);
  });

  it("rejects evidence that does not cover every outstanding source comment", () => {
    expect(isSuccessfulFeedbackDeliveryRecoveryMatch({
      handlingEvidence: {
        ...matchingHandlingEvidence,
        sourceCommentIds: ["comment-1"],
      },
      run: matchingRun,
      action: matchingAction,
    })).toBe(false);
  });

  it.each([
    ["non-successful run", { run: { ...matchingRun, status: "failed" } }],
    ["different company", { run: { ...matchingRun, companyId: "company-2" } }],
    ["different issue", {
      run: {
        ...matchingRun,
        contextSnapshot: { ...matchingRun.contextSnapshot, issueId: "issue-2" },
      },
    }],
    ["different root wake", {
      run: {
        ...matchingRun,
        contextSnapshot: {
          ...matchingRun.contextSnapshot,
          feedbackDeliveryRootWakeupRequestId: "wake-root-2",
        },
      },
    }],
    ["non-feedback action", { action: { ...matchingAction, kind: "process_lost" } }],
    ["resolved action", { action: { ...matchingAction, status: "resolved" } }],
  ])("rejects a %s", (_label, overrides) => {
    expect(isSuccessfulFeedbackDeliveryRecoveryMatch({
      handlingEvidence: matchingHandlingEvidence,
      run: "run" in overrides ? overrides.run : matchingRun,
      action: "action" in overrides ? overrides.action : matchingAction,
    })).toBe(false);
  });
});

describe("feedback disposition coverage", () => {
  it("requires the handled ids to exactly cover the delivered batch", () => {
    expect(hasCompleteFeedbackDispositionCoverage({
      deliveryCommentIds: ["comment-1", "comment-2"],
      handledCommentIds: ["comment-2", "comment-1"],
    })).toBe(true);
    expect(hasCompleteFeedbackDispositionCoverage({
      deliveryCommentIds: ["comment-1", "comment-2"],
      handledCommentIds: ["comment-1"],
    })).toBe(false);
    expect(hasCompleteFeedbackDispositionCoverage({
      deliveryCommentIds: ["comment-1"],
      handledCommentIds: ["comment-1", "comment-2"],
    })).toBe(false);
  });

  it("returns only unhandled comments for a valid partial disposition", () => {
    expect(remainingFeedbackDispositionCommentIds({
      deliveryCommentIds: ["comment-1", "comment-2", "comment-3"],
      handledCommentIds: ["comment-2"],
    })).toEqual(["comment-1", "comment-3"]);
  });

  it.each([
    ["an empty receipt", []],
    ["a receipt containing another delivery's comment", ["comment-1", "comment-3"]],
  ])("rejects %s", (_label, handledCommentIds) => {
    expect(remainingFeedbackDispositionCommentIds({
      deliveryCommentIds: ["comment-1", "comment-2"],
      handledCommentIds,
    })).toBeNull();
  });

  it("combines complementary partial receipts from one run", () => {
    expect(collectFeedbackDispositionHandledCommentIds({
      deliveryCommentIds: ["comment-1", "comment-2", "comment-3"],
      rootWakeupRequestId: "wake-root",
      dispositions: [
        { rootWakeupRequestId: "wake-root", handledCommentIds: ["comment-1"] },
        { rootWakeupRequestId: "wake-root", handledCommentIds: ["comment-3"] },
        { rootWakeupRequestId: "other-root", handledCommentIds: ["comment-2"] },
      ],
    })).toEqual(["comment-1", "comment-3"]);
  });
});

describe("manual feedback retry attempts", () => {
  it("advances past durable failed wakes instead of relying on the recovery-action counter", () => {
    const fingerprint = "feedback_delivery:company:issue:agent:root";
    expect(nextFeedbackDeliveryManualRetryAttempt({
      fingerprint,
      existingIdempotencyKeys: [
        `${fingerprint}:manual:2`,
        `${fingerprint}:manual:5`,
        `${fingerprint}:manual:not-a-number`,
        "feedback_delivery:other:manual:99",
        null,
      ],
    })).toBe(6);
  });

  it("gives concurrent requests the same first attempt for database deduplication", () => {
    const input = {
      fingerprint: "feedback_delivery:company:issue:agent:root",
      existingIdempotencyKeys: [],
    };
    expect(nextFeedbackDeliveryManualRetryAttempt(input)).toBe(1);
    expect(nextFeedbackDeliveryManualRetryAttempt(input)).toBe(1);
  });
});

describe("feedback retry coalescing", () => {
  const base = {
    sourceAgentId: "agent-1",
    liveAgentId: "agent-1",
    liveStatus: "queued",
    sourceRootWakeupRequestId: "wake-root-1",
    liveRootWakeupRequestId: "wake-root-1" as string | null,
  };

  it("coalesces queued work for the same delivery root", () => {
    expect(canCoalesceFeedbackDeliveryRetry(base)).toBe(true);
  });

  it("keeps a different user wake in a separate delivery lane", () => {
    expect(canCoalesceFeedbackDeliveryRetry({
      ...base,
      liveRootWakeupRequestId: "wake-root-2",
    })).toBe(false);
  });

  it("keeps queued non-feedback work in a separate delivery lane", () => {
    expect(canCoalesceFeedbackDeliveryRetry({
      ...base,
      liveRootWakeupRequestId: null,
    })).toBe(false);
  });
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
