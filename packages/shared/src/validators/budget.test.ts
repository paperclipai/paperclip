import { describe, expect, it } from "vitest";
import { upsertBudgetPolicySchema, resolveBudgetIncidentSchema } from "./budget.js";

describe("upsertBudgetPolicySchema", () => {
  const valid = {
    scopeType: "company" as const,
    scopeId: "00000000-0000-0000-0000-000000000001",
    amount: 10000,
  };

  it("accepts a minimal valid budget policy", () => {
    expect(upsertBudgetPolicySchema.safeParse(valid).success).toBe(true);
  });

  it("defaults metric to billed_cents", () => {
    const result = upsertBudgetPolicySchema.safeParse(valid);
    expect(result.success && result.data.metric).toBe("billed_cents");
  });

  it("defaults windowKind to calendar_month_utc", () => {
    const result = upsertBudgetPolicySchema.safeParse(valid);
    expect(result.success && result.data.windowKind).toBe("calendar_month_utc");
  });

  it("defaults warnPercent to 80", () => {
    const result = upsertBudgetPolicySchema.safeParse(valid);
    expect(result.success && result.data.warnPercent).toBe(80);
  });

  it("defaults hardStopEnabled to true", () => {
    const result = upsertBudgetPolicySchema.safeParse(valid);
    expect(result.success && result.data.hardStopEnabled).toBe(true);
  });

  it("defaults isActive to true", () => {
    const result = upsertBudgetPolicySchema.safeParse(valid);
    expect(result.success && result.data.isActive).toBe(true);
  });

  it("accepts valid scopeType values", () => {
    for (const scopeType of ["company", "agent", "project"]) {
      expect(upsertBudgetPolicySchema.safeParse({ ...valid, scopeType }).success).toBe(true);
    }
  });

  it("rejects invalid scopeType", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, scopeType: "user" }).success).toBe(false);
  });

  it("rejects non-uuid scopeId", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, scopeId: "not-uuid" }).success).toBe(false);
  });

  it("rejects a negative amount", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, amount: -1 }).success).toBe(false);
  });

  it("rejects a non-integer amount", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, amount: 99.5 }).success).toBe(false);
  });

  it("rejects warnPercent below 1", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, warnPercent: 0 }).success).toBe(false);
  });

  it("rejects warnPercent above 99", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, warnPercent: 100 }).success).toBe(false);
  });

  it("accepts windowKind lifetime", () => {
    expect(upsertBudgetPolicySchema.safeParse({ ...valid, windowKind: "lifetime" }).success).toBe(true);
  });
});

describe("resolveBudgetIncidentSchema", () => {
  it("accepts keep_paused action without amount", () => {
    expect(resolveBudgetIncidentSchema.safeParse({ action: "keep_paused" }).success).toBe(true);
  });

  it("accepts raise_budget_and_resume with amount", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_budget_and_resume",
      amount: 20000,
    });
    expect(result.success).toBe(true);
  });

  it("rejects raise_budget_and_resume without amount", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "raise_budget_and_resume",
    });
    expect(result.success).toBe(false);
  });

  it("accepts optional decisionNote", () => {
    const result = resolveBudgetIncidentSchema.safeParse({
      action: "keep_paused",
      decisionNote: "Will review next month",
    });
    expect(result.success).toBe(true);
  });

  it("rejects an invalid action", () => {
    expect(resolveBudgetIncidentSchema.safeParse({ action: "dismiss" }).success).toBe(false);
  });
});
