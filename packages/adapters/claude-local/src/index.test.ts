import { describe, expect, it } from "vitest";
import { claudeLocalReasoningEffortsForModel, DEFAULT_CLAUDE_LOCAL_MODEL, resolveClaudeModel } from "./index.js";
import { minimumClaudeCliVersionForModel } from "./server/cli-capabilities.js";

describe("Claude model defaults", () => {
  it.each(["claude-opus-5-5", "us.anthropic.claude-opus-5-5", "global.anthropic.claude-opus-5-5[1m]"])("requires a current CLI and offers all efforts for %s", (model) => {
    expect(minimumClaudeCliVersionForModel(model)).toBe("2.1.280");
    expect(claudeLocalReasoningEffortsForModel(model)).toEqual(["low", "medium", "high", "xhigh", "max"]);
  });

  it("keeps model-specific Claude reasoning limits", () => {
    expect(claudeLocalReasoningEffortsForModel("claude-fable-5-1")).toContain("xhigh");
    expect(claudeLocalReasoningEffortsForModel("claude-sonnet-5")).toContain("max");
    expect(claudeLocalReasoningEffortsForModel("claude-sonnet-4-6")).toEqual(["low", "medium", "high", "max"]);
    expect(claudeLocalReasoningEffortsForModel("claude-haiku-4-5")).toEqual([]);
    expect(claudeLocalReasoningEffortsForModel("custom-model")).toEqual(["low", "medium", "high"]);
  });

  it.each([undefined, null, "", "  "])("uses Opus 5 for an unset model (%j)", (model) => {
    expect(DEFAULT_CLAUDE_LOCAL_MODEL).toBe("claude-opus-5");
    expect(resolveClaudeModel(model)).toBe("claude-opus-5");
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
