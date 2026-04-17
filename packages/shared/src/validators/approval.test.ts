import { describe, expect, it } from "vitest";
import {
  createApprovalSchema,
  resolveApprovalSchema,
  requestApprovalRevisionSchema,
  resubmitApprovalSchema,
  addApprovalCommentSchema,
} from "./approval.js";

describe("createApprovalSchema", () => {
  const valid = {
    type: "hire_agent" as const,
    payload: { agentId: "00000000-0000-0000-0000-000000000001" },
  };

  it("accepts a minimal approval", () => {
    expect(createApprovalSchema.safeParse(valid).success).toBe(true);
  });

  it("accepts all valid approval types", () => {
    const types = [
      "hire_agent",
      "approve_ceo_strategy",
      "budget_override_required",
      "request_board_approval",
    ];
    for (const type of types) {
      expect(createApprovalSchema.safeParse({ ...valid, type }).success).toBe(true);
    }
  });

  it("rejects an invalid approval type", () => {
    expect(createApprovalSchema.safeParse({ ...valid, type: "unknown_type" }).success).toBe(false);
  });

  it("accepts optional requestedByAgentId", () => {
    const result = createApprovalSchema.safeParse({
      ...valid,
      requestedByAgentId: "00000000-0000-0000-0000-000000000002",
    });
    expect(result.success).toBe(true);
  });

  it("rejects non-uuid requestedByAgentId", () => {
    expect(
      createApprovalSchema.safeParse({ ...valid, requestedByAgentId: "not-uuid" }).success,
    ).toBe(false);
  });

  it("accepts optional issueIds array", () => {
    const result = createApprovalSchema.safeParse({
      ...valid,
      issueIds: ["00000000-0000-0000-0000-000000000003"],
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty payload object", () => {
    expect(createApprovalSchema.safeParse({ type: "hire_agent", payload: {} }).success).toBe(true);
  });
});

describe("resolveApprovalSchema", () => {
  it("accepts an empty object (all optional)", () => {
    expect(resolveApprovalSchema.safeParse({}).success).toBe(true);
  });

  it("defaults decidedByUserId to board", () => {
    const result = resolveApprovalSchema.safeParse({});
    expect(result.success && result.data.decidedByUserId).toBe("board");
  });

  it("accepts a custom decidedByUserId", () => {
    const result = resolveApprovalSchema.safeParse({ decidedByUserId: "user-1" });
    expect(result.success && result.data.decidedByUserId).toBe("user-1");
  });

  it("accepts optional decisionNote", () => {
    expect(resolveApprovalSchema.safeParse({ decisionNote: "Looks good" }).success).toBe(true);
  });
});

describe("requestApprovalRevisionSchema", () => {
  it("accepts an empty object", () => {
    expect(requestApprovalRevisionSchema.safeParse({}).success).toBe(true);
  });

  it("defaults decidedByUserId to board", () => {
    const result = requestApprovalRevisionSchema.safeParse({});
    expect(result.success && result.data.decidedByUserId).toBe("board");
  });
});

describe("resubmitApprovalSchema", () => {
  it("accepts an empty object", () => {
    expect(resubmitApprovalSchema.safeParse({}).success).toBe(true);
  });

  it("accepts an updated payload", () => {
    const result = resubmitApprovalSchema.safeParse({
      payload: { newField: "value" },
    });
    expect(result.success).toBe(true);
  });
});

describe("addApprovalCommentSchema", () => {
  it("accepts a valid comment body", () => {
    expect(addApprovalCommentSchema.safeParse({ body: "Please revise." }).success).toBe(true);
  });

  it("rejects an empty body", () => {
    expect(addApprovalCommentSchema.safeParse({ body: "" }).success).toBe(false);
  });
});
