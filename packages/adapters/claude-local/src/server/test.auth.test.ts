import { describe, expect, it } from "vitest";
import { resolveClaudeAuthAdvice } from "./test.js";
import { resolveClaudeBillingType } from "./execute.js";

describe("resolveClaudeAuthAdvice (CLI lane)", () => {
  it("recognizes CLAUDE_CODE_OAUTH_TOKEN as valid subscription auth", () => {
    expect(
      resolveClaudeAuthAdvice({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-token-value" }),
    ).toEqual({
      code: "claude_subscription_token_detected",
      level: "info",
      message:
        "CLAUDE_CODE_OAUTH_TOKEN is set; Claude will authenticate with the configured subscription token.",
    });
  });

  it("defers to the ANTHROPIC_API_KEY branch when both are set", () => {
    expect(
      resolveClaudeAuthAdvice({
        ANTHROPIC_API_KEY: "sk-ant-api-fake",
        CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-token-value",
      }),
    ).toBeNull();
  });

  it("returns null when neither auth signal is present (unchanged local-login guidance)", () => {
    expect(resolveClaudeAuthAdvice({})).toBeNull();
  });

  it("does not treat an empty-string token as set", () => {
    expect(resolveClaudeAuthAdvice({ CLAUDE_CODE_OAUTH_TOKEN: "   " })).toBeNull();
  });
});

describe("resolveClaudeBillingType with a subscription token", () => {
  it("classifies a CLAUDE_CODE_OAUTH_TOKEN-only env as subscription billing (no production change)", () => {
    expect(
      resolveClaudeBillingType({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-fake-token-value" }),
    ).toBe("subscription");
  });
});
