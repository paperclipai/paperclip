import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BEDROCK_CHEAP_MODEL_ID,
  listClaudeModelProfiles,
  validateModelProfileModels,
} from "./models.js";

const BEDROCK_ENV_KEYS = ["CLAUDE_CODE_USE_BEDROCK", "ANTHROPIC_BEDROCK_BASE_URL"] as const;

function clearBedrockEnv() {
  for (const key of BEDROCK_ENV_KEYS) delete process.env[key];
}

describe("listClaudeModelProfiles", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of BEDROCK_ENV_KEYS) saved[key] = process.env[key];
    clearBedrockEnv();
  });

  afterEach(() => {
    for (const key of BEDROCK_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("resolves the cheap profile to a Bedrock-native id under Bedrock auth", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const profiles = await listClaudeModelProfiles();
    const cheap = profiles.find((profile) => profile.key === "cheap");
    expect(cheap).toBeDefined();
    expect(cheap?.adapterConfig.model).toBe(BEDROCK_CHEAP_MODEL_ID);
    // The Bedrock id must be region-qualified, never an Anthropic short id.
    expect(cheap?.adapterConfig.model).toMatch(/^us\.anthropic\./);
    // Other config (effort) is preserved.
    expect(cheap?.adapterConfig.effort).toBe("low");
  });

  it("also rewrites the cheap profile when Bedrock is signalled via base URL", async () => {
    process.env.ANTHROPIC_BEDROCK_BASE_URL = "https://bedrock.example";
    const profiles = await listClaudeModelProfiles();
    const cheap = profiles.find((profile) => profile.key === "cheap");
    expect(cheap?.adapterConfig.model).toBe(BEDROCK_CHEAP_MODEL_ID);
  });

  it("keeps the direct-Anthropic id for the cheap profile off Bedrock", async () => {
    clearBedrockEnv();
    const profiles = await listClaudeModelProfiles();
    const cheap = profiles.find((profile) => profile.key === "cheap");
    expect(cheap?.adapterConfig.model).toBe("claude-sonnet-4-6");
  });
});

describe("validateModelProfileModels", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of BEDROCK_ENV_KEYS) saved[key] = process.env[key];
    clearBedrockEnv();
  });

  afterEach(() => {
    for (const key of BEDROCK_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("flags no error for the resolved cheap profile under Bedrock auth", async () => {
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const checks = await validateModelProfileModels();
    expect(checks.filter((check) => check.level === "error")).toHaveLength(0);
  });

  it("flags no error for the resolved cheap profile off Bedrock", async () => {
    clearBedrockEnv();
    const checks = await validateModelProfileModels();
    expect(checks.filter((check) => check.level === "error")).toHaveLength(0);
  });

  it("emits a typed error when a profile model is invalid for the active auth mode", async () => {
    // A profile carrying an Anthropic short id while Bedrock auth is active must
    // be flagged at config load with a typed error, code, and hint.
    process.env.CLAUDE_CODE_USE_BEDROCK = "1";
    const checks = await validateModelProfileModels({
      profiles: [
        {
          key: "cheap",
          label: "Cheap",
          adapterConfig: { model: "claude-sonnet-4-6", effort: "low" },
          source: "adapter_default",
        },
      ],
      available: [{ id: "us.anthropic.claude-sonnet-4-5-20250929-v2:0", label: "Bedrock Sonnet 4.5" }],
    });
    const errors = checks.filter((check) => check.level === "error");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("claude_model_profile_invalid");
    expect(errors[0].message).toContain("claude-sonnet-4-6");
    expect(errors[0].hint).toBeTruthy();
  });

  it("ignores profiles without a model id", async () => {
    const checks = await validateModelProfileModels({
      profiles: [
        { key: "cheap", label: "Cheap", adapterConfig: { effort: "low" }, source: "adapter_default" },
      ],
      available: [{ id: "claude-sonnet-4-6", label: "Sonnet" }],
    });
    expect(checks).toHaveLength(0);
  });
});
