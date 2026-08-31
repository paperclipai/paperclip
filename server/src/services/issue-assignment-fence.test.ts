import { describe, expect, it } from "vitest";
import {
  NATIVE_SPARK_EXECUTOR_AGENT_ID,
  applyIssueAssignmentFenceTransition,
  assertIssueAssignmentFence,
  nativeSparkInvokabilityBlockReason,
} from "./issue-assignment-fence.js";

const SPILL_EXECUTOR_AGENT_ID = "11111111-1111-4111-8111-111111111111";
const METERED_EXECUTOR_AGENT_ID = "22222222-2222-4222-8222-222222222222";
const RECEIPT_TIME = new Date("2026-08-30T12:00:00.000Z");

function fencedIssue(overrides: Record<string, unknown> = {}) {
  return {
    status: "blocked",
    assigneeAgentId: null,
    assigneeUserId: null,
    executionPolicy: {
      assignmentFence: {
        kind: "native_spark_only",
        allowedAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      },
    },
    executionState: null,
    ...overrides,
  };
}

function freshReceipt() {
  return {
    agentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
    observedAt: RECEIPT_TIME.toISOString(),
    expiresAt: new Date(RECEIPT_TIME.getTime() + 5 * 60_000).toISOString(),
    source: "native" as const,
  };
}

describe("native Spark assignment fence", () => {
  it("does not issue a receipt for idle Spark with a persisted error", () => {
    expect(nativeSparkInvokabilityBlockReason({
      status: "idle",
      errorReason: "Internal error",
      lastHeartbeatAt: RECEIPT_TIME,
    }, RECEIPT_TIME)).toBe("error_present");
  });

  it("does not issue a receipt without a recent heartbeat", () => {
    expect(nativeSparkInvokabilityBlockReason({
      status: "idle",
      errorReason: null,
      lastHeartbeatAt: new Date(RECEIPT_TIME.getTime() - 5 * 60_001),
    }, RECEIPT_TIME)).toBe("heartbeat_stale");
  });

  it("accepts only clean idle Spark health with a recent heartbeat", () => {
    expect(nativeSparkInvokabilityBlockReason({
      status: "idle",
      errorReason: null,
      lastHeartbeatAt: RECEIPT_TIME,
    }, RECEIPT_TIME)).toBeNull();
  });

  it("rejects a non-idle Spark status from receipt issuance", () => {
    expect(nativeSparkInvokabilityBlockReason({
      status: "running",
      errorReason: null,
      lastHeartbeatAt: RECEIPT_TIME,
    }, RECEIPT_TIME)).toBe("status_not_idle");
  });

  it("rejects receipt issuance when Spark has never heartbeated", () => {
    expect(nativeSparkInvokabilityBlockReason({
      status: "idle",
      errorReason: null,
      lastHeartbeatAt: null,
    }, RECEIPT_TIME)).toBe("heartbeat_missing");
  });

  it("rejects Spill before a Spark invokability receipt exists", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue(),
      nextAssigneeAgentId: SPILL_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "blocked",
      assignmentIntent: "explicit",
      now: RECEIPT_TIME,
    })).toThrow(/assignment fence/i);
  });

  it("rejects a metered fallback before a Spark invokability receipt exists", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue(),
      nextAssigneeAgentId: METERED_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "blocked",
      assignmentIntent: "automatic",
      now: RECEIPT_TIME,
    })).toThrow(/assignment fence/i);
  });

  it("rejects Spark until the receipt is fresh and native", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue({ executionState: { assignmentFenceReceipt: freshReceipt() } }),
      nextAssigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "blocked",
      assignmentIntent: "explicit",
      now: new Date("2026-08-30T12:06:00.000Z"),
    })).toThrow(/receipt/i);
  });

  it("rejects automatic Spark recovery even with a fresh receipt", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue({ executionState: { assignmentFenceReceipt: freshReceipt() } }),
      nextAssigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "blocked",
      assignmentIntent: "automatic",
      now: new Date("2026-08-30T12:01:00.000Z"),
    })).toThrow(/explicit/i);
  });

  it("rejects Spill recovery even after a fresh Spark receipt", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue({ executionState: { assignmentFenceReceipt: freshReceipt() } }),
      nextAssigneeAgentId: SPILL_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "blocked",
      assignmentIntent: "automatic",
      now: new Date("2026-08-30T12:01:00.000Z"),
    })).toThrow(/assignment fence/i);
  });

  it("rejects a user assignment and preserves blocked state under the fence", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue(),
      nextAssigneeAgentId: null,
      nextAssigneeUserId: "local-board",
      nextStatus: "todo",
      assignmentIntent: "explicit",
      now: RECEIPT_TIME,
    })).toThrow(/assignment fence/i);
  });

  it("allows only an explicit Spark assignment after a fresh receipt", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue({ executionState: { assignmentFenceReceipt: freshReceipt() } }),
      nextAssigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "in_progress",
      assignmentIntent: "explicit",
      now: new Date("2026-08-30T12:01:00.000Z"),
    })).not.toThrow();
  });

  it("allows delivery updates when the authorized Spark assignment is unchanged", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue({
        status: "in_progress",
        assigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        executionState: { assignmentFenceAuthorization: {
          agentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
          assignedAt: RECEIPT_TIME.toISOString(),
          source: "explicit",
        } },
      }),
      nextAssigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "in_progress",
      assignmentIntent: "unchanged",
      now: new Date("2026-08-30T12:06:00.000Z"),
    })).not.toThrow();
  });

  it("does not let checkout establish Spark authorization", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue({
        assigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        executionState: { assignmentFenceReceipt: freshReceipt() },
      }),
      nextAssigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      nextStatus: "in_progress",
      assignmentIntent: "checkout",
      now: new Date("2026-08-30T12:01:00.000Z"),
    })).toThrow(/authorization/i);
  });

  it("rejects an automatic release that would move a fenced issue to todo", () => {
    expect(() => assertIssueAssignmentFence({
      issue: fencedIssue(),
      nextAssigneeAgentId: null,
      nextAssigneeUserId: null,
      nextStatus: "todo",
      assignmentIntent: "automatic",
      now: RECEIPT_TIME,
    })).toThrow(/blocked/i);
  });

  it("records explicit Spark authorization for later checkout and clears it when released", () => {
    const authorized = applyIssueAssignmentFenceTransition({
      issue: fencedIssue({ executionState: { assignmentFenceReceipt: freshReceipt() } }),
      currentExecutionState: { assignmentFenceReceipt: freshReceipt() },
      nextAssigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
      nextAssigneeUserId: null,
      assignmentIntent: "explicit",
      now: RECEIPT_TIME,
    });
    expect(authorized).toMatchObject({
      assignmentFenceAuthorization: {
        agentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        source: "explicit",
      },
    });

    const released = applyIssueAssignmentFenceTransition({
      issue: fencedIssue({
        assigneeAgentId: NATIVE_SPARK_EXECUTOR_AGENT_ID,
        executionState: authorized,
      }),
      currentExecutionState: authorized,
      nextAssigneeAgentId: null,
      nextAssigneeUserId: null,
      assignmentIntent: "explicit",
      now: RECEIPT_TIME,
    });
    expect(released?.assignmentFenceAuthorization).toBeNull();
  });
});
