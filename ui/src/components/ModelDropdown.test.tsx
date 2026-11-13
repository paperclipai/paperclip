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
  { groupByProvider = false, preserveOrder = false }: { groupByProvider?: boolean; preserveOrder?: boolean } = {},
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
