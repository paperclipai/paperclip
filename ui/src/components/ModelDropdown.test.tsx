// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ModelDropdown } from "./AgentConfigForm";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

function renderOpenDropdown(
  models: AdapterModel[],
  { groupByProvider = false, preserveOrder = false, withDiscovery = false }: {
    groupByProvider?: boolean;
    preserveOrder?: boolean;
    withDiscovery?: boolean;
  } = {},
) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => {
    root.render(
      <TooltipProvider>
        <ModelDropdown
          models={models}
          value=""
          onChange={() => {}}
          open
          onOpenChange={() => {}}
          allowDefault={false}
          required
          groupByProvider={groupByProvider}
          preserveOrder={preserveOrder}
          onDetectModel={withDiscovery ? async () => null : undefined}
          onRefreshModels={withDiscovery ? async () => {} : undefined}
        />
      </TooltipProvider>,
    );
  });
}

function shownModelIds(): string[] {
  return Array.from(document.body.querySelectorAll("span[title]")).map((span) => span.getAttribute("title") ?? "");
}

const curated = [
  { id: "claude-fable-5-1", label: "Claude Fable 5.1" },
  { id: "claude-opus-5-5", label: "Claude Opus 5.5" },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8" },
];

describe("ModelDropdown", () => {
  it("names the model list and keeps search and discovery actions outside its options", () => {
    renderOpenDropdown(curated, { withDiscovery: true });
    const list = document.querySelector('[role="listbox"][aria-label="Models"]');
    expect(list?.querySelectorAll('[role="option"]')).toHaveLength(curated.length);
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(curated.length);
    expect(list?.querySelector('input, button:not([role="option"])')).toBeNull();
    const discovery = [...document.querySelectorAll("button")].filter(button =>
      /Detect from config|Refresh models/.test(button.textContent ?? ""));
    expect(discovery).toHaveLength(2);
    for (const button of discovery) {
      expect(button.getAttribute("role")).toBeNull();
      expect(list?.contains(button)).toBe(false);
    }
  });

  it("offers custom model entry in the shared dropdown and focuses the required model field", async () => {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    await act(async () => root.render(<TooltipProvider>
      <ModelDropdown models={curated} value="" onChange={() => {}}
        open={false} onOpenChange={() => {}} allowDefault={false} required
        groupByProvider={false} creatable presentation="select" />
    </TooltipProvider>));
    await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Model"]')!.click());
    expect(document.querySelector<HTMLButtonElement>('[data-value=""]')?.disabled).toBe(true);
    await act(async () => document.querySelector<HTMLButtonElement>('[data-value="__paperclip_custom_model__"]')!.click());
    const input = container.querySelector<HTMLInputElement>('[aria-label="Model ID"]');
    expect(input?.required).toBe(true);
    expect(document.activeElement).toBe(input);
    expect(document.querySelector('[role="listbox"]')).toBeNull();
  });

  it("keeps a hand-ordered list in the adapter's order when preserveOrder is set", () => {
    renderOpenDropdown(curated, { preserveOrder: true });

    expect(shownModelIds()).toEqual(curated.map((model) => model.id));
  });

  it("still sorts a discovered list by id by default", () => {
    renderOpenDropdown(curated);

    expect(shownModelIds()).toEqual(["claude-fable-5-1", "claude-haiku-4-5", "claude-opus-4-8", "claude-opus-5-5"]);
  });

  it("still sorts provider groups by id", () => {
    renderOpenDropdown(
      [
        { id: "openai/gpt-6-sol", label: "gpt-6-sol" },
        { id: "openai/gpt-6-astra", label: "gpt-6-astra" },
      ],
      { groupByProvider: true },
    );

    expect(shownModelIds()).toEqual(["openai/gpt-6-astra", "openai/gpt-6-sol"]);
  });
});
