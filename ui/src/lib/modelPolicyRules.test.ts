import { describe, expect, it } from "vitest";
import type { ModelPolicyRule } from "../api/modelPolicies";
import {
  SIGNAL_KEYS,
  addRule,
  emptyRule,
  isDirty,
  moveRule,
  normalizeRules,
  removeRule,
  setSignal,
  updateRule,
} from "./modelPolicyRules";

const r = (mp: "cheap" | "deep" | "bulk", when: Record<string, string[]> = {}): ModelPolicyRule => ({
  when,
  modelProfile: mp,
});

describe("modelPolicyRules helpers", () => {
  it("SIGNAL_KEYS lists the four match signals", () => {
    expect(SIGNAL_KEYS).toEqual(["agentRole", "wakeReason", "issuePriority", "workMode"]);
  });

  it("emptyRule has an empty when and the given default profile", () => {
    expect(emptyRule("cheap")).toEqual({ when: {}, modelProfile: "cheap" });
  });

  it("addRule appends without mutating the input", () => {
    const base = [r("cheap")];
    const next = addRule(base, r("deep"));
    expect(next).toHaveLength(2);
    expect(next[1].modelProfile).toBe("deep");
    expect(base).toHaveLength(1); // not mutated
  });

  it("removeRule drops the rule at the index", () => {
    expect(removeRule([r("cheap"), r("deep"), r("bulk")], 1)).toEqual([r("cheap"), r("bulk")]);
  });

  it("updateRule replaces the rule at the index", () => {
    expect(updateRule([r("cheap"), r("deep")], 0, r("bulk"))).toEqual([r("bulk"), r("deep")]);
  });

  it("moveRule up swaps with the previous item", () => {
    expect(moveRule([r("cheap"), r("deep")], 1, "up")).toEqual([r("deep"), r("cheap")]);
  });

  it("moveRule down swaps with the next item", () => {
    expect(moveRule([r("cheap"), r("deep")], 0, "down")).toEqual([r("deep"), r("cheap")]);
  });

  it("moveRule clamps at the boundaries (no-op, returns equal content)", () => {
    expect(moveRule([r("cheap"), r("deep")], 0, "up")).toEqual([r("cheap"), r("deep")]);
    expect(moveRule([r("cheap"), r("deep")], 1, "down")).toEqual([r("cheap"), r("deep")]);
  });

  it("setSignal sets a non-empty value list under when[key]", () => {
    const next = setSignal(r("cheap"), "issuePriority", ["high", "critical"]);
    expect(next.when.issuePriority).toEqual(["high", "critical"]);
  });

  it("setSignal removes the key when given an empty list", () => {
    const start = r("cheap", { issuePriority: ["high"] });
    const next = setSignal(start, "issuePriority", []);
    expect(next.when).toEqual({});
  });

  it("isDirty is false for structurally equal rule sets regardless of signal key order", () => {
    const a: ModelPolicyRule[] = [{ when: { issuePriority: ["high"], workMode: ["planning"] }, modelProfile: "deep" }];
    const b: ModelPolicyRule[] = [{ when: { workMode: ["planning"], issuePriority: ["high"] }, modelProfile: "deep" }];
    expect(isDirty(a, b)).toBe(false);
  });

  it("isDirty is true when a rule changes", () => {
    expect(isDirty([r("cheap")], [r("deep")])).toBe(true);
  });

  it("normalizeRules orders the when keys by SIGNAL_KEYS and drops empty arrays", () => {
    const normalized = normalizeRules([
      { when: { workMode: ["planning"], issuePriority: [], agentRole: ["engineer"] }, modelProfile: "deep" },
    ]);
    expect(Object.keys(normalized[0].when)).toEqual(["agentRole", "workMode"]);
    expect(normalized[0].when).not.toHaveProperty("issuePriority");
  });
});
