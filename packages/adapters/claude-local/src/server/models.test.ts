import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  isBedrockModelId,
  listClaudeModelProfiles,
  listClaudeModels,
  resolveBedrockRegionPrefix,
} from "./models.js";

describe("listClaudeModels", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("returns Anthropic-direct ids when Bedrock env vars are unset", async () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    const models = await listClaudeModels();
    expect(models.every((m) => !isBedrockModelId(m.id))).toBe(true);
  });

  it("returns eu-prefixed Bedrock ids when running in eu-central-1", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "eu-central-1";
    const models = await listClaudeModels();
    expect(models.length).toBeGreaterThan(0);
    expect(models.every((m) => m.id.startsWith("eu.anthropic."))).toBe(true);
  });

  it("returns us-prefixed Bedrock ids when running in us-east-1", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-east-1";
    const models = await listClaudeModels();
    expect(models.every((m) => m.id.startsWith("us.anthropic."))).toBe(true);
  });
});

describe("listClaudeModelProfiles", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL_ENV };
  });

  it("uses the Anthropic-direct default model when Bedrock is off", async () => {
    delete process.env.CLAUDE_CODE_USE_BEDROCK;
    delete process.env.ANTHROPIC_BEDROCK_BASE_URL;
    const profiles = await listClaudeModelProfiles();
    const cheap = profiles.find((p) => p.key === "cheap");
    expect(cheap).toBeDefined();
    expect(isBedrockModelId(cheap!.adapterConfig?.model as string)).toBe(false);
  });

  it("rewrites cheap profile model to a Bedrock id when Bedrock is on", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "eu-central-1";
    const profiles = await listClaudeModelProfiles();
    const cheap = profiles.find((p) => p.key === "cheap");
    expect(cheap).toBeDefined();
    const model = cheap!.adapterConfig?.model as string;
    expect(isBedrockModelId(model)).toBe(true);
    expect(model.startsWith("eu.anthropic.")).toBe(true);
  });

  it("regression: cheap profile never resolves to claude-sonnet-4-6 on Bedrock", async () => {
    // Reproduces the exact failing-run fingerprint from KOT-12:
    //   Error: Claude run failed: API Error (claude-sonnet-4-6):
    //          400 The provided model identifier is invalid.
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "eu-central-1";
    const profiles = await listClaudeModelProfiles();
    const cheap = profiles.find((p) => p.key === "cheap");
    expect(cheap?.adapterConfig?.model).not.toBe("claude-sonnet-4-6");
  });

  it("honors ANTHROPIC_BEDROCK_REGION over AWS_REGION", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    process.env.AWS_REGION = "us-east-1";
    process.env.ANTHROPIC_BEDROCK_REGION = "eu-central-1";
    const profiles = await listClaudeModelProfiles();
    const model = profiles.find((p) => p.key === "cheap")?.adapterConfig?.model as string;
    expect(model.startsWith("eu.anthropic.")).toBe(true);
  });
});

describe("resolveBedrockRegionPrefix", () => {
  it("maps eu-* regions to eu", () => {
    expect(resolveBedrockRegionPrefix({ AWS_REGION: "eu-central-1" })).toBe("eu");
    expect(resolveBedrockRegionPrefix({ AWS_REGION: "eu-west-3" })).toBe("eu");
  });

  it("maps ap-* regions to apac", () => {
    expect(resolveBedrockRegionPrefix({ AWS_REGION: "ap-southeast-2" })).toBe("apac");
  });

  it("falls back to us when nothing matches", () => {
    expect(resolveBedrockRegionPrefix({})).toBe("us");
    expect(resolveBedrockRegionPrefix({ AWS_REGION: "" })).toBe("us");
    expect(resolveBedrockRegionPrefix({ AWS_REGION: "us-east-1" })).toBe("us");
  });
});
