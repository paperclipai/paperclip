import { describe, expect, it } from "vitest";
import { isExperimentalFeatureEnabled } from "@paperclipai/shared";
import { AgentRoutingService } from "../services/experimental-agent-routing.js";
import { CustomProcessTriggerService } from "../services/custom-process-trigger.js";

const enabledCompanyFeatures = {
  enabledFeatures: {
    agent_dual_mode: true,
    custom_process_triggers: true,
  },
};

describe("experimental feature resolver", () => {
  it("requires environment mode, development mode, and company flag", () => {
    expect(isExperimentalFeatureEnabled({
      feature: "unauthenticated_login",
      environmentExperimentalModeEnabled: false,
      isDevelopmentEnvironment: true,
      companyEnabledFeatures: { unauthenticated_login: true },
    })).toBe(false);
    expect(isExperimentalFeatureEnabled({
      feature: "unauthenticated_login",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: false,
      companyEnabledFeatures: { unauthenticated_login: true },
    })).toBe(false);
    expect(isExperimentalFeatureEnabled({
      feature: "unauthenticated_login",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyEnabledFeatures: {},
    })).toBe(false);
    expect(isExperimentalFeatureEnabled({
      feature: "unauthenticated_login",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyEnabledFeatures: { unauthenticated_login: true },
    })).toBe(true);
  });
});

describe("experimental agent routing", () => {
  const routing = new AgentRoutingService();

  it("keeps default routing unless the agent dual mode flag resolves enabled", () => {
    expect(routing.resolve({
      organizationConfig: { dualMode: true, primaryAgent: "claude", secondaryAgent: "codex" },
      claudeStatus: "unavailable",
      codexStatus: "available",
      environmentExperimentalModeEnabled: false,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: enabledCompanyFeatures,
    })).toBe("claude");

    expect(routing.resolve({
      organizationConfig: { dualMode: true, primaryAgent: "claude", secondaryAgent: "codex" },
      claudeStatus: "unavailable",
      codexStatus: "available",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: enabledCompanyFeatures,
    })).toBe("codex");
  });
});

describe("experimental custom process triggers", () => {
  const service = new CustomProcessTriggerService();

  it("is a no-op unless the custom process trigger flag resolves enabled", async () => {
    await expect(service.trigger({
      event: "manual",
      environmentExperimentalModeEnabled: false,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: enabledCompanyFeatures,
      customProcess: {
        enabled: true,
        instructions: "Create a local handoff.",
      },
    })).resolves.toMatchObject({ triggered: false, reason: "disabled" });

    await expect(service.trigger({
      event: "manual",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: enabledCompanyFeatures,
      customProcess: {
        enabled: true,
        instructions: "Create a local handoff.",
      },
    })).resolves.toMatchObject({
      triggered: true,
      reason: "triggered",
      instructions: "Create a local handoff.",
    });
  });
});
