import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listClaudeModels, isBedrockModelId } from "./models.js";

describe("claude-local models", () => {
  const originalBedrock = process.env.CLAUDE_CODE_USE_BEDROCK;
  const originalBaseUrl = process.env.ANTHROPIC_BEDROCK_BASE_URL;

  beforeEach(() => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  });

  afterEach(() => {
    if (originalBedrock !== undefined) process.env.CLAUDE_CODE_USE_BEDROCK = originalBedrock;
    else delete process.env.CLAUDE_CODE_USE_BEDROCK;
    if (originalBaseUrl !== undefined) process.env.ANTHROPIC_BEDROCK_BASE_URL = originalBaseUrl;
    else delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
  });

  describe("listClaudeModels", () => {
    it("returns direct API models by default", async () => {
      const models = await listClaudeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models[0].id).toMatch(/^claude-/);
    });

    it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=1", async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      const models = await listClaudeModels();
      expect(models.length).toBeGreaterThan(0);
      expect(models.every((m) => m.id.startsWith("global.anthropic."))).toBe(true);
    });

    it("returns Bedrock models when CLAUDE_CODE_USE_BEDROCK=true", async () => {
      process.env.CLAUDE_CODE_USE_BEDROCK = "true";
      const models = await listClaudeModels();
      expect(models[0].id).toMatch(/^global\.anthropic\./);
    });

    it("returns Bedrock models when ANTHROPIC_BEDROCK_BASE_URL is set", async () => {
      process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock-runtime.us-east-1.amazonaws.com";
      const models = await listClaudeModels();
      expect(models[0].id).toMatch(/^global\.anthropic\./);
    });

    it("includes Opus 4.8 in both model lists", async () => {
      const direct = await listClaudeModels();
      expect(direct.some((m) => m.id === "claude-opus-4-8")).toBe(true);

      process.env.CLAUDE_CODE_USE_BEDROCK = "1";
      const bedrock = await listClaudeModels();
      expect(bedrock.some((m) => m.id === "global.anthropic.claude-opus-4-8")).toBe(true);
    });
  });

  describe("isBedrockModelId", () => {
    it("recognizes global inference profile IDs", () => {
      expect(isBedrockModelId("global.anthropic.claude-opus-4-8")).toBe(true);
      expect(isBedrockModelId("global.anthropic.claude-opus-4-7")).toBe(true);
    });

    it("recognizes regional inference profile IDs", () => {
      expect(isBedrockModelId("us.anthropic.claude-opus-4-6-v1")).toBe(true);
      expect(isBedrockModelId("eu.anthropic.claude-sonnet-4-6")).toBe(true);
    });

    it("recognizes Bedrock ARNs", () => {
      expect(isBedrockModelId("arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-8")).toBe(true);
    });

    it("rejects direct API model IDs", () => {
      expect(isBedrockModelId("claude-opus-4-8")).toBe(false);
      expect(isBedrockModelId("claude-sonnet-4-6")).toBe(false);
    });
  });
});
