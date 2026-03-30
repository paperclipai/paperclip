import { describe, expect, it } from "vitest";
import { isClaudeModel, models, type as adapterType, label } from "@paperclipai/adapter-local-local";

describe("local_local adapter metadata", () => {
  it("has the correct type identifier", () => {
    expect(adapterType).toBe("local_local");
  });

  it("has a descriptive label", () => {
    expect(label).toBe("Local (Claude + LM Studio)");
  });

  it("exposes both Claude and local models", () => {
    const claudeModels = models.filter((m) => isClaudeModel(m.id));
    const localModels = models.filter((m) => !isClaudeModel(m.id));
    expect(claudeModels.length).toBeGreaterThan(0);
    expect(localModels.length).toBeGreaterThan(0);
  });
});

describe("local_local model routing", () => {
  it("routes claude-opus-4-6 to Claude CLI", () => {
    expect(isClaudeModel("claude-opus-4-6")).toBe(true);
  });

  it("routes claude-sonnet-4-6 to Claude CLI", () => {
    expect(isClaudeModel("claude-sonnet-4-6")).toBe(true);
  });

  it("routes qwen models to LM Studio", () => {
    expect(isClaudeModel("qwen/qwen3.5-9b")).toBe(false);
  });

  it("routes deepseek models to LM Studio", () => {
    expect(isClaudeModel("deepseek-coder-v2:16b")).toBe(false);
  });
});
