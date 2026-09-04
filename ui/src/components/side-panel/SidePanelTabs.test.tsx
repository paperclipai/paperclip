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

  it("restores the pre-rebase Streamlined UI tab treatment", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={[
              { id: "properties", type: "view", label: "Properties", icon: <SlidersHorizontal />, closable: true },
              { id: "document:plan", type: "document", label: "Implementation plan", icon: <FileText />, closable: true },
            ]}
            activeTabId="properties"
            onActiveTabChange={vi.fn()}
            onCloseTab={vi.fn()}
            onAddTab={vi.fn()}
            appearance="streamlined-task"
          />
        </TooltipProvider>,
      );
    });

    const tabs = container.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    expect(tabs).toHaveLength(2);
    expect(tabs[0]?.className).toContain("text-sm");
    expect(tabs[0]?.querySelector("svg")).toBeNull();
    expect(container.querySelectorAll('[data-side-panel-tab-separator="true"]')).toHaveLength(1);

    const propertiesWrapper = container.querySelector<HTMLElement>('[data-side-panel-tab-wrapper="properties"]');
    expect(propertiesWrapper?.className).toContain("mx-1.5");
    expect(propertiesWrapper?.className).toContain("h-7");
    expect(propertiesWrapper?.className).toContain("text-foreground");
    expect(propertiesWrapper?.className).toContain("hover:bg-accent/50");
    expect(propertiesWrapper?.className).not.toContain("bg-muted");
    expect(propertiesWrapper?.style.width).toBe("");
    expect(propertiesWrapper?.parentElement?.className)
      .toContain("min-w-(--side-panel-streamlined-tab-min-width)");
    expect(propertiesWrapper?.parentElement?.className)
      .toContain("max-w-(--side-panel-streamlined-tab-max-width)");

    const planLabel = container.querySelector<HTMLElement>('[data-side-panel-tab-target="document:plan"] span');
    expect(planLabel?.className).toContain("task-detail-pane-tab-label");
    expect(planLabel?.className).toContain("side-panel-tab-label-close-fade");
    expect(planLabel?.className).toContain("text-center");
    const tabList = container.querySelector<HTMLElement>('[role="tablist"]');
    expect(tabList?.className).toContain("overflow-x-auto");
    expect(tabList?.className).not.toContain("overflow-hidden");
    expect(tabList?.firstElementChild?.className).toContain("w-max");
    expect(tabList?.firstElementChild?.className).toContain("min-w-full");
    const planCloseButton = container.querySelector<HTMLButtonElement>('button[aria-label="Close Implementation plan"]');
    expect(planCloseButton?.className).toContain("opacity-0");
    expect(planCloseButton?.className).toContain("right-0");
    expect(planCloseButton?.className).toContain("side-panel-tab-close-motion");
    expect(planCloseButton?.className).not.toContain("side-panel-tab-motion");
    expect(planCloseButton?.className).not.toContain("group-focus-within/side-panel-tab:opacity-100");
    const addButton = container.querySelector<HTMLButtonElement>('button[aria-label="Open a new tab"]');
    expect(addButton?.className).toContain("h-(--side-panel-tab-height)");
    expect(addButton?.className).toContain("w-(--side-panel-tab-height)");
    expect(addButton?.className).toContain("hover:bg-accent");
  });

  it("lets a lone Streamlined tab fill the space before the add action", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={[
              {
                id: "properties",
                type: "view",
                label: "Properties",
                closable: true,
              },
            ]}
            activeTabId="properties"
            onActiveTabChange={vi.fn()}
            onCloseTab={vi.fn()}
            onAddTab={vi.fn()}
            appearance="streamlined-task"
          />
        </TooltipProvider>,
      );
    });

    const tabList = container.querySelector<HTMLElement>('[role="tablist"]');
    const tabTrack = tabList?.firstElementChild;
    const propertiesWrapper = container.querySelector<HTMLElement>(
      '[data-side-panel-tab-wrapper="properties"]',
    )?.parentElement;
    expect(tabTrack?.className).toContain("w-full");
    expect(tabTrack?.className).not.toContain("w-max");
    expect(propertiesWrapper?.className).toContain("max-w-none");
    expect(propertiesWrapper?.className).toContain("flex-1");
    expect(propertiesWrapper?.className).not.toContain(
      "max-w-(--side-panel-streamlined-tab-max-width)",
    );
  });

  it("enables the tab flyout only while its label is truncated", () => {
    const scrollWidth = vi.spyOn(HTMLElement.prototype, "scrollWidth", "get").mockReturnValue(72);
    const clientWidth = vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockReturnValue(96);

    const renderLabel = (label: string) => {
      act(() => {
        root.render(
          <TooltipProvider>
            <SidePanelTabs
              tabs={[{ id: "properties", type: "view", label, closable: true }]}
              activeTabId="properties"
              onActiveTabChange={vi.fn()}
              onCloseTab={vi.fn()}
              appearance="streamlined-task"
            />
          </TooltipProvider>,
        );
      });
    };

    renderLabel("Properties");
    const tab = container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="properties"]')!;
    const label = tab.querySelector<HTMLElement>(".task-detail-pane-tab-label")!;
    expect(tab.dataset.sidePanelTabTooltip).toBe("disabled");
    expect(label.dataset.truncated).toBeUndefined();

    scrollWidth.mockReturnValue(128);
    clientWidth.mockReturnValue(72);
    renderLabel("Properties panel");
    expect(tab.dataset.sidePanelTabTooltip).toBe("enabled");
    expect(label.dataset.truncated).toBe("true");
  });

  it("fades the right edge only while more Streamlined tabs remain", () => {
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={[
              { id: "properties", type: "view", label: "Properties", closable: true },
              { id: "subtasks", type: "view", label: "Subtasks", closable: true },
              { id: "artifacts", type: "view", label: "Artifacts", closable: true },
            ]}
            activeTabId="properties"
            onActiveTabChange={vi.fn()}
            onCloseTab={vi.fn()}
            onAddTab={vi.fn()}
            appearance="streamlined-task"
          />
        </TooltipProvider>,
      );
    });

    const tabList = container.querySelector<HTMLElement>('[role="tablist"]')!;
    Object.defineProperties(tabList, {
      clientWidth: { configurable: true, value: 152 },
      scrollWidth: { configurable: true, value: 384 },
      scrollLeft: { configurable: true, value: 0, writable: true },
    });
    act(() => tabList.dispatchEvent(new Event("scroll")));
    expect(tabList.dataset.scrollEndFade).toBe("true");

    tabList.scrollLeft = 232;
    act(() => tabList.dispatchEvent(new Event("scroll")));
    expect(tabList.dataset.scrollEndFade).toBeUndefined();
  });

  it("selects an inactive Streamlined UI tab without closing it", () => {
    const onActiveTabChange = vi.fn();
    const onCloseTab = vi.fn();
    act(() => {
      root.render(
        <TooltipProvider>
          <SidePanelTabs
            tabs={[
              { id: "properties", type: "view", label: "Properties", closable: true },
              { id: "subtasks", type: "view", label: "Subtasks", closable: true },
            ]}
            activeTabId="properties"
            onActiveTabChange={onActiveTabChange}
            onCloseTab={onCloseTab}
            appearance="streamlined-task"
          />
        </TooltipProvider>,
      );
    });

    act(() => container.querySelector<HTMLButtonElement>('[data-side-panel-tab-target="subtasks"]')?.click());
    expect(onActiveTabChange).toHaveBeenCalledWith("subtasks");
    expect(onCloseTab).not.toHaveBeenCalled();
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
