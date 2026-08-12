// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaConfigFields } from "./schema-config-fields";
import { defaultCreateValues } from "../components/agent-config-defaults";
import { TooltipProvider } from "../components/ui/tooltip";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

async function act(callback: () => void | Promise<void>) {
  let result: void | Promise<void> = undefined;
  flushSync(() => {
    result = callback();
  });
  await result;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

function mockMatchMedia(isCoarsePointer: boolean) {
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    matches: query === "(pointer: coarse)" ? isCoarsePointer : false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

function mockMutablePointerMedia(initialIsCoarsePointer: boolean) {
  let isCoarsePointer = initialIsCoarsePointer;
  let changeHandler: (() => void) | null = null;
  window.matchMedia = vi.fn().mockImplementation((query: string) => ({
    get matches() {
      return query === "(pointer: coarse)" ? isCoarsePointer : false;
    },
    media: query,
    onchange: null,
    addEventListener: vi.fn((_type: string, handler: () => void) => {
      changeHandler = handler;
    }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));

  return {
    setCoarsePointer(next: boolean) {
      isCoarsePointer = next;
      changeHandler?.();
    },
  };
}


function defaultMatchMedia(query: string): MediaQueryList {
  return {
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(),
  } as unknown as MediaQueryList;
}

describe("SchemaConfigFields combobox", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalFetch: typeof globalThis.fetch;
  let originalMatchMedia: typeof window.matchMedia;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    originalFetch = globalThis.fetch;
    originalMatchMedia = window.matchMedia;
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({
        fields: [
          {
            key: "model",
            label: "Model",
            type: "combobox",
            hint: "Select a model",
            options: [
              { label: "GPT 5", value: "gpt-5" },
              { label: "GPT 5 Mini", value: "gpt-5-mini" },
            ],
          },
        ],
      }),
    } as Response);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
    });
    document.body.replaceChildren();
    globalThis.fetch = originalFetch;
    window.matchMedia = originalMatchMedia ?? defaultMatchMedia;
    vi.restoreAllMocks();
  });

  it("does not focus or raise the keyboard for model combobox input on coarse pointers", async () => {
    mockMatchMedia(true);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <SchemaConfigFields
            adapterType="test-adapter"
            isCreate
            values={{ ...defaultCreateValues, adapterSchemaValues: { model: "gpt-5" } }}
            set={vi.fn()}
            config={{}}
            eff={(_scope, _key, fallback) => fallback}
            mark={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    await flushReact();

    const modelInput = container.querySelector('input[value="gpt-5"]') as HTMLInputElement | null;
    expect(modelInput).not.toBeNull();
    expect(modelInput?.readOnly).toBe(true);
    expect(modelInput?.inputMode).toBe("none");
    expect(modelInput?.autocomplete).toBe("off");
    expect(modelInput?.getAttribute("autocorrect")).toBe("off");
    expect(modelInput?.getAttribute("autocapitalize")).toBe("off");
    expect(modelInput?.getAttribute("spellcheck")).toBe("false");
    expect(modelInput?.className).toContain("paperclip-mobile-control-font-size");

    await act(async () => {
      modelInput?.focus();
    });

    expect(document.activeElement).not.toBe(modelInput);
  });

  it("keeps model combobox typeable on fine pointers", async () => {
    mockMatchMedia(false);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <SchemaConfigFields
            adapterType="test-adapter"
            isCreate
            values={{ ...defaultCreateValues, adapterSchemaValues: { model: "gpt-5" } }}
            set={vi.fn()}
            config={{}}
            eff={(_scope, _key, fallback) => fallback}
            mark={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    await flushReact();

    const modelInput = container.querySelector('input[value="gpt-5"]') as HTMLInputElement | null;
    expect(modelInput).not.toBeNull();
    expect(modelInput?.readOnly).toBe(false);
    expect(modelInput?.inputMode).toBe("");
    expect(modelInput?.className).toContain("paperclip-mobile-control-font-size");
  });

  it("blurs a focused model combobox input when pointer mode becomes coarse", async () => {
    const pointer = mockMutablePointerMedia(false);

    await act(async () => {
      root.render(
        <TooltipProvider>
          <SchemaConfigFields
            adapterType="test-adapter"
            isCreate
            values={{ ...defaultCreateValues, adapterSchemaValues: { model: "gpt-5" } }}
            set={vi.fn()}
            config={{}}
            eff={(_scope, _key, fallback) => fallback}
            mark={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    await flushReact();

    const modelInput = container.querySelector('input[value="gpt-5"]') as HTMLInputElement | null;
    expect(modelInput).not.toBeNull();

    await act(async () => {
      modelInput?.focus();
    });
    expect(document.activeElement).toBe(modelInput);

    await act(async () => {
      pointer.setCoarsePointer(true);
    });

    expect(document.activeElement).not.toBe(modelInput);
    expect(modelInput?.readOnly).toBe(true);
    expect(modelInput?.inputMode).toBe("none");
  });
});
