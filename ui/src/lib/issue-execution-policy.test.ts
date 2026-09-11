import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema, type IssueExecutionPolicy, type IssueExecutionState } from "@paperclipai/shared";
import { buildExecutionPolicy, pendingStageDecisionFor } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildExecutionPolicy", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });
});

describe("pendingStageDecisionFor", () => {
  const policy: IssueExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [],
  };
  const state: IssueExecutionState = {
    status: "pending",
    currentStageId: "approval-stage",
    currentStageIndex: 0,
    currentStageType: "approval",
    currentParticipant: { type: "user", agentId: null, userId: "user-1" },
    returnAssignee: { type: "agent", agentId: AGENT_ID, userId: null },
    reviewRequest: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
  };

  it("returns required-comment context for the matching pending board user", () => {
    expect(pendingStageDecisionFor({ executionPolicy: policy, executionState: state }, "user-1"))
      .toEqual({ stageType: "approval", commentRequired: true });
  });

  it("keeps the server-required comment for a legacy policy with the flag disabled", () => {
    expect(pendingStageDecisionFor({
      executionPolicy: { ...policy, commentRequired: false },
      executionState: state,
    }, "user-1")).toEqual({ stageType: "approval", commentRequired: true });
  });

  it("does not expose another participant's or an agent's decision", () => {
    expect(pendingStageDecisionFor({ executionPolicy: policy, executionState: state }, "user-2"))
      .toBeNull();
    expect(pendingStageDecisionFor({
      executionPolicy: policy,
      executionState: {
        ...state,
        currentParticipant: { type: "agent", agentId: AGENT_ID, userId: null },
      },
    }, "user-1")).toBeNull();
  });
});
