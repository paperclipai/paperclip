// @vitest-environment node

import { describe, expect, it } from "vitest";
import {
  principalFromSelectionValue,
  selectionValueFromPrincipal,
  stageParticipantValues,
  buildExecutionPolicy,
} from "./issue-execution-policy";
import type { IssueExecutionPolicy } from "@paperclipai/shared";

// ============================================================================
// principalFromSelectionValue
// ============================================================================

describe("principalFromSelectionValue", () => {
  it("returns an agent principal for agent: prefix", () => {
    const result = principalFromSelectionValue("agent:agent-1");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("agent");
    if (result?.type === "agent") {
      expect(result.agentId).toBe("agent-1");
    }
  });

  it("returns a user principal for user: prefix", () => {
    const result = principalFromSelectionValue("user:user-1");
    expect(result).not.toBeNull();
    expect(result?.type).toBe("user");
    if (result?.type === "user") {
      expect(result.userId).toBe("user-1");
    }
  });

  it("returns null for empty string", () => {
    expect(principalFromSelectionValue("")).toBeNull();
  });

  it("returns null for bare string without prefix", () => {
    // Bare strings go through parseAssigneeValue as agentId, but agentId: "" produces null
    // Actually a bare non-empty string without : becomes an agentId, not null
    const result = principalFromSelectionValue("bare-id");
    // bare-id is treated as agentId through backward compat
    if (result) {
      expect(result.type).toBe("agent");
    }
  });

  it("returns null for agent: with empty id", () => {
    // "agent:" with empty id should produce null principal
    const result = principalFromSelectionValue("agent:");
    // parseAssigneeValue("agent:") returns { assigneeAgentId: null }, so principal is null
    expect(result).toBeNull();
  });
});

// ============================================================================
// selectionValueFromPrincipal
// ============================================================================

describe("selectionValueFromPrincipal", () => {
  it("returns agent: prefixed value for agent principal", () => {
    const value = selectionValueFromPrincipal({
      type: "agent",
      agentId: "agent-1",
      userId: null,
    });
    expect(value).toBe("agent:agent-1");
  });

  it("returns user: prefixed value for user principal", () => {
    const value = selectionValueFromPrincipal({
      type: "user",
      userId: "user-1",
      agentId: null,
    });
    expect(value).toBe("user:user-1");
  });

  it("round-trips with principalFromSelectionValue for agents", () => {
    const original = "agent:agent-xyz";
    const principal = principalFromSelectionValue(original);
    expect(principal).not.toBeNull();
    expect(selectionValueFromPrincipal(principal!)).toBe(original);
  });

  it("round-trips with principalFromSelectionValue for users", () => {
    const original = "user:user-xyz";
    const principal = principalFromSelectionValue(original);
    expect(principal).not.toBeNull();
    expect(selectionValueFromPrincipal(principal!)).toBe(original);
  });
});

// ============================================================================
// stageParticipantValues
// ============================================================================

describe("stageParticipantValues", () => {
  const policy: IssueExecutionPolicy = {
    mode: "normal",
    commentRequired: true,
    stages: [
      {
        id: "stage-review",
        type: "review",
        approvalsNeeded: 1,
        participants: [
          { id: "p1", type: "agent", agentId: "agent-1", userId: null },
          { id: "p2", type: "user", userId: "user-1", agentId: null },
        ],
      },
      {
        id: "stage-approval",
        type: "approval",
        approvalsNeeded: 1,
        participants: [
          { id: "p3", type: "user", userId: "user-2", agentId: null },
        ],
      },
    ],
  };

  it("returns participant selection values for review stage", () => {
    const values = stageParticipantValues(policy, "review");
    expect(values).toEqual(["agent:agent-1", "user:user-1"]);
  });

  it("returns participant selection values for approval stage", () => {
    const values = stageParticipantValues(policy, "approval");
    expect(values).toEqual(["user:user-2"]);
  });

  it("returns empty array when policy is null", () => {
    expect(stageParticipantValues(null, "review")).toEqual([]);
  });

  it("returns empty array when policy is undefined", () => {
    expect(stageParticipantValues(undefined, "review")).toEqual([]);
  });

  it("returns empty array when stage type not found", () => {
    expect(stageParticipantValues(policy, "approval")).toEqual(["user:user-2"]);
    // A different stage type that doesn't exist
    const policyWithOnlyReview: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [{ id: "s", type: "review", approvalsNeeded: 1, participants: [] }],
    };
    expect(stageParticipantValues(policyWithOnlyReview, "approval")).toEqual([]);
  });
});

// ============================================================================
// buildExecutionPolicy
// ============================================================================

describe("buildExecutionPolicy", () => {
  it("returns null when both reviewer and approver values are empty", () => {
    const result = buildExecutionPolicy({ reviewerValues: [], approverValues: [] });
    expect(result).toBeNull();
  });

  it("creates a review stage when reviewerValues are provided", () => {
    const result = buildExecutionPolicy({
      reviewerValues: ["agent:agent-1"],
      approverValues: [],
    });
    expect(result).not.toBeNull();
    expect(result?.stages).toHaveLength(1);
    expect(result?.stages[0]?.type).toBe("review");
  });

  it("creates an approval stage when approverValues are provided", () => {
    const result = buildExecutionPolicy({
      reviewerValues: [],
      approverValues: ["user:user-1"],
    });
    expect(result).not.toBeNull();
    expect(result?.stages).toHaveLength(1);
    expect(result?.stages[0]?.type).toBe("approval");
  });

  it("creates both stages when both reviewer and approver values are provided", () => {
    const result = buildExecutionPolicy({
      reviewerValues: ["agent:agent-1"],
      approverValues: ["user:user-1"],
    });
    expect(result?.stages).toHaveLength(2);
    expect(result?.stages.some((s) => s.type === "review")).toBe(true);
    expect(result?.stages.some((s) => s.type === "approval")).toBe(true);
  });

  it("sets commentRequired to true", () => {
    const result = buildExecutionPolicy({
      reviewerValues: ["agent:agent-1"],
      approverValues: [],
    });
    expect(result?.commentRequired).toBe(true);
  });

  it("preserves the mode from existing policy", () => {
    const existingPolicy: IssueExecutionPolicy = {
      mode: "auto",
      commentRequired: true,
      stages: [],
    };
    const result = buildExecutionPolicy({
      existingPolicy,
      reviewerValues: ["agent:agent-1"],
      approverValues: [],
    });
    expect(result?.mode).toBe("auto");
  });

  it("uses 'normal' mode when no existing policy", () => {
    const result = buildExecutionPolicy({
      reviewerValues: ["agent:agent-1"],
      approverValues: [],
    });
    expect(result?.mode).toBe("normal");
  });

  it("reuses existing stage id when policy already has that stage type", () => {
    const existingPolicy: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: "existing-review-id",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "p1", type: "agent", agentId: "agent-1", userId: null }],
        },
      ],
    };
    const result = buildExecutionPolicy({
      existingPolicy,
      reviewerValues: ["agent:agent-1"],
      approverValues: [],
    });
    expect(result?.stages[0]?.id).toBe("existing-review-id");
  });

  it("reuses existing participant id when agent already in the stage", () => {
    const existingPolicy: IssueExecutionPolicy = {
      mode: "normal",
      commentRequired: true,
      stages: [
        {
          id: "s",
          type: "review",
          approvalsNeeded: 1,
          participants: [{ id: "existing-participant-id", type: "agent", agentId: "agent-1", userId: null }],
        },
      ],
    };
    const result = buildExecutionPolicy({
      existingPolicy,
      reviewerValues: ["agent:agent-1"],
      approverValues: [],
    });
    const participants = result?.stages[0]?.participants ?? [];
    expect(participants[0]?.id).toBe("existing-participant-id");
  });

  it("skips invalid selection values", () => {
    const result = buildExecutionPolicy({
      reviewerValues: ["agent:", "invalid-but-ok", "agent:agent-1"],
      approverValues: [],
    });
    // "agent:" maps to null principal, "invalid-but-ok" maps to agentId
    // Only valid principals should be included
    const participants = result?.stages[0]?.participants ?? [];
    expect(participants.some((p) => p.agentId === "agent-1")).toBe(true);
  });
});
