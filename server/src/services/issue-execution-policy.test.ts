import { describe, it, expect } from "vitest";
import {
  normalizeIssueExecutionPolicy,
  parseIssueExecutionState,
  assigneePrincipal,
} from "./issue-execution-policy.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const AGENT_UUID = "aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa";
const AGENT_UUID_2 = "dddddddd-dddd-4ddd-dddd-dddddddddddd";
const USER_ID = "user-abc";
const STAGE_UUID = "bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb";
const DECISION_UUID = "cccccccc-cccc-4ccc-cccc-cccccccccccc";

/** Minimal stage fixture with a valid agent participant */
function agentStage(stageOverrides: Record<string, unknown> = {}) {
  return {
    type: "review",
    participants: [{ type: "agent", agentId: AGENT_UUID }],
    ...stageOverrides,
  };
}

/** Minimal valid policy with one agent review stage */
function singleAgentPolicy(policyOverrides: Record<string, unknown> = {}) {
  return { stages: [agentStage()], ...policyOverrides };
}

function makeExecutionState(overrides: Record<string, unknown> = {}) {
  return {
    status: "pending",
    currentStageId: STAGE_UUID,
    currentStageIndex: 0,
    currentStageType: "review",
    currentParticipant: { type: "agent", agentId: AGENT_UUID, userId: null },
    returnAssignee: null,
    completedStageIds: [],
    lastDecisionId: null,
    lastDecisionOutcome: null,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// normalizeIssueExecutionPolicy
// ---------------------------------------------------------------------------

describe("normalizeIssueExecutionPolicy", () => {
  it("returns null for null input", () => {
    expect(normalizeIssueExecutionPolicy(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(normalizeIssueExecutionPolicy(undefined)).toBeNull();
  });

  it("returns null when stages array is empty (no valid stages)", () => {
    expect(normalizeIssueExecutionPolicy({ stages: [] })).toBeNull();
  });

  it("returns null when input has no stages property (defaults to empty)", () => {
    expect(normalizeIssueExecutionPolicy({})).toBeNull();
  });

  it("returns a normalized policy for a valid input with one stage", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result).not.toBeNull();
    expect(result!.stages).toHaveLength(1);
  });

  it("defaults mode to 'normal' when not provided", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result!.mode).toBe("normal");
  });

  it("preserves an explicit mode value of 'auto'", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy({ mode: "auto" }));
    expect(result!.mode).toBe("auto");
  });

  it("always returns commentRequired: true (hardcoded)", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result!.commentRequired).toBe(true);
  });

  it("assigns a UUID to a stage that has no id", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result!.stages[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("preserves an existing stage id", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [agentStage({ id: STAGE_UUID })],
    });
    expect(result!.stages[0].id).toBe(STAGE_UUID);
  });

  it("assigns a UUID to each participant that has no id", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result!.stages[0].participants[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("deduplicates participants with the same agentId", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: AGENT_UUID },
            { type: "agent", agentId: AGENT_UUID },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("keeps two participants with different agentIds", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "agent", agentId: AGENT_UUID },
            { type: "agent", agentId: AGENT_UUID_2 },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(2);
  });

  it("deduplicates participants with the same userId", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        {
          type: "review",
          participants: [
            { type: "user", userId: USER_ID },
            { type: "user", userId: USER_ID },
          ],
        },
      ],
    });
    expect(result!.stages[0].participants).toHaveLength(1);
  });

  it("throws for a completely invalid input (non-object)", () => {
    expect(() => normalizeIssueExecutionPolicy("not-an-object")).toThrow();
  });

  it("handles a user participant correctly", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [{ type: "approval", participants: [{ type: "user", userId: USER_ID }] }],
    });
    expect(result!.stages[0].participants[0].type).toBe("user");
    expect(result!.stages[0].participants[0].userId).toBe(USER_ID);
    expect(result!.stages[0].participants[0].agentId).toBeNull();
  });

  it("sets agentId to null for user participants", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [{ type: "review", participants: [{ type: "user", userId: USER_ID }] }],
    });
    expect(result!.stages[0].participants[0].agentId).toBeNull();
  });

  it("sets userId to null for agent participants", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result!.stages[0].participants[0].userId).toBeNull();
  });

  it("sets approvalsNeeded to 1 for each stage", () => {
    const result = normalizeIssueExecutionPolicy(singleAgentPolicy());
    expect(result!.stages[0].approvalsNeeded).toBe(1);
  });

  it("normalizes multiple stages in order", () => {
    const result = normalizeIssueExecutionPolicy({
      stages: [
        { type: "review", participants: [{ type: "agent", agentId: AGENT_UUID }] },
        { type: "approval", participants: [{ type: "user", userId: USER_ID }] },
      ],
    });
    expect(result!.stages).toHaveLength(2);
    expect(result!.stages[0].type).toBe("review");
    expect(result!.stages[1].type).toBe("approval");
  });
});

// ---------------------------------------------------------------------------
// parseIssueExecutionState
// ---------------------------------------------------------------------------

describe("parseIssueExecutionState", () => {
  it("returns null for null input", () => {
    expect(parseIssueExecutionState(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(parseIssueExecutionState(undefined)).toBeNull();
  });

  it("returns null for an invalid input (missing required fields)", () => {
    expect(parseIssueExecutionState({})).toBeNull();
  });

  it("returns null for an unrecognized status value", () => {
    expect(parseIssueExecutionState(makeExecutionState({ status: "unknown_status" }))).toBeNull();
  });

  it("parses a valid 'pending' state", () => {
    const result = parseIssueExecutionState(makeExecutionState({ status: "pending" }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe("pending");
  });

  it("parses a valid 'idle' state", () => {
    const result = parseIssueExecutionState(
      makeExecutionState({
        status: "idle",
        currentStageId: null,
        currentStageIndex: null,
        currentStageType: null,
        currentParticipant: null,
      }),
    );
    expect(result).not.toBeNull();
    expect(result!.status).toBe("idle");
  });

  it("parses a valid 'completed' state", () => {
    const result = parseIssueExecutionState(makeExecutionState({ status: "completed" }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe("completed");
  });

  it("parses a valid 'changes_requested' state", () => {
    const result = parseIssueExecutionState(makeExecutionState({ status: "changes_requested" }));
    expect(result).not.toBeNull();
    expect(result!.status).toBe("changes_requested");
  });

  it("preserves the completedStageIds array", () => {
    const result = parseIssueExecutionState(makeExecutionState({ completedStageIds: [STAGE_UUID] }));
    expect(result!.completedStageIds).toEqual([STAGE_UUID]);
  });

  it("defaults completedStageIds to an empty array when not provided", () => {
    const state = makeExecutionState();
    delete (state as Record<string, unknown>).completedStageIds;
    const result = parseIssueExecutionState(state);
    expect(result!.completedStageIds).toEqual([]);
  });

  it("preserves lastDecisionOutcome when present", () => {
    const result = parseIssueExecutionState(
      makeExecutionState({ lastDecisionId: DECISION_UUID, lastDecisionOutcome: "approved" }),
    );
    expect(result!.lastDecisionOutcome).toBe("approved");
  });

  it("returns null for an unrecognized lastDecisionOutcome value", () => {
    const result = parseIssueExecutionState(
      makeExecutionState({ lastDecisionId: DECISION_UUID, lastDecisionOutcome: "bad_outcome" }),
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// assigneePrincipal
// ---------------------------------------------------------------------------

describe("assigneePrincipal", () => {
  it("returns null when both assigneeAgentId and assigneeUserId are absent", () => {
    expect(assigneePrincipal({})).toBeNull();
  });

  it("returns null when both assigneeAgentId and assigneeUserId are null", () => {
    expect(assigneePrincipal({ assigneeAgentId: null, assigneeUserId: null })).toBeNull();
  });

  it("returns an agent principal when assigneeAgentId is set", () => {
    const result = assigneePrincipal({ assigneeAgentId: AGENT_UUID });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("agent");
    expect(result!.agentId).toBe(AGENT_UUID);
    expect(result!.userId).toBeNull();
  });

  it("returns a user principal when assigneeUserId is set", () => {
    const result = assigneePrincipal({ assigneeUserId: USER_ID });
    expect(result).not.toBeNull();
    expect(result!.type).toBe("user");
    expect(result!.userId).toBe(USER_ID);
    expect(result!.agentId).toBeNull();
  });

  it("prefers assigneeAgentId over assigneeUserId when both are set", () => {
    const result = assigneePrincipal({ assigneeAgentId: AGENT_UUID, assigneeUserId: USER_ID });
    expect(result!.type).toBe("agent");
    expect(result!.agentId).toBe(AGENT_UUID);
  });
});
