// @vitest-environment jsdom

import { act, type ComponentProps } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "@/api/agents";
import { ComposerRunSettingsPicker } from "./ComposerRunSettingsPicker";
import { getLastComposerEffort, rememberComposerEffort } from "@/lib/recent-composer-effort";

const agent = {
  id: "a1", companyId: "company-1", name: "Clippy",
  role: "Engineering Lead",
  adapterType: "codex_local", adapterConfig: { model: "gpt-6-sol" },
} as unknown as Agent;
const options = [{ id: "agent:a1", label: "Clippy" }];
const agents = new Map([[agent.id, agent]]);
let container: HTMLDivElement | null = null;
let root: ReturnType<typeof createRoot> | null = null;
globalThis.ResizeObserver = class {
  observe() {}
  disconnect() {}
  unobserve() {}
};
(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

async function click(label: string) {
  const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
    ?? [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')].find((item) => item.textContent?.trim().startsWith(label));
  expect(button).toBeDefined();
  flushSync(() => button!.click());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function render(onAssigneeChange: (value: string) => void, onSettingsChange: () => void, useCatalog = false, props: Partial<ComponentProps<typeof ComposerRunSettingsPicker>> = {}) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root!.render(<QueryClientProvider client={queryClient}>
    <ComposerRunSettingsPicker companyId="company-1" assigneeValue="agent:a1" currentAssigneeValue="agent:a1"
      options={options} agents={agents} settings={{ model: "gpt-6-sol", effort: "high", fast: true }}
      onAssigneeChange={onAssigneeChange} onSettingsChange={onSettingsChange}
      modelOptionsOverride={useCatalog ? undefined : []} {...props} />
  </QueryClientProvider>));
}

beforeEach(() => localStorage.clear());
afterEach(() => {
  vi.restoreAllMocks();
  flushSync(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("composer assignee picker", () => {
  it.each([
    { adapterType: "claude_local", config: {}, label: "Claude Opus 5" },
    { adapterType: "codex_local", config: {}, label: "Default" },
  ])("labels the $adapterType default honestly", ({ adapterType, config, label }) => {
    const defaultAgent = { ...agent, adapterType, adapterConfig: config } as Agent;
    render(vi.fn(), vi.fn(), false, { settings: null, agents: new Map([[agent.id, defaultAgent]]),
      modelOptionsOverride: [{ id: "claude-opus-5", label: "Claude Opus 5" }] });
    expect(container!.querySelector('[data-testid="task-chat-composer-model-label"]')?.textContent).toBe(label);
  });

  it.each([
    { remembered: "high", settings: null, overrides: null, restored: "high" },
    { remembered: "off", settings: null, overrides: null, restored: null },
    { remembered: "high", settings: { model: null, effort: "low", fast: false }, overrides: null, restored: null },
    { remembered: "high", settings: null, overrides: { adapterConfig: { modelReasoningEffort: "low" } }, restored: null },
  ])("restores compatible history ($remembered) without replacing explicit settings", ({ remembered, settings, overrides, restored }) => {
    rememberComposerEffort("company-1", remembered);
    const onSettingsChange = vi.fn();
    render(vi.fn(), onSettingsChange, false, { settings, overrides });
    if (restored) expect(onSettingsChange).toHaveBeenCalledWith({ model: null, effort: restored, fast: false });
    else expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("records effort changes and preserves effort when changing to a compatible model", async () => {
    const onSettingsChange = vi.fn();
    render(vi.fn(), onSettingsChange, false, { modelOptionsOverride: [{ id: "gpt-6-astra", label: "GPT-6 Astra" }] });
    await click("Select model and effort");
    const range = document.querySelector<HTMLInputElement>('input[aria-label="Effort"]')!;
    flushSync(() => {
      Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!.call(range, "1");
      range.dispatchEvent(new Event("change", { bubbles: true }));
      range.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(getLastComposerEffort("company-1")).toBe("low");
    await click("Choose exact model");
    await click("GPT-6 Astra");
    expect(onSettingsChange).toHaveBeenLastCalledWith({ model: "gpt-6-astra", effort: "high", fast: false });
    await click("Reset to agent default");
    expect(getLastComposerEffort("company-1")).toBeNull();
  });
  it("lets the assignee and model use the available composer width", () => {
    render(vi.fn(), vi.fn());
    const trigger = container!.querySelector<HTMLButtonElement>('[data-testid="task-chat-composer-assignee"]');
    const assignee = trigger!.querySelector('[data-testid="task-chat-composer-assignee-label"]');
    const model = container!.querySelector('[data-testid="task-chat-composer-model-label"]');

    expect(trigger?.className).toContain("max-w-full");
    expect(trigger?.className).not.toContain("max-w-64");
    expect(assignee?.className).toContain("min-w-0");
    expect(assignee?.className).not.toContain("max-w-24");
    expect(model?.className).toContain("min-w-0");
    expect(assignee?.className).toContain("truncate");
    expect(model?.className).toContain("truncate");
  });

  it("finds assignees by their displayed role and harness", async () => {
    render(vi.fn(), vi.fn());
    await click("Select assignee");
    const input = document.querySelector<HTMLInputElement>('input[aria-label="Search assignees"]');
    expect(input).not.toBeNull();
    const setValue = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
    for (const query of ["Engineering Lead", "Codex"]) {
      flushSync(() => {
        setValue.call(input, query);
        input!.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect([...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
        .some((option) => option.textContent?.includes("Clippy"))).toBe(true);
    }
  });

  it("offers the Codex CLI catalog instead of unrelated OpenAI API models", async () => {
    vi.spyOn(agentsApi, "adapterModels").mockResolvedValueOnce([
      { id: "gpt-6-sol", label: "GPT-6 Sol" },
      { id: "gpt-5.5", label: "GPT-5.5" },
    ]);
    render(vi.fn(), vi.fn(), true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    await click("Select model and effort");
    await click("Choose exact model");
    const options = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .map((item) => item.textContent ?? "");
    expect(options.some((item) => item.includes("gpt-5.5"))).toBe(true);
    expect(options.some((item) => item.includes("gpt-6-sol"))).toBe(true);
    expect(options.some((item) => item.includes("gpt-image"))).toBe(false);
    expect(options.some((item) => item.includes("text-embedding"))).toBe(false);
    expect(document.body.textContent).not.toContain("Loading models…");
  });

  it("shows an instance-declared Codex model list instead of bundled alternatives", async () => {
    const loadModels = vi.spyOn(agentsApi, "adapterModels").mockResolvedValueOnce([
      { id: "private-codex", label: "Private Codex" },
    ]);
    render(vi.fn(), vi.fn(), true);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    expect(loadModels).toHaveBeenCalledWith("company-1", "codex_local", {
      environmentId: null,
      provider: undefined,
    });
    await click("Select model and effort");
    await click("Choose exact model");
    const choices = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .map((item) => item.textContent ?? "");
    expect(choices.some((item) => item.includes("Private Codex"))).toBe(true);
    expect(choices.some((item) => item.includes("GPT-6 Sol"))).toBe(false);
  });

  it("preserves settings when the selected assignee is chosen again", async () => {
    const onAssigneeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(onAssigneeChange, onSettingsChange);
    await click("Select assignee");
    await click("Clippy");
    expect(onAssigneeChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("offers No assignee and clears settings when selected", async () => {
    const onAssigneeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(onAssigneeChange, onSettingsChange);
    await click("Select assignee");
    await click("No assignee");
    expect(onAssigneeChange).toHaveBeenCalledWith("");
    expect(onSettingsChange).toHaveBeenCalledWith(null);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it.each(["", "user:me"])("hides model and effort for %s and opens assignees in one click", async (assigneeValue) => {
    const loadModels = vi.spyOn(agentsApi, "adapterModels");
    render(vi.fn(), vi.fn(), true, {
      assigneeValue,
      currentAssigneeValue: assigneeValue,
      options: [...options, { id: "user:me", label: "Me" }],
    });
    expect(container!.querySelector('[data-testid="task-chat-composer-model-label"]')).toBeNull();
    expect(container!.querySelector('[aria-label="Select model and effort"]')).toBeNull();
    expect(container!.textContent).not.toContain("Harness default");
    expect(container!.textContent).not.toContain("High");
    await click("Select assignee");
    expect(document.querySelector('[aria-label="Search assignees"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Effort"]')).toBeNull();
    expect(document.querySelector('[aria-label="Choose exact model"]')).toBeNull();
    expect(document.body.textContent).not.toContain("Choose an agent");
    expect(loadModels).not.toHaveBeenCalled();
  });

  it("opens the assignee list directly on mobile", async () => {
    render(vi.fn(), vi.fn(), false, { mobile: true });
    await click("Select assignee");
    expect(document.querySelector('[data-testid="composer-mobile-dialog"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Search assignees"]')).not.toBeNull();
    expect(document.querySelector('[aria-label="Choose exact model"]')).toBeNull();
  });
});
