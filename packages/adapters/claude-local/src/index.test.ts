import { describe, expect, it } from "vitest";
import { claudeLocalReasoningEffortsForModel, DEFAULT_CLAUDE_LOCAL_MODEL, models, resolveClaudeModel } from "./index.js";
import { claudeCodeVersionForAgentSdk, minimumClaudeCliVersionForModel } from "./server/cli-capabilities.js";

describe("Claude model defaults", () => {
  it.each([
    "claude-opus-5-5",
    "us.anthropic.claude-opus-5-5",
    "global.anthropic.claude-opus-5-5[1m]",
    "jp.anthropic.claude-opus-5-5",
    "au.anthropic.claude-opus-5-5",
  ])("requires a current CLI and offers all efforts for %s", (model) => {
    expect(minimumClaudeCliVersionForModel(model)).toBe("2.1.280");
    expect(claudeLocalReasoningEffortsForModel(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it.each([
    "claude-sonnet-5-5",
    "claude-sonnet-5-5[1m]",
    "us.anthropic.claude-sonnet-5-5",
    "global.anthropic.claude-sonnet-5-5[1m]",
  ])("requires CLI 2.1.284 and offers all efforts for %s", (model) => {
    expect(minimumClaudeCliVersionForModel(model)).toBe("2.1.284");
    expect(claudeLocalReasoningEffortsForModel(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it.each([
    "claude-fable-5-2",
    "claude-fable-5-2[1m]",
    "global.anthropic.claude-fable-5-2",
  ])("requires CLI 2.1.321 and offers all efforts for %s", (model) => {
    expect(minimumClaudeCliVersionForModel(model)).toBe("2.1.321");
    expect(claudeLocalReasoningEffortsForModel(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("lists Fable 5.2 first and keeps Fable 5.1 selectable", () => {
    const ids = models.map((model) => model.id);
    expect(ids[0]).toBe("claude-fable-5-2");
    expect(ids).toContain("claude-fable-5-1");
  });

  it("keeps model-specific Claude reasoning limits", () => {
    expect(claudeLocalReasoningEffortsForModel("claude-fable-5-1")).toContain("xhigh");
    expect(claudeLocalReasoningEffortsForModel("claude-sonnet-5")).toContain("max");
    expect(claudeLocalReasoningEffortsForModel("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(claudeLocalReasoningEffortsForModel("claude-sonnet-4-5")).toEqual(["low", "medium", "high"]);
    expect(claudeLocalReasoningEffortsForModel("claude-haiku-4-5")).toEqual([]);
    expect(claudeLocalReasoningEffortsForModel("custom-model")).toEqual(["low", "medium", "high"]);
  });

  it("maps an Agent SDK 0.3.N release to the Claude Code 2.1.N it bundles", () => {
    expect(claudeCodeVersionForAgentSdk("0.3.286")).toBe("2.1.286");
    expect(claudeCodeVersionForAgentSdk("0.3.328")).toBe("2.1.328");
    expect(claudeCodeVersionForAgentSdk(" 0.3.321 ")).toBe("2.1.321");
    for (const version of ["0.4.1", "0.3.286-beta.1", "", null, undefined]) {
      expect(claudeCodeVersionForAgentSdk(version)).toBeNull();
    }
  });

  it.each([undefined, null, "", "  "])("uses Opus 5.5 for an unset model (%j)", (model) => {
    expect(DEFAULT_CLAUDE_LOCAL_MODEL).toBe("claude-opus-5-5");
    expect(resolveClaudeModel(model)).toBe("claude-opus-5-5");
  });

  it("keeps explicit model IDs ahead of environment overrides", () => {
    expect(resolveClaudeModel(" claude-sonnet-4-5 ", { ANTHROPIC_MODEL: "opus" }))
      .toBe("claude-sonnet-4-5");
    expect(resolveClaudeModel("", { ANTHROPIC_MODEL: " custom-model " })).toBe("custom-model");
  });

  it.each([
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_BEDROCK: "true" },
    { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" },
    { CLAUDE_CODE_USE_VERTEX: "1" },
  ])("keeps provider-specific defaults for %j", (env) => {
    expect(resolveClaudeModel(undefined, env)).toBe("");
    expect(resolveClaudeModel("provider-model", env)).toBe("provider-model");
  });
});
