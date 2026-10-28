import { describe, expect, it } from "vitest";
import { resolveAgentAppearance } from "@paperclipai/shared";
import { agentConfigurationRevision, restoreAgentConfigurationRedactions } from "../lib/agent-configuration-revision.js";
import { redactAgentAdapterConfig } from "../redaction.js";

const agent = {
  id: "11111111-1111-4111-8111-111111111111", name: "Codie", role: "engineer" as const, title: null,
  icon: null, appearance: null, reportsTo: null, capabilities: null, adapterType: "codex_local" as const,
  adapterConfig: { model: "example", env: { API_KEY: "fake-secret" }, apiKey: "fake-adapter-secret" },
  runtimeConfig: {}, defaultEnvironmentId: null, budgetMonthlyCents: 0, metadata: null, permissions: {},
};

describe("agent configuration revisions and redactions", () => {
  it("normalizes raw and presented rows and ignores live bookkeeping", () => {
    expect(agentConfigurationRevision({ ...agent, appearance: resolveAgentAppearance(null, agent.id), permissions: { canCreateAgents: false, canCreateSkills: true } }))
      .toBe(agentConfigurationRevision(agent));
    const runtimeChange = { ...agent, status: "running", spentMonthlyCents: 100, updatedAt: new Date() };
    expect(agentConfigurationRevision(runtimeChange)).toBe(agentConfigurationRevision(agent));
    for (const patch of [{ name: "Renamed" }, { budgetMonthlyCents: 2 }, { adapterConfig: { ...agent.adapterConfig, model: "new" } }]) {
      expect(agentConfigurationRevision({ ...agent, ...patch })).not.toBe(agentConfigurationRevision(agent));
    }
  });

  it("preserves redacted secrets while changing another key and permits explicit removal", () => {
    const displayed = redactAgentAdapterConfig(agent.adapterConfig);
    expect(restoreAgentConfigurationRedactions({ ...displayed, model: "new" }, agent.adapterConfig, displayed))
      .toEqual({ ...agent.adapterConfig, model: "new" });
    expect(restoreAgentConfigurationRedactions({ model: "new" }, agent.adapterConfig, displayed)).toEqual({ model: "new" });
  });

  it("rejects moved and partially edited redactions", () => {
    expect(() => restoreAgentConfigurationRedactions({ other: "***REDACTED***" }, { apiKey: "secret" }, { apiKey: "***REDACTED***" })).toThrow("redacted value");
    expect(() => restoreAgentConfigurationRedactions("Bearer ***REDACTED*** edited", "Bearer secret", "Bearer ***REDACTED***")).toThrow("redacted value");
  });
});
