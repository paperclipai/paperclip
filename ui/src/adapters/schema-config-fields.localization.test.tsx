// @vitest-environment jsdom

import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "@/i18n";
import { SchemaConfigFields, invalidateConfigSchemaCache } from "./schema-config-fields";
import { TooltipProvider } from "@/components/ui/tooltip";

// Existing behavior closes the popover with zero matches, so the custom-value
// hint is currently unreachable visually. Mount its contents here to verify the
// localized branch without changing that separately scoped visibility behavior.
vi.mock("@/components/ui/popover", () => ({
  Popover: ({ open, children }: { open: boolean; children: ReactNode }) => <div data-testid="schema-popover" data-open={String(open)}>{children}</div>,
  PopoverTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  PopoverContent: ({ children }: { children: ReactNode }) => <div data-testid="schema-content">{children}</div>,
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("schema custom-value display localization", () => {
  let container: HTMLDivElement;
  let root: Root;
  const adapterType = "raw_custom_adapter";

  beforeEach(async () => {
    await i18n.changeLanguage("en");
    invalidateConfigSchemaCache(adapterType);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    invalidateConfigSchemaCache(adapterType);
    await i18n.changeLanguage("en");
    vi.unstubAllGlobals();
  });

  it("translates the entire hint EN → RU → EN while keeping typed values, external labels and the Enter payload unchanged", async () => {
    const schema = { fields: [{
      key: "raw_model_key", label: "Provider-owned label", type: "combobox",
      options: [{ label: "Provider-owned model", value: "raw-model-1" }],
    }] };
    const original = JSON.stringify(schema);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => schema });
    vi.stubGlobal("fetch", fetchMock);
    const mark = vi.fn();
    await act(async () => root.render(<TooltipProvider><SchemaConfigFields
      mode="edit" isCreate={false} adapterType={adapterType} values={null} set={null}
      config={{ raw_model_key: "raw-model-1" }} eff={(_group, _key, originalValue) => originalValue} mark={mark} models={[]}
    /></TooltipProvider>));
    const input = container.querySelector("input")!;
    const filter = 'Custom <provider> {{not_a_variable}} "raw"';
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(input, filter);
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const hint = container.querySelector('[data-testid="schema-content"]')!;
    for (const locale of ["en", "ru", "en"] as const) {
      await act(async () => { await i18n.changeLanguage(locale); });
      expect(container.querySelector("input")).toBe(input);
      expect(input.value).toBe(filter);
      expect(hint.textContent).toBe(locale === "ru"
        ? `Использовать «${filter}» как произвольное значение (нажмите Enter)`
        : `Use "${filter}" as custom value (press Enter)`);
      expect(container.querySelector("label")?.textContent).toBe("Provider-owned label");
      expect(container.querySelector('[data-testid="schema-popover"]')?.getAttribute("data-open")).toBe("false");
      expect(JSON.stringify(schema)).toBe(original);
      expect(fetchMock).toHaveBeenCalledExactlyOnceWith("/api/adapters/raw_custom_adapter/config-schema");
      expect(mark).not.toHaveBeenCalled();
    }
    await act(async () => { input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
    expect(mark).toHaveBeenCalledExactlyOnceWith("adapterConfig", "raw_model_key", filter);
  });
});
