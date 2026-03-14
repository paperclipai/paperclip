import { describe, expect, it } from "vitest";
import {
  hasBudgetOverride,
  BUDGET_WARNING_THRESHOLD,
  BUDGET_EXCEEDED_THRESHOLD,
} from "../services/budget-guard.js";

function fakeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "test-agent",
    role: "general",
    title: null,
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    permissions: {},
    lastHeartbeatAt: null,
    metadata: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as any;
}

describe("budget-guard", () => {
  describe("constants", () => {
    it("warning threshold is 80%", () => {
      expect(BUDGET_WARNING_THRESHOLD).toBe(0.8);
    });

    it("exceeded threshold is 100%", () => {
      expect(BUDGET_EXCEEDED_THRESHOLD).toBe(1.0);
    });
  });

  describe("hasBudgetOverride", () => {
    it("returns false when metadata is null", () => {
      expect(hasBudgetOverride(fakeAgent({ metadata: null }))).toBe(false);
    });

    it("returns false when metadata has no budgetOverride", () => {
      expect(hasBudgetOverride(fakeAgent({ metadata: { foo: "bar" } }))).toBe(false);
    });

    it("returns false when budgetOverride is false", () => {
      expect(hasBudgetOverride(fakeAgent({ metadata: { budgetOverride: false } }))).toBe(false);
    });

    it("returns true when budgetOverride is true", () => {
      expect(hasBudgetOverride(fakeAgent({ metadata: { budgetOverride: true } }))).toBe(true);
    });

    it("returns false when budgetOverride is a non-boolean truthy value", () => {
      expect(hasBudgetOverride(fakeAgent({ metadata: { budgetOverride: "yes" } }))).toBe(false);
    });
  });
});
