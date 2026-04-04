import { describe, expect, it } from "vitest";
import { buildOnboardingAdapterConfig } from "./onboarding-adapter-config";

describe("buildOnboardingAdapterConfig", () => {
  it("preserves claude_local extra args and skip-permissions override", () => {
    const config = buildOnboardingAdapterConfig({
      adapterType: "claude_local",
      model: "",
      command: "",
      extraArgs: "--mcp-config, /tmp/shell.json, --allowedTools, mcp__shell__*",
      url: "",
      dangerouslySkipPermissions: false,
    });

    expect(config.dangerouslySkipPermissions).toBe(false);
    expect(config.extraArgs).toEqual([
      "--mcp-config",
      "/tmp/shell.json",
      "--allowedTools",
      "mcp__shell__*",
    ]);
  });

  it("can force-clear ANTHROPIC_API_KEY for claude_local onboarding retries", () => {
    const config = buildOnboardingAdapterConfig({
      adapterType: "claude_local",
      model: "",
      command: "",
      extraArgs: "",
      url: "",
      dangerouslySkipPermissions: true,
      forceUnsetAnthropicApiKey: true,
    });

    expect(config.env).toEqual({
      ANTHROPIC_API_KEY: { type: "plain", value: "" },
    });
  });
});
