import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { copilotTaskModelCatalogOptions } from "./copilot-task-model-catalog";

describe("Copilot task model catalog identity", () => {
  const agent = { id: "copilot", adapterType: "paperclip_runner", adapterConfig: {
    provider: "acpx", acpxAgent: "copilot",
  } } as unknown as Agent;
  it("changes the catalog identity when a saved connection changes", () => {
    const a = copilotTaskModelCatalogOptions({ ...agent, runtimeConfig: { aiConnection: {
      provider: "github", method: "api_key", mode: "shared", connectionId: "11111111-1111-4111-8111-111111111111", grantId: "33333333-3333-4333-8333-333333333333",
    } } });
    const b = copilotTaskModelCatalogOptions({ ...agent, runtimeConfig: { aiConnection: {
      provider: "github", method: "api_key", mode: "shared", connectionId: "22222222-2222-4222-8222-222222222222", grantId: "33333333-3333-4333-8333-333333333333",
    } } });
    expect(a).not.toEqual(b);
  });
  it("allows normal responsible-user discovery when no explicit binding is saved", () => {
    expect(copilotTaskModelCatalogOptions(agent)).toEqual({ acpxAgent: "copilot", agentId: "copilot", aiConnection: undefined });
  });
  it("does not change catalogs for other runners", () => {
    expect(copilotTaskModelCatalogOptions({ ...agent, adapterConfig: { provider: "acpx", acpxAgent: "claude" } })).toBeUndefined();
  });
});
