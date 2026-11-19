// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, click, container, managedApi, render, settle } from "./NewAgent.test-support";
import { ModelDropdown } from "@/components/AgentConfigForm";
import * as modelUtils from "@/lib/model-utils";

beforeEach(async () => {
  const actual = await vi.importActual<typeof import("@/components/AgentConfigForm")>("@/components/AgentConfigForm");
  vi.mocked(ModelDropdown).mockImplementation(actual.ModelDropdown);
});

async function searchModels(query: string) {
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Model"]');
  expect(trigger).toBeTruthy();
  await act(async () => trigger!.click());
  await settle();
  const input = document.querySelector<HTMLInputElement>('input[placeholder="Search models... (type to create)"]');
  expect(input).toBeTruthy();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, query);
    input!.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function selectModel(label: string) {
  const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')]
    .find(node => node.textContent?.includes(label) || node.querySelector("[title]")?.getAttribute("title") === label);
  expect(option).toBeTruthy();
  await act(async () => option!.click());
  await settle();
}

describe("New agent OpenRouter model selection", () => {
  it.each(["opencode_local", "pi_local"])("searches the %s catalog and saves the selected model ID", async adapter => {
    api.adapterModels.mockResolvedValue([
      { id: "openrouter/anthropic/claude-sonnet-4.6", label: "Claude Sonnet" },
      { id: "openrouter/z-ai/glm-5", label: "GLM 5" },
    ]);
    await render(adapter);
    await searchModels("glm-5");
    expect(document.querySelector('[role="option"] [title="openrouter/anthropic/claude-sonnet-4.6"]')).toBeNull();
    await selectModel("openrouter/z-ai/glm-5");
    expect(document.querySelector('[role="listbox"]')).toBeNull();
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterConfig: expect.objectContaining({ model: "openrouter/z-ai/glm-5" }),
    }));
  });

  it.each(["opencode_local", "pi_local"])("accepts a custom model for %s when the catalog is unavailable", async adapter => {
    api.adapterModels.mockRejectedValue(new Error("Catalog unavailable"));
    await render(adapter);
    const model = "openrouter/company/custom-model";
    await searchModels(`  ${model}  `);
    await selectModel("Use manual model");
    expect(container.querySelector('button[aria-label="Model"]')?.textContent).toContain(model);
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterConfig: expect.objectContaining({ model }),
    }));
  });

  it("normalizes a custom OpenRouter model ID for the OpenCode connection", async () => {
    await render("opencode_local");
    await searchModels("company/new-model");
    await selectModel("Use manual model");
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterConfig: expect.objectContaining({ model: "openrouter/company/new-model" }),
    }));
  });

  it("searches routed OpenRouter models for a single-provider harness", async () => {
    const model = "anthropic/claude-sonnet-4.6";
    managedApi.list.mockResolvedValue({ currentUserId: "user-1", canManageConnections: true, connections: [{
      id: "00000000-0000-4000-8000-000000000021", grantId: "00000000-0000-4000-8000-000000000022",
      companyId: "company-1", provider: "openrouter", method: "api_key", name: "Company OpenRouter",
      ownership: "shared", isDefault: false, status: "connected",
      routing: { kind: "openrouter", protocol: "messages", auth: "bearer", models: [{ id: model, label: "Routed Claude Sonnet" }] },
    }] } as any);
    await render("claude_local");
    await click("AdvancedCustom Gateway");
    const connection = container.querySelector('[role="combobox"][aria-label="Connection"]')!;
    await act(async () => connection.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true })));
    await settle();
    await selectModel("Company OpenRouter");
    await click("Use connection");
    await searchModels("Routed Claude");
    await selectModel(model);
    await click("Finish setup");
    expect(api.hire).toHaveBeenCalledWith("company-1", expect.objectContaining({
      adapterConfig: expect.objectContaining({ model }),
      runtimeConfig: expect.objectContaining({ aiConnection: expect.objectContaining({ provider: "openrouter" }) }),
    }));
  });

  it("bounds search work for a large OpenRouter catalog", async () => {
    const size = 600;
    api.adapterModels.mockResolvedValue(Array.from({ length: size }, (_, index) => ({
      id: `openrouter/company/model-${index}`,
      label: `Company model ${index}`,
    })));
    const extractProviderId = modelUtils.extractProviderId;
    let calls = 0;
    const providerSpy = vi.spyOn(modelUtils, "extractProviderId").mockImplementation(id => {
      if (++calls > size * 4) throw new Error("Model search exceeded its linear work limit");
      return extractProviderId(id);
    });
    try {
      await render("opencode_local");
      await searchModels("model-599");
      expect(calls).toBeGreaterThanOrEqual(size);
      expect(calls).toBeLessThanOrEqual(size * 4);
      expect(document.querySelectorAll('[role="option"] [title]')).toHaveLength(1);
      await selectModel("openrouter/company/model-599");
      expect(container.querySelector('button[aria-label="Model"]')?.textContent).toContain("Company model 599");
    } finally {
      providerSpy.mockRestore();
    }
  });
});
