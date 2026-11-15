// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AGENT_INTERACTION_PERMISSION_KEYS } from "@paperclipai/shared";
import { AgentInteractionPermissionsPanel } from "./AgentInteractionPermissionsPanel";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const api = vi.hoisted(() => ({ interactionPermissions: vi.fn(), updateInteractionPermissions: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: api }));

const allowed = Object.fromEntries(AGENT_INTERACTION_PERMISSION_KEYS.map((key) => [key, true]));
const state = (overrides: Record<string, boolean>) => ({
  agentId: "agent-1", companyId: "company-1", overrides, effective: { ...allowed, ...overrides },
});

let root: Root, container: HTMLDivElement;
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  await act(async () => {
    root.render(<QueryClientProvider client={client}><AgentInteractionPermissionsPanel agentId="agent-1" /></QueryClientProvider>);
  });
  await vi.waitFor(() => expect(toggle("Can ask people directly").disabled).toBe(false));
}
const toggle = (label: string) => container.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)!;
const settle = () => vi.waitFor(() => expect(container.querySelectorAll("button[aria-checked]:disabled")).toHaveLength(0));

describe("AgentInteractionPermissionsPanel", () => {
  it("shows one toggle per interaction permission with its effective value", async () => {
    api.interactionPermissions.mockResolvedValue(state({ canAskHumans: false }));
    await render();
    expect(container.querySelectorAll("button[role='switch'], button[aria-checked]")).toHaveLength(AGENT_INTERACTION_PERMISSION_KEYS.length);
    expect(toggle("Can ask people directly").getAttribute("aria-checked")).toBe("false");
    expect(toggle("Can mention other agents").getAttribute("aria-checked")).toBe("true");
  });

  it("restricts an allowed permission and restores a restricted one to the default", async () => {
    api.interactionPermissions.mockResolvedValue(state({ canAskHumans: false }));
    api.updateInteractionPermissions.mockImplementation(async (_id: string, patch: Record<string, boolean | null>) =>
      state(Object.fromEntries(Object.entries({ canAskHumans: false, ...patch }).filter(([, value]) => value === false)) as Record<string, boolean>));
    await render();
    await act(async () => toggle("Can mention other agents").click());
    await settle();
    expect(api.updateInteractionPermissions).toHaveBeenLastCalledWith("agent-1", { canMentionAgents: false });
    await vi.waitFor(() => expect(toggle("Can mention other agents").getAttribute("aria-checked")).toBe("false"));
    await act(async () => toggle("Can ask people directly").click());
    await settle();
    expect(api.updateInteractionPermissions).toHaveBeenLastCalledWith("agent-1", { canAskHumans: null });
    await vi.waitFor(() => expect(toggle("Can ask people directly").getAttribute("aria-checked")).toBe("true"));
  });

  it("shows the server's refusal when a change is not allowed", async () => {
    api.interactionPermissions.mockResolvedValue(state({}));
    api.updateInteractionPermissions.mockRejectedValue(new Error("Only a human permission manager can change interaction permissions"));
    await render();
    await act(async () => toggle("Can ask people directly").click());
    await vi.waitFor(() => expect(container.querySelector("[role='alert']")?.textContent).toContain("Only a human permission manager"));
  });
});
