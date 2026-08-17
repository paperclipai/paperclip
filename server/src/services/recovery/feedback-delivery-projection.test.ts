import { describe, expect, it } from "vitest";

import {
  FEEDBACK_DELIVERY_RECOVERED_WINDOW_MS,
  projectFeedbackDeliveryByComment,
  toSafeFeedbackDeliveryFailureReason,
  type FeedbackDeliveryPendingReplay,
  type FeedbackDeliveryRecoveryActionRow,
} from "./feedback-delivery-projection.js";
import { FEEDBACK_DELIVERY_RECOVERY_CAUSE } from "./feedback-delivery.js";

const NOW = new Date("2026-08-14T18:00:00.000Z");
const FINGERPRINT = "feedback_delivery:company-1:issue-1:agent-1:root-wake-1";

function action(
  overrides: Partial<FeedbackDeliveryRecoveryActionRow> = {},
): FeedbackDeliveryRecoveryActionRow {
  return {
    id: "action-1",
    kind: "feedback_delivery",
    cause: FEEDBACK_DELIVERY_RECOVERY_CAUSE,
    status: "active",
    fingerprint: FINGERPRINT,
    evidence: {
      outstandingCommentIds: ["comment-1"],
      rootWakeupRequestId: "root-wake-1",
      retryGeneration: 1,
      maxAutomaticRetries: 1,
      sourceRunId: "run-1",
      lastFailureCode: "process_lost",
      // Deliberately present: the projection must never surface it.
      lastFailureReason: "Error: ECONNREFUSED /home/agent/.secret/token.json",
    },
    previousOwnerAgentId: "agent-1",
    attemptCount: 1,
    maxAttempts: 1,
    lastAttemptAt: new Date("2026-08-14T17:58:00.000Z"),
    resolvedAt: null,
    createdAt: new Date("2026-08-14T17:57:00.000Z"),
    ...overrides,
  };
}

function replay(
  overrides: Partial<FeedbackDeliveryPendingReplay> = {},
): FeedbackDeliveryPendingReplay {
  return {
    fingerprint: FINGERPRINT,
    agentId: "agent-1",
    commentIds: ["comment-1"],
    generation: 1,
    runId: "run-2",
    nextAttemptAt: new Date("2026-08-14T18:00:12.000Z"),
    requestedAt: new Date("2026-08-14T17:59:30.000Z"),
    ...overrides,
  };
}

function project(input: {
  recoveryActions?: FeedbackDeliveryRecoveryActionRow[];
  pendingReplays?: FeedbackDeliveryPendingReplay[];
  viewerCanRetry?: boolean;
  viewerCanReadRuns?: boolean;
  now?: Date;
}) {
  return projectFeedbackDeliveryByComment({
    recoveryActions: input.recoveryActions ?? [],
    pendingReplays: input.pendingReplays ?? [],
    viewerCanRetry: input.viewerCanRetry ?? true,
    viewerCanReadRuns: input.viewerCanReadRuns ?? true,
    now: input.now ?? NOW,
  });
}

describe("projectFeedbackDeliveryByComment", () => {
  it("returns nothing for an issue with no delivery history", () => {
    expect(project({}).size).toBe(0);
  });

  it("projects a queued replay as quiet retrying state with no operator action", () => {
    const states = project({ pendingReplays: [replay()] });
    const state = states.get("comment-1");
    expect(state).toMatchObject({
      state: "retrying",
      sourceCommentId: "comment-1",
      attempt: 1,
      maxAttempts: 1,
      canRetry: false,
      retryInFlight: true,
      safeFailureReason: null,
      nextAttemptAt: "2026-08-14T18:00:12.000Z",
      targetRunId: "run-2",
    });
  });

  it("projects an active recovery action as exhausted and offers retry", () => {
    const state = project({ recoveryActions: [action()] }).get("comment-1");
    expect(state).toMatchObject({
      state: "exhausted_needs_attention",
      attempt: 1,
      maxAttempts: 1,
      canRetry: true,
      retryInFlight: false,
      targetRunId: "run-1",
      safeFailureReason: "The agent's process stopped before it read the comment.",
      batchedCommentCount: 1,
    });
  });

  it("never leaks a raw failure reason into the projection", () => {
    const state = project({
      recoveryActions: [
        action({
          evidence: {
            outstandingCommentIds: ["comment-1"],
            lastFailureCode: "some_unmapped_adapter_code",
            lastFailureReason: "Error: ECONNREFUSED /home/agent/.secret/token.json",
            gateReason: "workspace /srv/secret/path is dirty",
          },
        }),
      ],
    }).get("comment-1");
    expect(state?.safeFailureReason).toBeNull();
    expect(JSON.stringify(state)).not.toContain("ECONNREFUSED");
    expect(JSON.stringify(state)).not.toContain("/srv/secret/path");
  });

  it("keeps the actionable banner while an explicit retry is in flight", () => {
    const state = project({
      recoveryActions: [action()],
      pendingReplays: [replay()],
    }).get("comment-1");
    // Still exhausted: clearing it here would drop the attention item before the
    // replay has actually delivered anything.
    expect(state).toMatchObject({
      state: "exhausted_needs_attention",
      retryInFlight: true,
      canRetry: false,
    });
  });

  it("projects a recently resolved action as recovered after attention", () => {
    const state = project({
      recoveryActions: [
        action({
          status: "resolved",
          resolvedAt: new Date("2026-08-14T17:59:00.000Z"),
        }),
      ],
    }).get("comment-1");
    expect(state).toMatchObject({
      state: "recovered_after_attention",
      deliveredAt: "2026-08-14T17:59:00.000Z",
      canRetry: false,
      retryInFlight: false,
      safeFailureReason: null,
    });
  });

  it("drops the recovered notice once it ages out of the window", () => {
    const states = project({
      recoveryActions: [
        action({
          status: "resolved",
          resolvedAt: new Date(NOW.getTime() - FEEDBACK_DELIVERY_RECOVERED_WINDOW_MS - 1000),
        }),
      ],
    });
    expect(states.size).toBe(0);
  });

  it("lets a re-opened obligation win over its own earlier resolution", () => {
    const state = project({
      recoveryActions: [
        action({
          id: "action-old",
          status: "resolved",
          resolvedAt: new Date("2026-08-14T17:30:00.000Z"),
        }),
        action({ id: "action-new", status: "active" }),
      ],
    }).get("comment-1");
    expect(state?.state).toBe("exhausted_needs_attention");
  });

  it("keeps a newer comment's obligation from clearing an older one", () => {
    const states = project({
      recoveryActions: [
        action({
          id: "action-old",
          fingerprint: `${FINGERPRINT}:old`,
          status: "active",
          evidence: { outstandingCommentIds: ["comment-1"], retryGeneration: 1 },
        }),
        action({
          id: "action-new",
          fingerprint: `${FINGERPRINT}:new`,
          status: "resolved",
          resolvedAt: new Date("2026-08-14T17:59:00.000Z"),
          evidence: { outstandingCommentIds: ["comment-2"], retryGeneration: 1 },
        }),
      ],
    });
    expect(states.get("comment-1")?.state).toBe("exhausted_needs_attention");
    expect(states.get("comment-2")?.state).toBe("recovered_after_attention");
  });

  it("rolls one batched obligation onto every comment it covers", () => {
    const states = project({
      recoveryActions: [
        action({
          evidence: {
            outstandingCommentIds: ["comment-1", "comment-2", "comment-3"],
            retryGeneration: 1,
          },
        }),
      ],
    });
    expect([...states.keys()]).toEqual(["comment-1", "comment-2", "comment-3"]);
    for (const state of states.values()) {
      expect(state.batchedCommentCount).toBe(3);
      expect(state.state).toBe("exhausted_needs_attention");
    }
  });

  it("omits the run reference for a viewer who cannot read runs", () => {
    const state = project({
      recoveryActions: [action()],
      pendingReplays: [replay()],
      viewerCanReadRuns: false,
    }).get("comment-1");
    expect(state?.targetRunId).toBeNull();
    // The recovery action stays available even without a run link.
    expect(state?.state).toBe("exhausted_needs_attention");
  });

  it("withholds retry from a viewer without operator authority", () => {
    const state = project({
      recoveryActions: [action()],
      viewerCanRetry: false,
    }).get("comment-1");
    expect(state?.canRetry).toBe(false);
    expect(state?.state).toBe("exhausted_needs_attention");
  });

  it("ignores recovery actions of other kinds and causes", () => {
    const states = project({
      recoveryActions: [
        action({ kind: "stranded_assigned_issue" }),
        action({ id: "action-2", cause: "other_cause" }),
      ],
    });
    expect(states.size).toBe(0);
  });

  it("keeps the highest generation when several replays share a fingerprint", () => {
    const state = project({
      pendingReplays: [
        replay({ generation: 0, runId: "run-old" }),
        replay({ generation: 1, runId: "run-new" }),
      ],
    }).get("comment-1");
    expect(state).toMatchObject({ attempt: 1, targetRunId: "run-new" });
  });

  it("ignores replays that carry no fingerprint", () => {
    expect(project({ pendingReplays: [replay({ fingerprint: null })] }).size).toBe(0);
  });
});

describe("toSafeFeedbackDeliveryFailureReason", () => {
  it("maps known codes to plain operator language", () => {
    expect(toSafeFeedbackDeliveryFailureReason("agent_not_invokable")).toBe(
      "The assigned agent can't be started right now.",
    );
    expect(toSafeFeedbackDeliveryFailureReason(" budget_blocked ")).toBe(
      "The agent is over its budget.",
    );
  });

  it("collapses anything unrecognized rather than echoing it", () => {
    expect(toSafeFeedbackDeliveryFailureReason("Error: connect ECONNREFUSED 127.0.0.1:5432")).toBeNull();
    expect(toSafeFeedbackDeliveryFailureReason("")).toBeNull();
    expect(toSafeFeedbackDeliveryFailureReason(null)).toBeNull();
    expect(toSafeFeedbackDeliveryFailureReason(undefined)).toBeNull();
  });

  it("uses no transport or harness jargon in operator copy", () => {
    const jargon = ["wake", "adapter", "heartbeat", "pid", "stack"];
    for (const code of ["process_lost", "server_shutdown_interrupted", "agent_not_invokable"]) {
      const copy = toSafeFeedbackDeliveryFailureReason(code)?.toLowerCase() ?? "";
      for (const term of jargon) expect(copy).not.toContain(term);
    }
  });
});
