import { describe, expect, it } from "vitest";
import { upsertBudgetPolicySchema } from "./budget.js";

const scopeId = "3f6c1c4a-1d34-4b52-9b5f-2f3a5d1c9e10";

describe("upsertBudgetPolicySchema", () => {
  it("defaults to a monthly billed_cents policy", () => {
    const parsed = upsertBudgetPolicySchema.parse({ scopeType: "company", scopeId, amount: 5000 });
    expect(parsed.metric).toBe("billed_cents");
    expect(parsed.windowKind).toBe("calendar_month_utc");
  });

  it("accepts subscription_percent policies on provider windows", () => {
    for (const windowKind of ["provider_session", "provider_week"] as const) {
      const parsed = upsertBudgetPolicySchema.parse({
        scopeType: "agent",
        scopeId,
        metric: "subscription_percent",
        windowKind,
        amount: 80,
      });
      expect(parsed.windowKind).toBe(windowKind);
    }
  });

  it("rejects subscription_percent policies on calendar windows and above 100 percent", () => {
    expect(
      upsertBudgetPolicySchema.safeParse({
        scopeType: "company",
        scopeId,
        metric: "subscription_percent",
        windowKind: "calendar_month_utc",
        amount: 80,
      }).success,
    ).toBe(false);
    expect(
      upsertBudgetPolicySchema.safeParse({
        scopeType: "company",
        scopeId,
        metric: "subscription_percent",
        windowKind: "provider_week",
        amount: 101,
      }).success,
    ).toBe(false);
  });

  it("rejects billed_cents policies on provider windows", () => {
    expect(
      upsertBudgetPolicySchema.safeParse({
        scopeType: "company",
        scopeId,
        windowKind: "provider_session",
        amount: 5000,
      }).success,
    ).toBe(false);
  });
});
