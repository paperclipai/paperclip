// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { storybookAgents } from "../../../storybook/fixtures/paperclipData";
import { TooltipProvider } from "../ui/tooltip";
import { AgentBulkSettingsSheet } from "./AgentBulkSettingsSheet";

const api = vi.hoisted(() => ({ models: vi.fn(), accounts: vi.fn(), update: vi.fn(), get: vi.fn() }));
vi.mock("@/api/agents", () => ({ agentsApi: { adapterModels: api.models, updateRuntimeSettings: api.update, get: api.get } }));
vi.mock("@/api/ai-connections", () => ({ aiConnectionsApi: { list: api.accounts } }));

let root: Root;
let client: QueryClient;
const onClose = vi.fn();
const agent = (id: string, adapterType: Agent["adapterType"] = "hermes_local"): Agent => ({
  ...storybookAgents[0], id, name: id, companyId: "company-1", adapterType,
  adapterConfig: { model: "old-model" }, runtimeConfig: {},
});

async function render(agents: Agent[]) {
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const draw = (selected: Agent[]) => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <AgentBulkSettingsSheet companyId="company-1" agents={selected} totalSelected={selected.length} onClose={onClose} />
  </TooltipProvider></QueryClientProvider>);
  await act(async () => draw(agents));
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  return async (selected: Agent[]) => {
    await act(async () => draw(selected));
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  };
}

function button(name: string) {
  const result = [...document.querySelectorAll<HTMLButtonElement>("button")]
    .find(el => el.getAttribute("aria-label") === name || el.textContent?.trim() === name);
  if (!result) throw new Error(`Missing button: ${name}`);
  return result;
}

async function chooseModel(id: string, manual = false) {
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Change default model"]')!.click());
  await act(async () => button("Model").click());
  if (manual) {
    const input = document.querySelector<HTMLInputElement>('input[placeholder^="Search models"]')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, id);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
  }
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(el => manual ? el.textContent?.includes("Use manual model") : el.textContent?.trim() === id);
  expect(option).toBeDefined();
  await act(async () => option!.click());
}

beforeEach(() => {
  vi.resetAllMocks();
  api.accounts.mockResolvedValue({ currentUserId: "board", canManageConnections: true, connections: [], pools: [] });
  api.models.mockResolvedValue([]);
});
afterEach(async () => {
  await act(async () => root?.unmount());
  client?.clear();
  document.body.innerHTML = "";
});

describe("bulk model editing", () => {
  it("refreshes an Antigravity catalog when its saved binding or environment changes", async () => {
    const first = { provider: "google", method: "subscription", mode: "shared", connectionId: "11111111-1111-4111-8111-111111111111", grantId: "33333333-3333-4333-8333-333333333333" } as const;
    const second = { ...first, connectionId: "22222222-2222-4222-8222-222222222222", grantId: "44444444-4444-4444-8444-444444444444" };
    const google = { ...agent("Antigravity", "paperclip_runner"), defaultEnvironmentId: "local-1",
      adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "old-model" }, runtimeConfig: { aiConnection: first } } as Agent;
    const rerender = await render([google]);
    expect(api.models).toHaveBeenCalledTimes(1);
    await rerender([{ ...google, defaultEnvironmentId: "remote-2", runtimeConfig: { aiConnection: second } }]);
    expect(api.models).toHaveBeenCalledTimes(2);
    expect(api.models).toHaveBeenLastCalledWith("company-1", "paperclip_runner", {
      provider: "acpx", acpxAgent: "antigravity", agentId: google.id, aiConnection: second, environmentId: "remote-2",
    });
  });

  it.each([
    { method: "api_key", responsible: false },
    { method: "api_key", responsible: true },
    { method: "subscription", responsible: false },
    { method: "subscription", responsible: true },
  ] as const)("uses the bound Antigravity catalog and preserves $method manual-model policy (responsible: $responsible)", async ({ method, responsible }) => {
    const connectionId = "11111111-1111-4111-8111-111111111111", grantId = "33333333-3333-4333-8333-333333333333";
    const binding = responsible ? { provider: "google", method, mode: "responsible_user" } as const
      : { provider: "google", method, mode: "shared", connectionId, grantId } as const;
    const google = { ...agent("Antigravity", "paperclip_runner"), defaultEnvironmentId: "local-1",
      adapterConfig: { provider: "acpx", acpxAgent: "antigravity", model: "old-model" }, runtimeConfig: { aiConnection: binding } } as Agent;
    api.accounts.mockResolvedValue({ currentUserId: "board", canManageConnections: true, pools: [], connections: [{
      id: connectionId, grantId, companyId: "company-1", provider: "google", method, name: "Selected Google account", status: "connected",
      ownership: responsible ? "personal" : "shared", ownerUserId: "board", isDefault: true,
    }] });
    if (method === "api_key") api.models.mockRejectedValue(new Error("Subscription sign-in is required to discover Google models"));
    else api.models.mockResolvedValue([{ id: "gemini-exact", label: "gemini-exact" }]);
    api.update.mockImplementation(async (_id, patch) => ({ ...google, adapterConfig: { ...google.adapterConfig, model: patch.model } }));
    await render([google]);
    if (method === "api_key") expect(api.models).not.toHaveBeenCalled();
    else expect(api.models).toHaveBeenCalledWith("company-1", "paperclip_runner", {
      provider: "acpx", acpxAgent: "antigravity", agentId: google.id, aiConnection: binding, environmentId: "local-1",
    });
    await chooseModel("gemini-custom", true);
    await vi.waitFor(() => expect(button("Update 1 agent").disabled).toBe(false));
    await act(async () => button("Update 1 agent").click());
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(["Antigravity"], true));
    expect(api.update).toHaveBeenCalledWith("Antigravity", expect.objectContaining({
      harness: "antigravity_runtime", model: "gemini-custom",
      expected: { model: "old-model", aiConnection: binding },
    }), "company-1");
  });

  it("saves a manual Hermes model when the local adapter has no catalog", async () => {
    const hermes = agent("Hermes");
    api.update.mockResolvedValue({ ...hermes, adapterConfig: { model: "provider/custom-model" } });
    await render([hermes]);
    await chooseModel("provider/custom-model", true);
    await vi.waitFor(() => expect(button("Update 1 agent").disabled).toBe(false));
    await act(async () => button("Update 1 agent").click());
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(["Hermes"], true));
    expect(api.update).toHaveBeenCalledWith("Hermes", expect.objectContaining({ model: "provider/custom-model", harness: "hermes_local" }), "company-1");
  });

  it("does not offer manual entry for a restricted connection catalog", async () => {
    const codex = agent("Codex", "codex_local");
    codex.runtimeConfig = { aiConnection: { provider: "openai", method: "api_key", mode: "shared", connectionId: "10000000-0000-4000-8000-000000000001", grantId: "10000000-0000-4000-8000-000000000002" } };
    api.accounts.mockResolvedValue({ currentUserId: "board", connections: [{ id: "10000000-0000-4000-8000-000000000001", grantId: "10000000-0000-4000-8000-000000000002", routing: { kind: "gateway", protocol: "responses", models: [{ id: "allowed-model" }] } }] });
    await render([codex]);
    await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Change default model"]')!.click());
    await act(async () => button("Model").click());
    expect(document.querySelector('input[placeholder="Search models..."]')).not.toBeNull();
    expect(document.querySelector('input[placeholder*="type to create"]')).toBeNull();
  });

  it("retries only failed agents even when a saved agent's model probe becomes unavailable", async () => {
    const atlas = agent("Atlas", "paperclip_runner");
    const scout = agent("Scout", "paperclip_runner");
    atlas.adapterConfig = scout.adapterConfig = { provider: "acpx", acpxAgent: "copilot", model: "old-model" };
    let partialSave = false;
    api.models.mockImplementation(async (_company, _adapter, options) => {
      if (partialSave && options.agentId === "Atlas") throw new Error("Environment unavailable");
      return [{ id: "new-model", label: "new-model" }];
    });
    api.update.mockImplementation(async (id, patch) => {
      if (id === "Scout" && !partialSave) { partialSave = true; throw new Error("Try again"); }
      const original = id === "Atlas" ? atlas : scout;
      return { ...original, adapterConfig: { ...original.adapterConfig, model: patch.model } };
    });
    api.get.mockResolvedValue(scout);
    await render([atlas, scout]);
    await chooseModel("new-model");
    await act(async () => button("Update 2 agents").click());
    await vi.waitFor(() => expect(button("Retry 1 agent")).toBeDefined());
    api.models.mockClear();
    await act(async () => { await client.invalidateQueries({ queryKey: ["bulk-agent-models"] }); });
    await vi.waitFor(() => expect(button("Retry 1 agent").disabled).toBe(false));
    expect(api.models.mock.calls.every(([, , options]) => options.agentId === "Scout")).toBe(true);
    expect(api.models).toHaveBeenCalled();
    await act(async () => button("Retry 1 agent").click());
    await vi.waitFor(() => expect(onClose).toHaveBeenCalledWith(["Atlas", "Scout"], true));
    expect(api.update.mock.calls.map(([id]) => id)).toEqual(["Atlas", "Scout", "Scout"]);
  });
});
