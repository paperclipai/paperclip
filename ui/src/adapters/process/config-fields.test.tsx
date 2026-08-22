// @vitest-environment jsdom

import { createRoot, type Root } from "react-dom/client";
import { flushSync } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ProcessConfigFields } from "./config-fields";
import type { AdapterConfigFieldsProps } from "../types";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function act(callback: () => void) {
  flushSync(callback);
}

function labels(container: HTMLElement): string[] {
  return Array.from(container.querySelectorAll("label")).map((el) => el.textContent?.trim() ?? "");
}

function baseProps(overrides: Partial<AdapterConfigFieldsProps> = {}): AdapterConfigFieldsProps {
  return {
    mode: "edit",
    isCreate: false,
    adapterType: "process",
    values: null,
    set: null,
    config: {},
    eff: (_group, _field, original) => original,
    mark: vi.fn(),
    models: [],
    ...overrides,
  };
}

describe("ProcessConfigFields", () => {
  let roots: Root[] = [];

  afterEach(() => {
    for (const root of roots) act(() => root.unmount());
    roots = [];
    document.body.innerHTML = "";
    vi.clearAllMocks();
  });

  function render(props: AdapterConfigFieldsProps) {
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);
    roots.push(root);
    act(() =>
      root.render(
        <TooltipProvider>
          <ProcessConfigFields {...props} />
        </TooltipProvider>,
      ),
    );
    return container;
  }

  // Regression for PAP-15116: the shared Runtime section already renders a
  // Command field for every local adapter, so the process adapter must not add
  // its own — otherwise Command appears twice in the Runtime tab.
  it("does not render its own Command field (edit mode)", () => {
    const container = render(baseProps({ config: { command: "node", args: ["script.js"] } }));
    expect(labels(container)).toContain("Args (comma-separated)");
    expect(labels(container)).not.toContain("Command");
  });

  it("does not render its own Command field (create mode)", () => {
    const container = render(
      baseProps({
        isCreate: true,
        values: { adapterType: "process", command: "node", args: "script.js" } as AdapterConfigFieldsProps["values"],
        set: vi.fn(),
        config: {},
      }),
    );
    expect(labels(container)).toContain("Args (comma-separated)");
    expect(labels(container)).not.toContain("Command");
  });
});
