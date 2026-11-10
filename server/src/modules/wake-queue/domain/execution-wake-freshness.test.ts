import { describe, expect, it } from "vitest";
import {
  carriesCurrentExecutionStage,
  decideExecutionWakeFreshness,
  withExecutionWakeReasonRestored,
  withoutStaleExecutionContext,
  type ExecutionWakeFreshnessFacts,
} from "./execution-wake-freshness.js";

const reviewer = "reviewer-agent";
const executor = "executor-agent";
const reviewerStage = { stageId: "stage-1", stageType: "review", wakeRole: "reviewer" };

function stageWake(wakeReason: string | null, agentId = reviewer, seedExtra: Record<string, unknown> = {},
  payloadExtra: Record<string, unknown> = {}, stage: Record<string, unknown> = reviewerStage) {
  return {
    agentId,
    payload: { issueId: "issue-1", executionStage: stage, ...payloadExtra,
      _paperclipWakeContext: { issueId: "issue-1", ...(wakeReason ? { wakeReason } : {}), executionStage: stage, ...seedExtra } },
  };
}

const livenessSeed = {
  issueId: "issue-1",
  wakeReason: "run_liveness_continuation",
  livenessContinuationAttempt: 1,
  livenessContinuationSourceRunId: "run-0",
  livenessContinuationInstruction: "Take the next step.",
};
const livenessPayload = { issueId: "issue-1", sourceRunId: "run-0", livenessState: "plan_only", livenessReason: "no progress",
  continuationAttempt: 1, maxContinuationAttempts: 2, instruction: "Take the next step." };

function livenessWake(seedExtra: Record<string, unknown> = {}, payloadExtra: Record<string, unknown> = {}) {
  return { agentId: executor, payload: { ...livenessPayload, ...payloadExtra, _paperclipWakeContext: { ...livenessSeed, ...seedExtra } } };
}

function reviewIssue(state: Record<string, unknown> = {}, issue: Record<string, unknown> = {}): ExecutionWakeFreshnessFacts["issue"] {
  return {
    status: "in_review",
    assigneeAgentId: reviewer,
    executionState: {
      status: "pending",
      currentStageId: "stage-1",
      currentStageType: "review",
      currentParticipant: { type: "agent", agentId: reviewer },
      returnAssignee: { type: "agent", agentId: executor },
      ...state,
    },
    ...issue,
  } as ExecutionWakeFreshnessFacts["issue"];
}

const openIssue = { status: "in_progress", assigneeAgentId: executor, executionState: null };

const decide = (wake: ExecutionWakeFreshnessFacts["wake"], issue: ExecutionWakeFreshnessFacts["issue"]) =>
  decideExecutionWakeFreshness({ wake, issue });

describe("decideExecutionWakeFreshness: execution stages", () => {
  it.each(["execution_review_requested", "execution_approval_requested"])("keeps a %s wake for the current participant", reason => {
    expect(decide(stageWake(reason), reviewIssue())).toBe("current");
  });

  it("keeps a changes-requested wake for the return assignee", () => {
    expect(decide(stageWake("execution_changes_requested", executor, {}, {}, { ...reviewerStage, wakeRole: "executor" }),
      reviewIssue({ status: "changes_requested" }, { status: "in_progress", assigneeAgentId: executor }))).toBe("current");
  });

  it("judges a saved stage by its role when a merged wake replaced the stage reason", () => {
    const merged = stageWake("issue_commented", reviewer, { wakeCommentIds: ["c1"] });
    expect(decide(merged, reviewIssue())).toBe("current");
    expect(decide(merged, reviewIssue({ currentStageId: "stage-2" }))).toBe("stale_part");
    const executorMerged = stageWake("issue_commented", executor, { wakeCommentIds: ["c1"] }, {}, { ...reviewerStage, wakeRole: "executor" });
    expect(decide(executorMerged, reviewIssue({ status: "changes_requested" }, { status: "in_progress", assigneeAgentId: executor })))
      .toBe("current");
    expect(decide(executorMerged, reviewIssue({}, { assigneeAgentId: executor }))).toBe("stale_part");
  });

  it.each([
    ["the stage moved on", reviewIssue({ currentStageId: "stage-2" })],
    ["the stage is no longer pending", reviewIssue({ status: "changes_requested" })],
    ["another agent is the participant", reviewIssue({ currentParticipant: { type: "agent", agentId: "other-agent" } })],
    ["a user is the participant", reviewIssue({ currentParticipant: { type: "user", userId: "user-1" } })],
    ["the issue was reassigned", reviewIssue({}, { assigneeAgentId: executor })],
    ["the issue is assigned to a user", reviewIssue({}, { assigneeAgentId: null })],
    ["the issue is done", reviewIssue({}, { status: "done" })],
    ["the issue is cancelled", reviewIssue({}, { status: "cancelled" })],
    ["the issue has no execution state", reviewIssue({}, { executionState: null })],
  ])("marks a review wake stale when %s", (_label, issue) => {
    expect(decide(stageWake("execution_review_requested"), issue)).toBe("stale");
  });

  it.each([
    ["queued comments", { wakeCommentIds: ["c1"] }, {}],
    ["an interaction continuation", { interactionId: "i1" }, {}],
    ["a resume intent", { resumeIntent: true }, {}],
    ["an interaction mutation", {}, { mutation: "interaction" }],
  ])("marks only the stage part stale when the wake also carries %s", (_label, seedExtra, payloadExtra) => {
    const wake = stageWake("execution_review_requested", reviewer, seedExtra, payloadExtra);
    expect(decide(wake, reviewIssue({ currentStageId: "stage-2" }))).toBe("stale_part");
    expect(decide(wake, reviewIssue())).toBe("current");
  });

  it("marks only the stage part stale for an authorized failed-chat retry or another wake reason", () => {
    expect(decide({ ...stageWake("execution_review_requested"), authorizedFailedChatRetry: true }, reviewIssue({ currentStageId: "stage-2" })))
      .toBe("stale_part");
    expect(decide(stageWake("issue_assigned"), reviewIssue({ currentStageId: "stage-2" }))).toBe("stale_part");
  });

  it("does not judge a wake without a saved stage id", () => {
    const wake = stageWake("execution_review_requested", reviewer, {}, {}, { stageType: "review" });
    expect(decide(wake, reviewIssue({}, { status: "done" }))).toBe("not_applicable");
  });
});

describe("decideExecutionWakeFreshness: system continuations are not judged", () => {
  it.each([
    ["in progress", openIssue],
    ["blocked", { ...openIssue, status: "blocked" }],
    ["under an execution policy state", { ...openIssue, executionState: { status: "pending" } }],
    ["reassigned", { ...openIssue, assigneeAgentId: reviewer }],
  ])("does not judge a run liveness continuation when the issue is %s", (_label, issue) => {
    expect(decide(livenessWake(), issue)).toBe("not_applicable");
    expect(decide(livenessWake({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] }), issue)).toBe("not_applicable");
  });

  it("does not judge other system continuations", () => {
    const wake = { agentId: executor, payload: { issueId: "issue-1", _paperclipWakeContext: { issueId: "issue-1", wakeReason: "issue_continuation_needed" } } };
    expect(decide(wake, { ...openIssue, status: "blocked" })).toBe("not_applicable");
  });

  it("counts a carried liveness continuation as other work next to a stale stage", () => {
    const stageThenLiveness = stageWake("run_liveness_continuation", executor, { livenessContinuationSourceRunId: "run-0" }, {},
      { ...reviewerStage, wakeRole: "executor" });
    expect(decide(stageThenLiveness, reviewIssue({ currentStageId: "stage-2" }, { assigneeAgentId: executor }))).toBe("stale_part");
    const livenessUnderComment = stageWake("issue_commented", reviewer, { livenessContinuationSourceRunId: "run-0", wakeCommentIds: [] });
    expect(decide(livenessUnderComment, reviewIssue({ currentStageId: "stage-2" }))).toBe("stale_part");
  });

  it("does not judge ordinary wakes", () => {
    const wake = { agentId: executor, payload: { issueId: "issue-1", _paperclipWakeContext: { issueId: "issue-1", wakeReason: "issue_commented", wakeCommentIds: ["c1"] } } };
    expect(decide(wake, { ...openIssue, status: "done" })).toBe("not_applicable");
  });
});

describe("withoutStaleExecutionContext", () => {
  const strip = (wake: { agentId: string; payload: Record<string, unknown> }, issue: ExecutionWakeFreshnessFacts["issue"]) => {
    const seed = wake.payload._paperclipWakeContext as Record<string, unknown>;
    return withoutStaleExecutionContext({ agentId: wake.agentId, payload: wake.payload, deferredContextSeed: seed,
      wakeReason: (seed.wakeReason as string | undefined) ?? null }, issue);
  };

  it("drops a stale stage and turns its reason into a comment wake when comments remain", () => {
    const stripped = strip(stageWake("execution_review_requested", reviewer, { wakeCommentIds: ["c1"], source: "issue.execution_stage" }),
      reviewIssue({ currentStageId: "stage-2" }));
    expect(stripped.payload).not.toHaveProperty("executionStage");
    expect(stripped.deferredContextSeed).not.toHaveProperty("executionStage");
    expect(stripped.deferredContextSeed).not.toHaveProperty("source");
    expect(stripped.deferredContextSeed).toMatchObject({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] });
    expect(stripped.payload._paperclipWakeContext).toEqual(stripped.deferredContextSeed);
    expect(stripped.wakeReason).toBe("issue_commented");
  });

  it("drops a stale stage from a merged comment wake and keeps its comment reason", () => {
    const stripped = strip(stageWake("issue_commented", reviewer, { wakeCommentIds: ["c1"] }), reviewIssue({ currentStageId: "stage-2" }));
    expect(stripped.deferredContextSeed).not.toHaveProperty("executionStage");
    expect(stripped.wakeReason).toBe("issue_commented");
  });

  it("keeps a current stage untouched", () => {
    const wake = stageWake("issue_commented", reviewer, { wakeCommentIds: ["c1"] });
    expect(strip(wake, reviewIssue()).deferredContextSeed).toMatchObject({ executionStage: reviewerStage });
  });

  it("drops the stage reason and keeps interaction fields when no comments remain", () => {
    const stripped = strip(stageWake("execution_review_requested", reviewer, { interactionId: "i1" }, { mutation: "interaction" }),
      reviewIssue({ currentStageId: "stage-2" }));
    expect(stripped.deferredContextSeed).not.toHaveProperty("wakeReason");
    expect(stripped.deferredContextSeed).toMatchObject({ interactionId: "i1" });
    expect(stripped.payload).toMatchObject({ mutation: "interaction" });
    expect(stripped.wakeReason).toBeNull();
  });

  it("leaves a run liveness continuation and its payload fields alone", () => {
    const wake = livenessWake({ wakeReason: "issue_commented", wakeCommentIds: ["c1"] }, { commentId: "c1" });
    const stripped = strip(wake, { ...openIssue, status: "blocked" });
    expect(stripped.payload).toEqual(wake.payload);
    expect(stripped.wakeReason).toBe("issue_commented");
  });

  it("names a carried liveness continuation when it drops a stale stage reason and no comments remain", () => {
    const stripped = strip(stageWake("execution_review_requested", reviewer, { livenessContinuationSourceRunId: "run-0" }),
      reviewIssue({ currentStageId: "stage-2" }));
    expect(stripped.deferredContextSeed).not.toHaveProperty("executionStage");
    expect(stripped.deferredContextSeed).toMatchObject({ wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0" });
    expect(stripped.wakeReason).toBe("run_liveness_continuation");
  });

  it("keeps a carried liveness continuation when it drops a stale stage", () => {
    const stripped = strip(stageWake("run_liveness_continuation", reviewer, { livenessContinuationSourceRunId: "run-0" }),
      reviewIssue({ currentStageId: "stage-2" }));
    expect(stripped.deferredContextSeed).not.toHaveProperty("executionStage");
    expect(stripped.deferredContextSeed).toMatchObject({ wakeReason: "run_liveness_continuation", livenessContinuationSourceRunId: "run-0" });
  });
});

describe("carriesCurrentExecutionStage", () => {
  it("is true for a current stage, whatever reason the merged wake shows", () => {
    expect(carriesCurrentExecutionStage({ wake: stageWake("issue_commented", reviewer, { wakeCommentIds: ["c1"] }), issue: reviewIssue() })).toBe(true);
  });

  it("is false for a stale stage", () => {
    expect(carriesCurrentExecutionStage({ wake: stageWake("issue_commented"), issue: reviewIssue({ currentStageId: "stage-2" }) })).toBe(false);
  });

  it("is false for a run liveness continuation (not judged) and for a wake that carries no stage", () => {
    expect(carriesCurrentExecutionStage({ wake: livenessWake({ wakeReason: "issue_commented" }), issue: openIssue })).toBe(false);
    expect(carriesCurrentExecutionStage({ wake: { agentId: reviewer, payload: { _paperclipWakeContext: { wakeReason: "issue_commented" } } },
      issue: reviewIssue() })).toBe(false);
  });
});

describe("decideExecutionWakeFreshness: a comment reason with no comments left", () => {
  it("does not count as other work next to a stale stage", () => {
    expect(decide(stageWake("issue_commented", reviewer, { wakeCommentIds: [] }), reviewIssue({ currentStageId: "stage-2" }))).toBe("stale");
  });
});

describe("withExecutionWakeReasonRestored", () => {
  const restore = (wake: { agentId: string; payload: Record<string, unknown> }, issue: ExecutionWakeFreshnessFacts["issue"]) => {
    const seed = wake.payload._paperclipWakeContext as Record<string, unknown>;
    return withExecutionWakeReasonRestored({ ...wake, deferredContextSeed: seed,
      wakeReason: typeof seed.wakeReason === "string" ? seed.wakeReason : null }, issue);
  };

  it.each([
    ["reviewer", "execution_review_requested"],
    ["approver", "execution_approval_requested"],
  ])("gives a current %s stage its reason back once no comments remain", (wakeRole, reason) => {
    const stage = { ...reviewerStage, wakeRole };
    const restored = restore(stageWake("issue_commented", reviewer, { source: "issue.comment" }, {}, stage), reviewIssue());
    expect(restored.wakeReason).toBe(reason);
    expect(restored.deferredContextSeed).toMatchObject({ wakeReason: reason, source: "issue.execution_stage" });
    expect(restored.payload._paperclipWakeContext).toMatchObject({ wakeReason: reason });
  });

  it("gives an executor stage the changes-requested reason", () => {
    const stage = { ...reviewerStage, wakeRole: "executor" };
    const issue = reviewIssue({ status: "changes_requested" }, { assigneeAgentId: executor, status: "in_progress" });
    expect(restore(stageWake("issue_commented", executor, {}, {}, stage), issue).wakeReason).toBe("execution_changes_requested");
  });

  it.each([
    ["an open issue", openIssue],
    ["a blocked issue (not judged)", { ...openIssue, status: "blocked" }],
  ])("gives a carried liveness continuation its reason back and drops the comment source, for %s", (_label, issue) => {
    const restored = restore(livenessWake({ wakeReason: "issue_commented", source: "issue.comment" }), issue);
    expect(restored.wakeReason).toBe("run_liveness_continuation");
    expect(restored.deferredContextSeed).not.toHaveProperty("source");
  });

  it("prefers a current stage's reason over a carried liveness continuation", () => {
    const wake = stageWake("issue_commented", reviewer, { livenessContinuationSourceRunId: "run-0" });
    expect(restore(wake, reviewIssue()).wakeReason).toBe("execution_review_requested");
  });

  it("leaves a wake with queued comments, a non-comment reason, or only stale parts unchanged", () => {
    const withComments = stageWake("issue_commented", reviewer, { wakeCommentIds: ["c1"] });
    expect(restore(withComments, reviewIssue()).wakeReason).toBe("issue_commented");
    const interaction = stageWake("issue_interaction_answered");
    expect(restore(interaction, reviewIssue()).wakeReason).toBe("issue_interaction_answered");
    expect(restore(stageWake("issue_commented"), reviewIssue({ currentStageId: "stage-2" })).wakeReason).toBe("issue_commented");
  });
});
