// @vitest-environment jsdom
import { act } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api, click, container, render, settle } from "./NewAgent.test-support";
import { ModelDropdown } from "@/components/AgentConfigForm";

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
    expect(document.querySelector('[role="listbox"]')?.textContent).not.toContain("Claude Sonnet");
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
});
