import { describe, expect, it } from "vitest";
import { claudeLocalCredentialSetup } from "./credential-setup.js";

describe("claudeLocalCredentialSetup", () => {
  it("exports credential options with correct envKeys", () => {
    const envKeys = claudeLocalCredentialSetup.options.map(o => o.envKey);
    expect(envKeys).toEqual(["ANTHROPIC_API_KEY", "CLAUDE_CODE_OAUTH_TOKEN"]);
  });

  it("configures subscription_token option with setupCommand", () => {
    const tokenOption = claudeLocalCredentialSetup.options.find(o => o.envKey === "CLAUDE_CODE_OAUTH_TOKEN");
    expect(tokenOption).toBeDefined();
    expect(tokenOption?.kind).toBe("subscription_token");
    expect(tokenOption?.setupCommand).toBe("claude setup-token");
  });

  it("includes hint text mentioning both quota and extra usage for subscription_token", () => {
    const tokenOption = claudeLocalCredentialSetup.options.find(o => o.envKey === "CLAUDE_CODE_OAUTH_TOKEN");
    expect(tokenOption?.hint).toContain("quota");
    expect(tokenOption?.hint).toContain("extra usage");
  });
});
