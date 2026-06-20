import { describe, expect, it } from "vitest";
import {
  resolveModelPolicy,
  type ModelPolicyRule,
} from "../services/model-policy.ts";

const rules: ModelPolicyRule[] = [
  {
    when: { issuePriority: ["urgent", "high"] },
    modelProfile: "deep",
    reason: "high-priority work uses the deep tier",
  },
  {
    when: { workMode: ["bulk"], wakeReason: ["heartbeat"] },
    modelProfile: "bulk",
  },
  { when: {}, modelProfile: "cheap", reason: "default tier" },
];

describe("resolveModelPolicy", () => {
  it("returns the first matching rule (priority wins over default)", () => {
    expect(
      resolveModelPolicy(rules, { agentRole: "general", issuePriority: "high" }),
    ).toEqual({ modelProfile: "deep", reason: "high-priority work uses the deep tier" });
  });

  it("requires ALL present constraints in a rule to match (AND semantics)", () => {
    expect(
      resolveModelPolicy(rules, { agentRole: "general", workMode: "bulk", wakeReason: "on_demand" }),
    ).toEqual({ modelProfile: "cheap", reason: "default tier" });
  });

  it("matches rule 2 when both constraints are satisfied", () => {
    expect(
      resolveModelPolicy(rules, {
        agentRole: "general",
        workMode: "bulk",
        wakeReason: "heartbeat",
      }),
    ).toEqual({
      modelProfile: "bulk",
      reason: "matched policy rule for profile bulk",
    });
  });

  it("falls through to the empty-when default rule", () => {
    expect(
      resolveModelPolicy(rules, { agentRole: "general" }),
    ).toEqual({ modelProfile: "cheap", reason: "default tier" });
  });

  it("returns a null decision when no rule matches", () => {
    expect(resolveModelPolicy([], { agentRole: "general" })).toEqual({
      modelProfile: null,
      reason: "no_policy_match",
    });
  });

  it("does not match a constraint when its signal is undefined", () => {
    const onlyPriority: ModelPolicyRule[] = [
      { when: { issuePriority: ["high"] }, modelProfile: "deep" },
    ];
    expect(
      resolveModelPolicy(onlyPriority, { agentRole: "general" }),
    ).toEqual({ modelProfile: null, reason: "no_policy_match" });
  });
});
