import { describe, expect, it } from "vitest";
import { createCostEventSchema, updateBudgetSchema } from "./cost.js";

const validCostEvent = {
  agentId: "00000000-0000-0000-0000-000000000001",
  provider: "anthropic",
  model: "claude-3-5-sonnet",
  costCents: 50,
  occurredAt: "2026-01-01T00:00:00.000Z",
};

describe("createCostEventSchema", () => {
  it("accepts a minimal valid cost event", () => {
    expect(createCostEventSchema.safeParse(validCostEvent).success).toBe(true);
  });

  it("defaults biller to provider when not specified", () => {
    const result = createCostEventSchema.safeParse(validCostEvent);
    expect(result.success && result.data.biller).toBe("anthropic");
  });

  it("uses explicit biller when provided", () => {
    const result = createCostEventSchema.safeParse({ ...validCostEvent, biller: "partner" });
    expect(result.success && result.data.biller).toBe("partner");
  });

  it("defaults billingType to unknown", () => {
    const result = createCostEventSchema.safeParse(validCostEvent);
    expect(result.success && result.data.billingType).toBe("unknown");
  });

  it("defaults token counts to 0", () => {
    const result = createCostEventSchema.safeParse(validCostEvent);
    expect(result.success && result.data.inputTokens).toBe(0);
    expect(result.success && result.data.outputTokens).toBe(0);
    expect(result.success && result.data.cachedInputTokens).toBe(0);
  });

  it("accepts a full cost event with all optional fields", () => {
    const full = {
      ...validCostEvent,
      issueId: "00000000-0000-0000-0000-000000000002",
      projectId: "00000000-0000-0000-0000-000000000003",
      goalId: "00000000-0000-0000-0000-000000000004",
      heartbeatRunId: "00000000-0000-0000-0000-000000000005",
      billingCode: "B-001",
      biller: "custom",
      billingType: "metered_api",
      inputTokens: 100,
      cachedInputTokens: 20,
      outputTokens: 50,
    };
    expect(createCostEventSchema.safeParse(full).success).toBe(true);
  });

  it("rejects negative costCents", () => {
    expect(createCostEventSchema.safeParse({ ...validCostEvent, costCents: -1 }).success).toBe(false);
  });

  it("rejects a non-integer costCents", () => {
    expect(createCostEventSchema.safeParse({ ...validCostEvent, costCents: 1.5 }).success).toBe(false);
  });

  it("rejects an invalid agentId (non-uuid)", () => {
    expect(createCostEventSchema.safeParse({ ...validCostEvent, agentId: "not-a-uuid" }).success).toBe(false);
  });

  it("rejects an invalid occurredAt (non-ISO date)", () => {
    expect(
      createCostEventSchema.safeParse({ ...validCostEvent, occurredAt: "2026-01-01" }).success,
    ).toBe(false);
  });

  it("rejects an empty provider", () => {
    expect(createCostEventSchema.safeParse({ ...validCostEvent, provider: "" }).success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(createCostEventSchema.safeParse({ agentId: "00000000-0000-0000-0000-000000000001" }).success).toBe(false);
  });
});

describe("updateBudgetSchema", () => {
  it("accepts a valid non-negative budget", () => {
    expect(updateBudgetSchema.safeParse({ budgetMonthlyCents: 10000 }).success).toBe(true);
    expect(updateBudgetSchema.safeParse({ budgetMonthlyCents: 0 }).success).toBe(true);
  });

  it("rejects a negative budget", () => {
    expect(updateBudgetSchema.safeParse({ budgetMonthlyCents: -1 }).success).toBe(false);
  });

  it("rejects a non-integer budget", () => {
    expect(updateBudgetSchema.safeParse({ budgetMonthlyCents: 99.5 }).success).toBe(false);
  });

  it("rejects a missing budget field", () => {
    expect(updateBudgetSchema.safeParse({}).success).toBe(false);
  });
});
