import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import type { Issue } from "@paperclipai/shared";
import { buildExecutionPolicy, isPendingExecutionParticipant } from "./issue-execution-policy";

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

describe("isPendingExecutionParticipant", () => {
  const issueWith = (
    overrides: Partial<Issue["executionState"] & object>,
    status: Issue["status"] = "in_review",
  ) => ({
    status,
    executionState: {
      status: "pending",
      currentStageId: null,
      currentStageIndex: null,
      currentStageType: "approval",
      currentParticipant: { type: "user", userId: "user-1", agentId: null },
      returnAssignee: null,
      reviewRequest: null,
      completedStageIds: [],
      lastDecisionId: null,
      lastDecisionOutcome: null,
      ...overrides,
    },
  }) as Pick<Issue, "status" | "executionState">;

  it("is true only for the user the pending stage waits on", () => {
    expect(isPendingExecutionParticipant(issueWith({}), "user-1")).toBe(true);
    expect(isPendingExecutionParticipant(issueWith({}), "user-2")).toBe(false);
  });

  it("is false outside a pending in_review stage, or when the participant is an agent", () => {
    expect(isPendingExecutionParticipant(issueWith({}, "in_progress"), "user-1")).toBe(false);
    expect(isPendingExecutionParticipant(issueWith({ status: "changes_requested" }), "user-1")).toBe(false);
    expect(isPendingExecutionParticipant(
      issueWith({ currentParticipant: { type: "agent", agentId: AGENT_ID, userId: null } }),
      "user-1",
    )).toBe(false);
    expect(isPendingExecutionParticipant({ status: "in_review" }, "user-1")).toBe(false);
  });

  it("never matches a signed-out viewer against a null participant id", () => {
    expect(isPendingExecutionParticipant(
      issueWith({ currentParticipant: { type: "user", userId: null, agentId: null } }),
      undefined,
    )).toBe(false);
  });
});
