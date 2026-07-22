import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { getAgentConfigDirtyDetails } from "./AgentConfigForm";
import {
  filterAgentConfigurationSections,
  resolveEffectiveConfiguration,
} from "./agent-configuration-shell";

describe("agent configuration shell", () => {
  it("matches both section names and field labels", () => {
    expect([...filterAgentConfigurationSections("heartbeat")]).toEqual(["schedule"]);
    expect([...filterAgentConfigurationSections("API Keys")]).toEqual(["keys"]);
    expect([...filterAgentConfigurationSections("sandbox")]).toEqual(["danger"]);
  });

  it("resolves adapter defaults to a concrete model label", () => {
    const agent = {
      adapterType: "claude_local",
      adapterConfig: { modelReasoningEffort: "high" },
      runtimeConfig: { heartbeat: { enabled: true, intervalSec: 300 } },
      permissions: { trustPreset: "standard" },
      defaultEnvironmentId: null,
    } as unknown as Agent;

    expect(resolveEffectiveConfiguration(agent, [{ id: "claude-fable-5", label: "Claude Fable 5" }], 2)).toMatchObject({
      model: "Claude Fable 5 · high",
      modelInherited: true,
      environmentInherited: true,
      apiKeyCount: 2,
    });
  });

  it("counts draft fields and assigns dirty section dots", () => {
    expect(getAgentConfigDirtyDetails({
      identity: { defaultEnvironmentId: "env-1" },
      adapterConfig: { model: "claude-fable-5", dangerouslySkipPermissions: true },
      heartbeat: { intervalSec: 300 },
      runtime: {},
    })).toEqual({
      count: 4,
      sections: ["environment", "runtime", "danger", "schedule"],
    });
  });
});
