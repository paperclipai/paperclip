import { describe, expect, it } from "vitest";
import { isExperimentalFeatureEnabled } from "@paperclipai/shared";
import { AgentRoutingService } from "../services/experimental-agent-routing.js";

const enabledCompanyFeatures = {
  enabledFeatures: {
    agent_dual_mode: true,
  },
};

describe("experimental feature resolver", () => {
  it("requires environment mode and company flag", () => {
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
    })).toBe(true);
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

  it("can resolve routing from company experimental dual-mode config", () => {
    expect(routing.resolve({
      claudeStatus: "unavailable",
      codexStatus: "available",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: {
        enabledFeatures: { agent_dual_mode: true },
        agentDualMode: {
          primaryAgent: "claude",
          primaryModel: "claude-sonnet-4-5",
          secondaryAgent: "codex",
          secondaryModel: "gpt-5.4-codex",
        },
      },
    })).toBe("codex");
  });

  it("resolves an execution adapter without rewriting non-primary adapters", () => {
    expect(routing.resolveExecution({
      currentAdapterType: "claude_local",
      claudeStatus: "tokens_empty",
      codexStatus: "available",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: {
        enabledFeatures: { agent_dual_mode: true },
        agentDualMode: {
          primaryAgent: "claude",
          primaryModel: "claude-sonnet-4-5",
          secondaryAgent: "codex",
          secondaryModel: "gpt-5.3-codex",
        },
      },
    })).toEqual({
      provider: "codex",
      adapterType: "codex_local",
      model: "gpt-5.3-codex",
      routed: true,
    });

    expect(routing.resolveExecution({
      currentAdapterType: "codex_local",
      claudeStatus: "tokens_empty",
      codexStatus: "available",
      environmentExperimentalModeEnabled: true,
      isDevelopmentEnvironment: true,
      companyExperimentalFeatures: {
        enabledFeatures: { agent_dual_mode: true },
        agentDualMode: {
          primaryAgent: "claude",
          secondaryAgent: "codex",
        },
      },
    })).toMatchObject({
      provider: "codex",
      adapterType: "codex_local",
      routed: false,
    });
  });
});
