import { describe, expect, it } from "vitest";
import { inheritNativeRunnerAdapterConfig } from "./native-agent-runtime-inheritance.js";
import { resolvePaperclipRunnerProviderProfile } from "./provider-profile.js";

describe("native hire runtime inheritance", () => {
  it.each([
    ["claude_managed", "managedProfileId", "managedAgentsRetentionAcknowledged"],
    ["aws_agentcore", "agentCoreProfileId", "agentCoreRetentionAcknowledged"],
  ])("preserves the company profile reference for %s", (provider, profileKey, retentionKey) => {
    const inherited = inheritNativeRunnerAdapterConfig({
      provider,
      [profileKey]: "qualified-company-profile",
      [retentionKey]: true,
      runtimeSessionId: "parent-session",
      env: { API_KEY: "parent-secret" },
    });
    expect(resolvePaperclipRunnerProviderProfile(inherited)).toMatchObject({
      provider,
      [profileKey]: "qualified-company-profile",
    });
    expect(inherited).not.toHaveProperty("runtimeSessionId");
    expect(inherited).not.toHaveProperty("env");
  });

  it.each(["codex", "acpx", "opencode"])("does not copy unrelated profile references for %s", (provider) => {
    const inherited = inheritNativeRunnerAdapterConfig({
      provider, managedProfileId: "unrelated-managed", agentCoreProfileId: "unrelated-remote",
    });
    expect(inherited).not.toHaveProperty("managedProfileId");
    expect(inherited).not.toHaveProperty("agentCoreProfileId");
  });

  it.each([null, true, {}, "", "   "])("does not copy an invalid profile reference %j", (profileId) => {
    expect(inheritNativeRunnerAdapterConfig({ provider: "claude_managed", managedProfileId: profileId }))
      .not.toHaveProperty("managedProfileId");
  });
});
