import { afterEach, describe, expect, it } from "vitest";
import { isBedrockModelId, listClaudeModels } from "./models.js";

// ============================================================================
// isBedrockModelId
// ============================================================================

describe("isBedrockModelId", () => {
  it("returns true for us.anthropic. prefixed model IDs", () => {
    expect(isBedrockModelId("us.anthropic.claude-opus-4-6-v1")).toBe(true);
  });

  it("returns true for eu.anthropic. prefixed model IDs", () => {
    expect(isBedrockModelId("eu.anthropic.claude-sonnet-4-5")).toBe(true);
  });

  it("returns true for ap.anthropic. prefixed model IDs", () => {
    expect(isBedrockModelId("ap.anthropic.claude-haiku-4-5")).toBe(true);
  });

  it("returns true for ARN-format model IDs", () => {
    expect(isBedrockModelId("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-v2")).toBe(true);
  });

  it("returns false for standard Anthropic API model IDs", () => {
    expect(isBedrockModelId("claude-opus-4-6")).toBe(false);
  });

  it("returns false for claude-sonnet model ID", () => {
    expect(isBedrockModelId("claude-sonnet-4-5-20250929")).toBe(false);
  });

  it("returns false for empty string", () => {
    expect(isBedrockModelId("")).toBe(false);
  });

  it("returns false for arbitrary non-Bedrock string", () => {
    expect(isBedrockModelId("gpt-4")).toBe(false);
  });

  it("returns false for anthropic. prefix without region qualifier", () => {
    // "anthropic.claude" alone — the regex requires \w+\.anthropic\. so needs region prefix
    expect(isBedrockModelId("anthropic.claude-v2")).toBe(false);
  });
});

// ============================================================================
// listClaudeModels
// ============================================================================

describe("listClaudeModels", () => {
  const savedEnv: Record<string, string | undefined> = {};

  afterEach(() => {
    // Restore env vars modified in tests
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    Object.keys(savedEnv).forEach((key) => delete savedEnv[key]);
  });

  function setEnv(key: string, value: string) {
    savedEnv[key] = process.env[key];
    process.env[key] = value;
  }

  function unsetEnv(key: string) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }

  it("returns standard Anthropic models when no Bedrock env vars are set", async () => {
    unsetEnv("CLAUDE_CODE_USE_BEDROCK");
    unsetEnv("ANTHROPIC_BEDROCK_BASE_URL");
    const models = await listClaudeModels();
    expect(models.length).toBeGreaterThan(0);
    // Standard models should not have Bedrock-style IDs
    for (const model of models) {
      expect(isBedrockModelId(model.id)).toBe(false);
    }
  });

  it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=1", async () => {
    setEnv("CLAUDE_CODE_USE_BEDROCK", "1");
    unsetEnv("ANTHROPIC_BEDROCK_BASE_URL");
    const models = await listClaudeModels();
    expect(models.length).toBeGreaterThan(0);
    for (const model of models) {
      expect(isBedrockModelId(model.id)).toBe(true);
    }
  });

  it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=true", async () => {
    setEnv("CLAUDE_CODE_USE_BEDROCK", "true");
    unsetEnv("ANTHROPIC_BEDROCK_BASE_URL");
    const models = await listClaudeModels();
    for (const model of models) {
      expect(isBedrockModelId(model.id)).toBe(true);
    }
  });

  it("returns Bedrock models when ANTHROPIC_BEDROCK_BASE_URL is set", async () => {
    unsetEnv("CLAUDE_CODE_USE_BEDROCK");
    setEnv("ANTHROPIC_BEDROCK_BASE_URL", "https://bedrock.us-east-1.amazonaws.com");
    const models = await listClaudeModels();
    for (const model of models) {
      expect(isBedrockModelId(model.id)).toBe(true);
    }
  });

  it("returns standard models when CLAUDE_CODE_USE_BEDROCK is non-truthy value", async () => {
    setEnv("CLAUDE_CODE_USE_BEDROCK", "false");
    unsetEnv("ANTHROPIC_BEDROCK_BASE_URL");
    const models = await listClaudeModels();
    for (const model of models) {
      expect(isBedrockModelId(model.id)).toBe(false);
    }
  });

  it("returns standard models when ANTHROPIC_BEDROCK_BASE_URL is whitespace-only", async () => {
    unsetEnv("CLAUDE_CODE_USE_BEDROCK");
    setEnv("ANTHROPIC_BEDROCK_BASE_URL", "   ");
    const models = await listClaudeModels();
    for (const model of models) {
      expect(isBedrockModelId(model.id)).toBe(false);
    }
  });

  it("returns models with id and label fields", async () => {
    unsetEnv("CLAUDE_CODE_USE_BEDROCK");
    unsetEnv("ANTHROPIC_BEDROCK_BASE_URL");
    const models = await listClaudeModels();
    for (const model of models) {
      expect(typeof model.id).toBe("string");
      expect(model.id.length).toBeGreaterThan(0);
      expect(typeof model.label).toBe("string");
    }
  });
});
