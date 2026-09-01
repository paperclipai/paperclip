// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileText } from "lucide-react";
import { SidePanelLauncher } from "./SidePanelLauncher";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

describe("SidePanelLauncher", () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it("renders grouped loading, failure, disabled, and already-open states", async () => {
    await act(async () => root.render(
      <SidePanelLauncher
        sections={[
          { id: "open", label: "Open", items: [{ id: "plan", label: "Plan", icon: <FileText />, alreadyOpen: true }] },
          { id: "loading", label: "Recent", items: [], loading: true },
          { id: "failed", label: "Remote", items: [], error: "Recent files unavailable." },
          { id: "disabled", items: [{ id: "files", label: "Files", disabled: true, disabledReason: "No workspace." }] },
        ]}
        onSelect={() => {}}
      />,
    ));
    expect(container.textContent).toContain("Loading…");
    expect(container.textContent).toContain("Recent files unavailable.");
    expect(container.textContent).toContain("No workspace.");
    expect(container.querySelector('[aria-label="Already open"]')).not.toBeNull();
    expect(container.querySelector('[aria-disabled="true"]')).not.toBeNull();
  });

  it("selects enabled caller-provided items", async () => {
    const onSelect = vi.fn();
    await act(async () => root.render(
      <SidePanelLauncher
        sections={[{ id: "docs", items: [{ id: "plan", label: "Plan" }] }]}
        onSelect={onSelect}
      />,
    ));
    const option = container.querySelector<HTMLElement>('[role="option"]')!;
    await act(async () => option.click());
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "plan" }));
  });
});
