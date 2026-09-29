// @vitest-environment jsdom

import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { Agent } from "@paperclipai/shared";
import { afterEach, describe, expect, it, vi } from "vitest";
import { agentsApi } from "@/api/agents";
import { ComposerRunSettingsPicker } from "./ComposerRunSettingsPicker";

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

function render(onAssigneeChange: (value: string) => void, onSettingsChange: () => void, useCatalog = false) {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root!.render(<QueryClientProvider client={queryClient}>
    <ComposerRunSettingsPicker companyId="company-1" assigneeValue="agent:a1" currentAssigneeValue="agent:a1"
      options={options} agents={agents} settings={{ model: "gpt-6-sol", effort: "high", fast: true, daybreak: false, daybreakOverride: "inherit" }}
      onAssigneeChange={onAssigneeChange} onSettingsChange={onSettingsChange}
      modelOptionsOverride={useCatalog ? undefined : []} />
  </QueryClientProvider>));
}

afterEach(() => {
  vi.restoreAllMocks();
  flushSync(() => root?.unmount());
  root = null;
  container?.remove();
  container = null;
});

describe("composer assignee picker", () => {
  it("finds assignees by their displayed role and harness", async () => {
    render(vi.fn(), vi.fn());
    await click("Select assignee, model and effort");
    await click("Choose assignee");
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
    await click("Select assignee, model and effort");
    await click("Choose exact model");
    const options = [...document.querySelectorAll<HTMLButtonElement>('button[role="option"]')]
      .map((item) => item.textContent ?? "");
    expect(options.some((item) => item.includes("gpt-5.5"))).toBe(true);
    expect(options.some((item) => item.includes("gpt-6-sol"))).toBe(true);
    expect(options.some((item) => item.includes("gpt-image"))).toBe(false);
    expect(options.some((item) => item.includes("text-embedding"))).toBe(false);
    expect(document.body.textContent).not.toContain("Loading models…");
  });

  it("exposes the Daybreak access switch for Codex runs", async () => {
    const onSettingsChange = vi.fn();
    render(vi.fn(), onSettingsChange);
    await click("Select assignee, model and effort");
    const toggle = document.querySelector<HTMLButtonElement>('button[aria-label="Daybreak access"]');
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute("aria-pressed")).toBe("false");
    await click("Daybreak access");
    expect(onSettingsChange).toHaveBeenCalledWith({ model: "gpt-6-sol", effort: "high", fast: true, daybreak: true, daybreakOverride: "enabled" });
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
    await click("Select assignee, model and effort");
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
    await click("Select assignee, model and effort");
    await click("Choose assignee");
    await click("Clippy");
    expect(onAssigneeChange).not.toHaveBeenCalled();
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it("offers No assignee and clears settings when selected", async () => {
    const onAssigneeChange = vi.fn();
    const onSettingsChange = vi.fn();
    render(onAssigneeChange, onSettingsChange);
    await click("Select assignee, model and effort");
    await click("Choose assignee");
    await click("No assignee");
    expect(onAssigneeChange).toHaveBeenCalledWith("");
    expect(onSettingsChange).toHaveBeenCalledWith({ model: null, effort: null, fast: false, daybreak: false, daybreakOverride: "inherit" });
  });
});
