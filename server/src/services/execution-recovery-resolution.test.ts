import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  blocksSafeHandBackForPendingStage,
  isVerifiedPreStartCancelledReviewerRun,
} from "./execution-recovery-resolution.js";

type Input = Parameters<typeof isVerifiedPreStartCancelledReviewerRun>[0];

const agentR = randomUUID();
const agentC = randomUUID();
const stage1 = randomUUID();
const run1 = randomUUID();
const user1 = randomUUID();

function verified(): Input {
  return {
    task: {
      status: "in_review",
      assigneeAgentId: agentR,
      executionState: {
        status: "pending",
        currentStageId: stage1,
        currentStageIndex: 0,
        currentStageType: "review",
        currentParticipant: { type: "agent", agentId: agentR },
        returnAssignee: { type: "agent", agentId: agentC },
        reviewRequest: null,
        completedStageIds: [],
        lastDecisionId: null,
        lastDecisionOutcome: null,
      },
    },
    run: { status: "cancelled", agentId: agentR, startedAt: null, processPid: null, processGroupId: null },
    returnOwnerAgentId: agentR,
    decision: { runId: run1, providerStopped: true, actionOutcome: "not_performed", outcomeEvidence: "Never started." },
  };
}

function withState(patch: Record<string, unknown> | null): Input {
  const input = verified();
  return {
    ...input,
    task: { ...input.task, executionState: patch && { ...(input.task.executionState as object), ...patch } },
  };
}

describe("isVerifiedPreStartCancelledReviewerRun", () => {
  it("admits the current reviewer's run that was cancelled before it started", () => {
    expect(isVerifiedPreStartCancelledReviewerRun(verified())).toBe(true);
  });

  const base = verified();
  it.each<[string, Input]>([
    ["the task is not in review", { ...base, task: { ...base.task, status: "todo" } }],
    ["there is no execution state", withState(null)],
    ["the stage is not pending", withState({ status: "changes_requested" })],
    ["the stage is an approval stage", withState({ currentStageType: "approval" })],
    ["the participant is a user", withState({ currentParticipant: { type: "user", userId: user1 } })],
    ["the participant is another agent", withState({ currentParticipant: { type: "agent", agentId: agentC } })],
    ["the assignee is another agent", { ...base, task: { ...base.task, assigneeAgentId: agentC } }],
    ["the return owner is another agent", { ...base, returnOwnerAgentId: agentC }],
    ["there is no return owner", { ...base, returnOwnerAgentId: null }],
    ["the run failed instead of being cancelled", { ...base, run: { ...base.run, status: "failed" } }],
    ["the run started", { ...base, run: { ...base.run, startedAt: new Date("2026-01-01T00:00:00Z") } }],
    ["the run recorded a process", { ...base, run: { ...base.run, processPid: 4242 } }],
    ["the run recorded a process group", { ...base, run: { ...base.run, processGroupId: 4242 } }],
    ["the action outcome is mixed", { ...base, decision: { ...base.decision, actionOutcome: "mixed" } }],
    ["the action outcome is completed", { ...base, decision: { ...base.decision, actionOutcome: "completed" } }],
  ])("rejects when %s", (_name, input) => {
    expect(isVerifiedPreStartCancelledReviewerRun(input)).toBe(false);
  });
});

describe("blocksSafeHandBackForPendingStage", () => {
  const stateOf = (input: Input) => input.task.executionState;

  it("keeps a pending approval stage gated even when review resume is allowed", () => {
    const executionState = stateOf(withState({ currentStageType: "approval" }));
    expect(blocksSafeHandBackForPendingStage({ executionState, allowPendingReviewStage: true })).toBe(true);
    expect(blocksSafeHandBackForPendingStage({ executionState, allowPendingReviewStage: false })).toBe(true);
  });

  it("lets only an explicit review resume pass a pending review stage", () => {
    const executionState = stateOf(verified());
    expect(blocksSafeHandBackForPendingStage({ executionState, allowPendingReviewStage: true })).toBe(false);
    expect(blocksSafeHandBackForPendingStage({ executionState, allowPendingReviewStage: false })).toBe(true);
  });

  it("does not gate hand-back when no stage is pending", () => {
    for (const executionState of [null, stateOf(withState({ status: "changes_requested" }))]) {
      expect(blocksSafeHandBackForPendingStage({ executionState, allowPendingReviewStage: false })).toBe(false);
      expect(blocksSafeHandBackForPendingStage({ executionState, allowPendingReviewStage: true })).toBe(false);
    }
  });
});
