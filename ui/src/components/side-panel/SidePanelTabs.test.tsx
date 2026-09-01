// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FileText, SlidersHorizontal } from "lucide-react";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidePanelTabs } from "./SidePanelTabs";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

(globalThis as { ResizeObserver?: typeof ResizeObserver }).ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;

describe("SidePanelTabs", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    Element.prototype.scrollIntoView = vi.fn();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((callback) => {
      callback(0);
      return 1;
    });
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });

  function renderTabs(
    activeTabId = "properties",
    onCloseTab = vi.fn(),
    onActiveTabChange = vi.fn(),
    onReorderTabs = vi.fn(),
  ) {
    const tabs = [
      { id: "properties", type: "view", label: "Properties", icon: <SlidersHorizontal />, closable: true },
      { id: "document:plan", type: "document", label: "Plan", icon: <FileText />, closable: true },
    ];
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={tabs}
            activeTabId={activeTabId}
            onActiveTabChange={onActiveTabChange}
            onCloseTab={onCloseTab}
            onReorderTabs={onReorderTabs}
            onAddTab={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    return { tabs, onCloseTab, onActiveTabChange, onReorderTabs };
  }

  it("renders accessible tabs and the anchored add action", () => {
    renderTabs();
    expect(container.querySelector('[role="tablist"]')).not.toBeNull();
    const activeTab = container.querySelector<HTMLButtonElement>('[role="tab"][aria-selected="true"]');
    expect(activeTab?.textContent).toContain("Properties");
    expect(activeTab?.className).toContain("text-xs");
    expect(activeTab?.querySelector("span")?.className).toContain("size-3.5");
    expect(container.querySelector('button[aria-label="Close Properties"]')).not.toBeNull();
    expect(container.querySelector('button[aria-label="Close Plan"]')).toBeNull();
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]');
    expect(addButton?.className).toContain("text-muted-foreground");
    expect(addButton?.className).toContain("h-(--side-panel-tab-height)");
  });

  it("separates only adjacent inactive tabs", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={[
              { id: "active", type: "view", label: "Active", closable: true },
              { id: "inactive-one", type: "view", label: "Inactive one", closable: true },
              { id: "inactive-two", type: "view", label: "Inactive two", closable: true },
            ]}
            activeTabId="active"
            onActiveTabChange={vi.fn()}
            onCloseTab={vi.fn()}
          />
        </TooltipProvider>,
      );
    });
    const separators = container.querySelectorAll('[data-side-panel-tab-separator="true"]');
    expect(separators).toHaveLength(1);
    expect(separators[0]?.parentElement?.querySelector('[data-side-panel-tab-target="inactive-two"]')).not.toBeNull();
  });

  it("keeps intrinsic tab width stable while giving inactive labels the close-button space", () => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
      x: 0,
      y: 0,
      top: 0,
      right: 128,
      bottom: 30,
      left: 0,
      width: 128,
      height: 30,
      toJSON: () => ({}),
    });
    renderTabs("properties");
    const planWrapper = container.querySelector<HTMLElement>('[data-side-panel-tab-wrapper="document:plan"]')!;
    const planButton = container.querySelector<HTMLElement>('[data-side-panel-tab-target="document:plan"]')!;
    expect(planWrapper.style.width).toBe("128px");
    expect(planButton.className).toContain("pr-2.5");
    expect(planButton.querySelector('[data-truncated]')?.className ?? planButton.querySelector("span:nth-child(2)")?.className)
      .toContain("max-w-(--side-panel-tab-label-expanded-max-width)");

    renderTabs("document:plan");
    const selectedPlanWrapper = container.querySelector<HTMLElement>('[data-side-panel-tab-wrapper="document:plan"]')!;
    const selectedPlanButton = container.querySelector<HTMLElement>('[data-side-panel-tab-target="document:plan"]')!;
    expect(selectedPlanWrapper.style.width).toBe("128px");
    expect(selectedPlanButton.className).toContain("pr-7");
  });

  it("closes a tab with its named close action", () => {
    const onCloseTab = vi.fn();
    renderTabs("properties", onCloseTab);
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close Properties"]');
    act(() => close?.click());
    expect(onCloseTab).toHaveBeenCalledWith("properties");
  });

  it("supports middle-click close", () => {
    const onCloseTab = vi.fn();
    renderTabs("properties", onCloseTab);
    const tab = container.querySelector<HTMLButtonElement>('#side-panel-tab-document\\:plan');
    act(() => tab?.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, button: 1 })));
    expect(onCloseTab).toHaveBeenCalledWith("document:plan");
  });

  it("navigates with Arrow, Home, and End keys", () => {
    const onActiveTabChange = vi.fn();
    renderTabs("properties", vi.fn(), onActiveTabChange);
    const properties = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="properties"]')!;
    act(() => properties.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "ArrowRight" })));
    expect(onActiveTabChange).toHaveBeenCalledWith("document:plan");

    const plan = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="document:plan"]')!;
    act(() => plan.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Home" })));
    expect(onActiveTabChange).toHaveBeenLastCalledWith("properties");
  });

  it("announces and performs keyboard reordering", () => {
    const onReorderTabs = vi.fn();
    renderTabs("document:plan", vi.fn(), vi.fn(), onReorderTabs);
    const plan = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="document:plan"]')!;
    act(() => plan.dispatchEvent(new KeyboardEvent("keydown", {
      bubbles: true,
      key: "ArrowLeft",
      altKey: true,
      shiftKey: true,
    })));
    expect(onReorderTabs).toHaveBeenCalledWith(["document:plan", "properties"]);
    expect(container.querySelector('[aria-live="polite"]')?.textContent).toContain("Moved Plan to position 1 of 2");
  });

  it("recovers focus to the right neighbor after close", () => {
    renderTabs("properties");
    const close = container.querySelector<HTMLButtonElement>('button[aria-label="Close Properties"]')!;
    act(() => close.click());
    expect(document.activeElement).toBe(container.querySelector('[data-side-panel-tab-target="document:plan"]'));
  });
});
