import { describe, expect, it } from "vitest";
import { isClaudeModel, models, type as adapterType, label } from "@paperclipai/adapter-hybrid-local";

describe("hybrid_local adapter metadata", () => {
  it("has the correct type identifier", () => {
    expect(adapterType).toBe("hybrid_local");
  });

  it("has a descriptive label", () => {
    expect(label).toBe("Hybrid (local)");
  });

  it("exposes Claude models (local models discovered dynamically)", () => {
    const claudeModels = models.filter((m) => isClaudeModel(m.id));
    expect(claudeModels.length).toBeGreaterThan(0);
    // Local models are discovered dynamically from OpenAI-compatible endpoint
    // via listOpenAICompatModels() - see openai-compat.ts
  });
});

describe("hybrid_local model routing", () => {
  it("routes claude-opus-4-6 to Claude CLI", () => {
    expect(isClaudeModel("claude-opus-4-6")).toBe(true);
  });

  it("routes claude-sonnet-4-6 to Claude CLI", () => {
    expect(isClaudeModel("claude-sonnet-4-6")).toBe(true);
  });

  it("routes qwen models to local endpoint", () => {
    expect(isClaudeModel("qwen/qwen3.5-9b")).toBe(false);
  });

  it("routes deepseek models to local endpoint", () => {
    expect(isClaudeModel("deepseek-coder-v2:16b")).toBe(false);
  });
});
