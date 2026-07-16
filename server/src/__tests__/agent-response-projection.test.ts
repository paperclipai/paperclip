import { describe, expect, it } from "vitest";
import { projectAgentResponse } from "../serializers/agent-response.js";

const SECRET = "pc_live_FAS119_NEVER_EXPOSE_AUTH_TOKEN";

function materializedAgent() {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    companyId: "22222222-2222-4222-8222-222222222222",
    name: "Human-reviewed agent",
    urlKey: "human-reviewed-agent",
    role: "engineer",
    title: "Build and review",
    icon: null,
    status: "idle",
    reportsTo: null,
    capabilities: "Describe authentication-token handling without changing human-authored text.",
    adapterType: "hermes_local",
    adapterConfig: {
      provider: "openai-codex",
      promptTemplate: "Preserve this human-authored prompt exactly.",
      env: { PAPERCLIP_API_KEY: SECRET, NESTED: { value: SECRET } },
      apiKey: SECRET,
      headers: { authorization: `Bearer ${SECRET}` },
      unknownPluginConfig: { credential: SECRET },
    },
    runtimeConfig: {
      heartbeat: { enabled: true, runtimeToken: SECRET },
      modelProfiles: {
        cheap: {
          enabled: true,
          label: "Human reviewed cheap profile",
          adapterConfig: {
            provider: "openai-codex",
            promptTemplate: "Preserve this cheap-profile prompt exactly.",
            env: { OPENAI_API_KEY: SECRET },
            unknownRuntimeCredential: { value: SECRET },
          },
        },
      },
      executionMetadata: { leaseToken: SECRET },
    },
    defaultEnvironmentId: "33333333-3333-4333-8333-333333333333",
    budgetMonthlyCents: 1000,
    spentMonthlyCents: 125,
    pauseReason: null,
    pausedAt: null,
    errorReason: null,
    permissions: {
      canCreateAgents: false,
      canCreateSkills: true,
      trustPreset: "standard",
      internalGrantMetadata: { token: SECRET },
    },
    lastHeartbeatAt: null,
    metadata: { apiKey: SECRET, execution: { token: SECRET } },
    internalExecutionMetadata: { token: SECRET },
    createdAt: new Date("2026-03-19T00:00:00.000Z"),
    updatedAt: new Date("2026-03-20T00:00:00.000Z"),
  };
}

describe("projectAgentResponse", () => {
  it("uses a positive projection that excludes credentials and internal execution metadata", () => {
    const projected = projectAgentResponse(materializedAgent());

    expect(projected).toMatchObject({
      id: "11111111-1111-4111-8111-111111111111",
      name: "Human-reviewed agent",
      capabilities: "Describe authentication-token handling without changing human-authored text.",
      adapterConfig: {
        provider: "openai-codex",
        promptTemplate: "Preserve this human-authored prompt exactly.",
      },
      runtimeConfig: {
        modelProfiles: {
          cheap: {
            enabled: true,
            label: "Human reviewed cheap profile",
            adapterConfig: {
              provider: "openai-codex",
              promptTemplate: "Preserve this cheap-profile prompt exactly.",
            },
          },
        },
      },
      permissions: {
        canCreateAgents: false,
        canCreateSkills: true,
        trustPreset: "standard",
      },
    });
    expect(projected.adapterConfig).not.toHaveProperty("env");
    expect(projected.adapterConfig).not.toHaveProperty("apiKey");
    expect(projected.adapterConfig).not.toHaveProperty("headers");
    expect(projected.adapterConfig).not.toHaveProperty("unknownPluginConfig");
    expect(projected.runtimeConfig).not.toHaveProperty("heartbeat");
    expect(projected.runtimeConfig).not.toHaveProperty("executionMetadata");
    expect(projected).not.toHaveProperty("metadata");
    expect(projected).not.toHaveProperty("internalExecutionMetadata");
    expect(projected.permissions).not.toHaveProperty("internalGrantMetadata");
  });
});
