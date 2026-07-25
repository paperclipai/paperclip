// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { OllamaLocalConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function renderFields(overrides: Partial<AdapterConfigFieldsProps> = {}) {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  const mark = vi.fn();
  const props: AdapterConfigFieldsProps = {
    mode: "edit",
    isCreate: false,
    adapterType: "ollama_local",
    values: null,
    set: null,
    config: {},
    eff: (_group, _field, original) => original,
    mark,
    models: [],
    ...overrides,
  };

  act(() => {
    root.render(
      <TooltipProvider>
        <OllamaLocalConfigFields {...props} />
      </TooltipProvider>,
    );
  });

  return { container, root, mark };
}

describe("OllamaLocalConfigFields", () => {
  const roots: Root[] = [];

  afterEach(() => {
    for (const root of roots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = "";
  });

  it("exposes API mode and bearer authentication settings", () => {
    const result = renderFields({ config: { apiMode: "ollama", apiKey: "stored-key" } });
    roots.push(result.root);

    expect(result.container.textContent).toContain("API mode");
    expect(result.container.textContent).toContain("API key");
    expect(result.container.querySelector<HTMLSelectElement>('select[aria-label="API mode"]')?.value).toBe("ollama");
    expect(result.container.querySelector<HTMLInputElement>('input[type="password"]')?.value).toBe("stored-key");
  });

  it("commits API mode changes", () => {
    const result = renderFields({ config: { apiMode: "openai" } });
    roots.push(result.root);
    const select = result.container.querySelector<HTMLSelectElement>('select[aria-label="API mode"]');
    expect(select).toBeTruthy();
    if (!select) throw new Error("API mode select was not rendered");

    act(() => {
      const event = new Event("change", { bubbles: true });
      Object.defineProperty(select, "value", { value: "ollama", configurable: true });
      select.dispatchEvent(event);
    });

    expect(result.mark).toHaveBeenCalledWith("adapterConfig", "apiMode", "ollama");
  });
});
