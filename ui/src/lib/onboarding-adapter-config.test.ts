import { describe, expect, it } from "vitest";
import { buildOnboardingAdapterConfig } from "./onboarding-adapter-config";

const baseInput = {
  model: "",
  command: "",
  args: "",
  url: "",
};

describe("buildOnboardingAdapterConfig", () => {
  it("skips permissions for claude_local", () => {
    const config = buildOnboardingAdapterConfig({
      ...baseInput,
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: false,
    });
    expect(config.dangerouslySkipPermissions).toBe(true);
  });

  it("forces ANTHROPIC_API_KEY empty for claude_local when requested", () => {
    const config = buildOnboardingAdapterConfig({
      ...baseInput,
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: true,
    });
    const env = config.env as Record<string, unknown>;
    expect(env.ANTHROPIC_API_KEY).toEqual({ type: "plain", value: "" });
  });

  it("does not force ANTHROPIC_API_KEY when the flag is off", () => {
    const config = buildOnboardingAdapterConfig({
      ...baseInput,
      adapterType: "claude_local",
      forceUnsetAnthropicApiKey: false,
    });
    const env = config.env as Record<string, unknown> | undefined;
    expect(env?.ANTHROPIC_API_KEY).not.toEqual({ type: "plain", value: "" });
  });

  it("only applies the ANTHROPIC_API_KEY override to claude_local", () => {
    const config = buildOnboardingAdapterConfig({
      ...baseInput,
      adapterType: "codex_local",
      forceUnsetAnthropicApiKey: true,
    });
    const env = config.env as Record<string, unknown> | undefined;
    expect(env?.ANTHROPIC_API_KEY).not.toEqual({ type: "plain", value: "" });
  });
});
