import { describe, expect, it } from "vitest";
import {
  COMPLEXITY_MODEL_PROFILE_MAP,
  complexityToModelProfileKey,
  decideModelRouting,
  isIssueComplexity,
} from "./model-routing.js";
import { ISSUE_COMPLEXITIES, MODEL_PROFILE_KEYS } from "./constants.js";

describe("complexityToModelProfileKey", () => {
  it("maps every declared complexity to a declared profile key", () => {
    for (const complexity of ISSUE_COMPLEXITIES) {
      const profile = complexityToModelProfileKey(complexity);
      expect(profile).toBe(COMPLEXITY_MODEL_PROFILE_MAP[complexity]);
      expect(MODEL_PROFILE_KEYS).toContain(profile);
    }
  });

  it("returns null for null/undefined/garbage", () => {
    expect(complexityToModelProfileKey(null)).toBeNull();
    expect(complexityToModelProfileKey(undefined)).toBeNull();
    expect(complexityToModelProfileKey("opus-please")).toBeNull();
    expect(complexityToModelProfileKey(3)).toBeNull();
  });
});

describe("isIssueComplexity", () => {
  it("accepts only declared complexities", () => {
    expect(isIssueComplexity("trivial")).toBe(true);
    expect(isIssueComplexity("standard")).toBe(true);
    expect(isIssueComplexity("complex")).toBe(true);
    expect(isIssueComplexity("critical")).toBe(false);
    expect(isIssueComplexity("")).toBe(false);
  });
});

describe("decideModelRouting", () => {
  it("routes trivial → cheap, standard → standard, complex → premium", () => {
    expect(decideModelRouting({ complexity: "trivial" })).toMatchObject({
      routed: true,
      modelProfile: "cheap",
    });
    expect(decideModelRouting({ complexity: "standard" })).toMatchObject({
      routed: true,
      modelProfile: "standard",
    });
    expect(decideModelRouting({ complexity: "complex" })).toMatchObject({
      routed: true,
      modelProfile: "premium",
    });
  });

  it("skips when the issue has no valid complexity", () => {
    expect(decideModelRouting({ complexity: null })).toMatchObject({
      routed: false,
      skipReason: "no_complexity",
    });
    expect(decideModelRouting({ complexity: "urgent" })).toMatchObject({
      routed: false,
      skipReason: "no_complexity",
    });
  });

  it("never overrides an explicit issue adapterConfig.model", () => {
    const decision = decideModelRouting({
      complexity: "complex",
      issueAdapterOverrides: { adapterConfig: { model: "claude-fable-5" } },
    });
    expect(decision).toMatchObject({ routed: false, skipReason: "explicit_issue_model" });
  });

  it("ignores empty/whitespace explicit model strings", () => {
    const decision = decideModelRouting({
      complexity: "standard",
      issueAdapterOverrides: { adapterConfig: { model: "   " } },
    });
    expect(decision).toMatchObject({ routed: true, modelProfile: "standard" });
  });

  it("never overrides an explicit issue modelProfile", () => {
    const decision = decideModelRouting({
      complexity: "complex",
      issueAdapterOverrides: { modelProfile: "cheap" },
    });
    expect(decision).toMatchObject({ routed: false, skipReason: "explicit_issue_profile" });
  });

  it("does not treat an unknown issue modelProfile as an override", () => {
    const decision = decideModelRouting({
      complexity: "trivial",
      issueAdapterOverrides: { modelProfile: "turbo" },
    });
    expect(decision).toMatchObject({ routed: true, modelProfile: "cheap" });
  });

  it("never upgrades a status-only recovery (context) profile", () => {
    const decision = decideModelRouting({
      complexity: "complex",
      contextModelProfile: "cheap",
    });
    expect(decision).toMatchObject({ routed: false, skipReason: "context_model_profile" });
  });

  it("issue override precedence beats context precedence in the skip reason", () => {
    const decision = decideModelRouting({
      complexity: "complex",
      issueAdapterOverrides: { modelProfile: "premium" },
      contextModelProfile: "cheap",
    });
    expect(decision).toMatchObject({ routed: false, skipReason: "explicit_issue_profile" });
  });
});
