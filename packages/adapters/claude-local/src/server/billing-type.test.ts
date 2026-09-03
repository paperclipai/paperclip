import { describe, expect, it } from "vitest";
import { resolveClaudeBillingType } from "./execute.js";

describe("resolveClaudeBillingType", () => {
  it("returns metered_api for AWS Bedrock", () => {
    expect(resolveClaudeBillingType({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("metered_api");
    expect(resolveClaudeBillingType({ CLAUDE_CODE_USE_BEDROCK: "true" })).toBe("metered_api");
    expect(
      resolveClaudeBillingType({ ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock-runtime.us-east-1.amazonaws.com" }),
    ).toBe("metered_api");
  });

  it("returns api when a direct Anthropic API key is present", () => {
    expect(resolveClaudeBillingType({ ANTHROPIC_API_KEY: "sk-ant-xxx" })).toBe("api");
  });

  it("returns metered_api when ANTHROPIC_BASE_URL points at a proxy (LiteLLM, OpenRouter, etc.)", () => {
    expect(
      resolveClaudeBillingType({ ANTHROPIC_BASE_URL: "https://litellm.internal/anthropic" }),
    ).toBe("metered_api");
    expect(
      resolveClaudeBillingType({
        ANTHROPIC_BASE_URL: "https://litellm.internal/anthropic",
        ANTHROPIC_AUTH_TOKEN: "proxy-token",
      }),
    ).toBe("metered_api");
  });

  it("prefers ANTHROPIC_API_KEY over ANTHROPIC_BASE_URL when both are set", () => {
    expect(
      resolveClaudeBillingType({
        ANTHROPIC_API_KEY: "sk-ant-xxx",
        ANTHROPIC_BASE_URL: "https://proxy.example.com",
      }),
    ).toBe("api");
  });

  it("treats empty-string env values as unset", () => {
    expect(
      resolveClaudeBillingType({ ANTHROPIC_API_KEY: "", ANTHROPIC_BASE_URL: "   " }),
    ).toBe("subscription");
  });

  it("falls back to subscription when no auth/proxy signal is present", () => {
    expect(resolveClaudeBillingType({})).toBe("subscription");
  });
});
