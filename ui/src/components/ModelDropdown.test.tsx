// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import type { AdapterModel } from "@paperclipai/adapter-utils";
import { TooltipProvider } from "@/components/ui/tooltip";
import { antigravityApiKeyModels } from "@paperclipai/shared";
import { antigravityModelGroup } from "@/lib/native-model-catalog";
import { ModelDropdown, type ModelGroupEntry } from "./AgentConfigForm";

const roots: Root[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    act(() => root.unmount());
  }
  document.body.innerHTML = "";
});

function renderOpenDropdown(
  models: AdapterModel[],
  { groupByProvider = false, preserveOrder = false, groupModel, presentation }: {
    groupByProvider?: boolean; preserveOrder?: boolean;
    groupModel?: (model: AdapterModel) => ModelGroupEntry | null; presentation?: "searchable" | "native";
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
          groupModel={groupModel}
          presentation={presentation}
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

  it("groups the Antigravity API-key catalog by family, with the thinking level and paid-plan note on each choice", () => {
    renderOpenDropdown(antigravityApiKeyModels(), { preserveOrder: true, groupModel: antigravityModelGroup("api_key") });
    const headings = Array.from(document.body.querySelectorAll('[role="presentation"]')).map(node => node.textContent);
    expect(headings).toEqual(["Gemini 3.8 Flash", "Gemini 3.7 Flash", "Gemini 3.6 Flash", "Gemini 3.5 Flash", "Gemini 3.1 Pro",
      "Gemini 4 Carbon", "Gemini 4 Neon", "Gemini 4 Hydrogen", "Gemini 4 Argon"]);
    expect(shownModelIds()).toEqual(antigravityApiKeyModels().map(model => model.id));
    const neonExtraHigh = document.body.querySelector('span[title="gemini-4-neon-extra_high"]');
    expect(neonExtraHigh?.textContent).toBe("Extra highneeds a paid Gemini API plan");
    expect(document.body.querySelector('span[title="gemini-3.8-flash-high"]')?.textContent).toBe("High");
  });

  it("groups a Google account catalog that spells extra high as xhigh", () => {
    renderOpenDropdown([
      { id: "gemini-4-neon-high", label: "Gemini 4 Neon (High)" },
      { id: "gemini-4-neon-xhigh", label: "Gemini 4 Neon (Extra)" },
      { id: "account-only-model", label: "Account model" },
    ], { preserveOrder: true, groupModel: antigravityModelGroup("subscription") });
    expect(Array.from(document.body.querySelectorAll('[role="presentation"]')).map(node => node.textContent)).toEqual(["Gemini 4 Neon", "Other models"]);
    expect(document.body.querySelector('span[title="gemini-4-neon-xhigh"]')?.textContent).toBe("Extra high");
  });

  it("uses family option groups in the native picker", () => {
    renderOpenDropdown(antigravityApiKeyModels(), { preserveOrder: true, groupModel: antigravityModelGroup("api_key"), presentation: "native" });
    const groups = Array.from(document.body.querySelectorAll("optgroup"));
    expect(groups.map(group => group.label)).toContain("Gemini 4 Neon");
    const neon = groups.find(group => group.label === "Gemini 4 Neon")!;
    expect(Array.from(neon.querySelectorAll("option")).map(option => [option.value, option.textContent])).toEqual([
      ["gemini-4-neon-high", "High · needs a paid Gemini API plan"],
      ["gemini-4-neon-extra_high", "Extra high · needs a paid Gemini API plan"],
      ["gemini-4-neon-medium", "Medium · needs a paid Gemini API plan"],
      ["gemini-4-neon-low", "Low · needs a paid Gemini API plan"],
    ]);
  });
});
