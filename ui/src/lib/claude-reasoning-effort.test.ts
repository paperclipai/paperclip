// @vitest-environment node
import { describe, expect, it } from "vitest";
import { claudeReasoningEffortOptions } from "./claude-reasoning-effort";

describe("Claude reasoning effort options", () => {
  it("offers the full tier list for models that accept xhigh and max", () => {
    expect(claudeReasoningEffortOptions("claude-opus-5").map((option) => option.value))
      .toEqual(["", "low", "medium", "high", "xhigh", "max"]);
    expect(claudeReasoningEffortOptions("claude-fable-5-1").map((option) => option.value))
      .toContain("max");
    expect(claudeReasoningEffortOptions("claude-sonnet-4-6").map((option) => option.value))
      .toEqual(["", "low", "medium", "high", "max"]);
  });

  it("offers no effort tier for Haiku models", () => {
    expect(claudeReasoningEffortOptions("claude-haiku-4-5")).toEqual([{ value: "", label: "Default" }]);
    expect(claudeReasoningEffortOptions("us.anthropic.claude-haiku-4-5-20251001-v1:0", "Auto"))
      .toEqual([{ value: "", label: "Auto" }]);
  });

  it("falls back to the adapter's default model when none is selected", () => {
    expect(claudeReasoningEffortOptions("").map((option) => option.value))
      .toEqual(claudeReasoningEffortOptions("claude-opus-5").map((option) => option.value));
    expect(claudeReasoningEffortOptions(null).map((option) => option.label))
      .toEqual(["Default", "Low", "Medium", "High", "X-High", "Max"]);
  });

  it("falls back to ANTHROPIC_MODEL from env when the stored model is blank", () => {
    expect(claudeReasoningEffortOptions("", "Default", { ANTHROPIC_MODEL: "claude-haiku-4-5" }))
      .toEqual([{ value: "", label: "Default" }]);
    expect(claudeReasoningEffortOptions("", "Default", { ANTHROPIC_MODEL: { type: "plain", value: "claude-sonnet-4-6" } }))
      .toEqual(claudeReasoningEffortOptions("claude-sonnet-4-6"));
    // A stored model wins over an env override.
    expect(claudeReasoningEffortOptions("claude-opus-5", "Default", { ANTHROPIC_MODEL: "claude-haiku-4-5" }))
      .toEqual(claudeReasoningEffortOptions("claude-opus-5"));
    // Secret-ref env bindings are opaque client-side; the default model applies.
    expect(claudeReasoningEffortOptions("", "Default", { ANTHROPIC_MODEL: { type: "secret_ref", secretId: "s1" } }))
      .toEqual(claudeReasoningEffortOptions("claude-opus-5"));
  });
});
