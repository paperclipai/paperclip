// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ClaudeLocalAdvancedFields } from "./config-fields";
import type { AdapterConfigFieldsProps, AdapterFieldAgentOption } from "../types";
import { TooltipProvider } from "@/components/ui/tooltip";

(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const AGENTS: AdapterFieldAgentOption[] = [
  { id: "codex-1", name: "Codex One", adapterType: "codex_local", status: "active" },
  { id: "codex-2", name: "Codex Two", adapterType: "codex_local", status: "active" },
  // self-reference: codex but must be excluded as a candidate
  { id: "self-claude", name: "Self Agent", adapterType: "codex_local", status: "active" },
  // non-codex: must be excluded
  { id: "claude-x", name: "Claude X", adapterType: "claude_local", status: "active" },
  // terminated codex: must be excluded
  { id: "codex-dead", name: "Dead Codex", adapterType: "codex_local", status: "terminated" },
];

function editProps(
  overrides: Partial<AdapterConfigFieldsProps> = {},
): AdapterConfigFieldsProps {
  return {
    mode: "edit",
    isCreate: false,
    adapterType: "claude_local",
    values: null,
    set: null,
    config: {},
    eff: (<T,>(_group: "adapterConfig", _field: string, original: T) => original) as AdapterConfigFieldsProps["eff"],
    mark: vi.fn(),
    models: [],
    agents: AGENTS,
    selfAgentId: "self-claude",
    ...overrides,
  };
}

describe("ClaudeLocalAdvancedFields recovery fallback agent", () => {
  let container: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  function render(props: AdapterConfigFieldsProps) {
    act(() => {
      root.render(
        <TooltipProvider>
          <ClaudeLocalAdvancedFields {...props} />
        </TooltipProvider>,
      );
    });
  }

  function optionLabels(): string[] {
    return Array.from(container.querySelectorAll("option")).map(
      (o) => o.textContent ?? "",
    );
  }

  it("lists only same-company codex candidates, excluding self, non-codex and terminated", () => {
    render(editProps());
    const labels = optionLabels();
    expect(labels).toContain("Unset (default recovery owner)");
    expect(labels).toContain("Codex One");
    expect(labels).toContain("Codex Two");
    expect(labels).not.toContain("Self Agent");
    expect(labels).not.toContain("Claude X");
    expect(labels).not.toContain("Dead Codex");
  });

  it("commits the selected agent id via mark", () => {
    const mark = vi.fn();
    render(editProps({ mark }));
    const select = container.querySelector("select")!;
    act(() => {
      select.value = "codex-2";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "recoveryFallbackAgentId", "codex-2");
  });

  it("clearing the selection stores undefined (legacy behavior)", () => {
    const mark = vi.fn();
    render(editProps({ mark, config: { recoveryFallbackAgentId: "codex-1" } }));
    const select = container.querySelector("select")!;
    act(() => {
      select.value = "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(mark).toHaveBeenCalledWith("adapterConfig", "recoveryFallbackAgentId", undefined);
  });

  it("warns when a stored fallback points at the agent itself", () => {
    render(editProps({ config: { recoveryFallbackAgentId: "self-claude" } }));
    expect(container.textContent).toContain("cannot be its own recovery fallback");
  });

  it("warns when a stored fallback is non-codex", () => {
    render(editProps({ config: { recoveryFallbackAgentId: "claude-x" } }));
    expect(container.textContent).toContain("must be a codex agent");
  });
});
