// @vitest-environment node
import { describe, expect, it } from "vitest";
import { applyMcpReasoningEffort, mcpAgentModelConfig } from "./agent-config.js";

describe("MCP reasoning-effort settings for DeepSeek models", () => {
  it("reports the DeepSeek low/high/max domain for a projected DeepSeek model", () => {
    expect(
      mcpAgentModelConfig("codex_local", { model: "paperclip/deepseek-flash", modelReasoningEffort: "max" }),
    ).toMatchObject({
      model: "paperclip/deepseek-flash",
      reasoningEffort: "max",
      supportedReasoningEfforts: ["low", "high", "max"],
    });
    expect(
      mcpAgentModelConfig("claude_local", { model: "deepseek-flash[1m]", effort: "low" }),
    ).toMatchObject({
      model: "deepseek-flash[1m]",
      reasoningEffort: "low",
      supportedReasoningEfforts: ["low", "high", "max"],
    });
  });

  it("keeps an effort saved by the DeepSeek setup editable when the model changes", () => {
    const next = applyMcpReasoningEffort(
      "codex_local",
      { model: "paperclip/deepseek-flash", modelReasoningEffort: "max" },
      { model: "deepseek-v4-pro" },
    );
    expect(next.modelReasoningEffort).toBe("max");
  });

  it("still rejects an effort the target model does not support", () => {
    expect(() =>
      applyMcpReasoningEffort(
        "codex_local",
        { model: "gpt-5.6-luna", modelReasoningEffort: "ultra" },
        { model: "gpt-5.6-luna" },
      ),
    ).toThrow("Reasoning effort is unsupported for this adapter and model");
  });

  it("leaves adapters without an effort control untouched", () => {
    expect(mcpAgentModelConfig("grok_local", { model: "grok-4.7" })).toMatchObject({
      supportedReasoningEfforts: [],
    });
  });
});
