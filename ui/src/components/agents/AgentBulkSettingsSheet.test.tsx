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
  await act(async () => root.render(<QueryClientProvider client={client}><TooltipProvider>
    <AgentBulkSettingsSheet companyId="company-1" agents={agents} totalSelected={agents.length} onClose={onClose} />
  </TooltipProvider></QueryClientProvider>));
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
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
