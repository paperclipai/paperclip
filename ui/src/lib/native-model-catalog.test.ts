import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { nativeTaskModelCatalogOptions } from "./native-model-catalog";
import { isNewAgentAdapterAllowed } from "./new-agent-adapters";

const agent = { id: "google-agent", adapterType: "paperclip_runner", adapterConfig: { provider: "acpx", acpxAgent: "antigravity" } } as unknown as Agent;
describe("Antigravity model catalog scope", () => {
  it("binds discovery to the assignee and selected Google account", () => {
    const binding = { provider: "google", method: "subscription", mode: "responsible_user" } as const;
    expect(nativeTaskModelCatalogOptions({ ...agent, runtimeConfig: { aiConnection: binding } })).toEqual({
      acpxAgent: "antigravity", agentId: agent.id, aiConnection: binding,
    });
    expect(nativeTaskModelCatalogOptions({ ...agent, runtimeConfig: { aiConnection: {
      provider: "google", method: "api_key", mode: "responsible_user",
    } } })).not.toEqual(nativeTaskModelCatalogOptions({ ...agent, runtimeConfig: { aiConnection: binding } }));
  });
  it("does not substitute Claude for a missing saved account", () => {
    expect(nativeTaskModelCatalogOptions(agent)).toEqual({ acpxAgent: "antigravity", agentId: agent.id, aiConnection: undefined });
    expect(nativeTaskModelCatalogOptions({ ...agent, adapterConfig: { provider: "acpx", acpxAgent: "claude" } })).toBeUndefined();
  });
  it("keeps pending Antigravity unavailable even when experimental Runner is enabled", () => {
    expect(isNewAgentAdapterAllowed("paperclip_runner", { cloud: false, nativeRunnerEnabled: true, runnerProvider: "antigravity" })).toBe(false);
  });
});
