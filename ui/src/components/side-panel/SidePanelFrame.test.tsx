// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import { SidePanelFrame, SidePanelToggleButton, SidePanelWindowControls } from "./SidePanelFrame";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("side-panel shell controls", () => {
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
    document.documentElement.style.removeProperty("--motion-scrollbar-idle-delay");
    vi.useRealTimers();
  });

  it("exposes controlled presentation, visibility, maximize, and content layout state", async () => {
    await act(async () => root.render(
      <SidePanelFrame presentation="sheet" open={false} maximized resizing contentMode="full-bleed">
        Body
      </SidePanelFrame>,
    ));
    const frame = container.querySelector("section")!;
    expect(frame.getAttribute("data-presentation")).toBe("sheet");
    expect(frame.getAttribute("data-maximized")).toBe("true");
    expect(frame.getAttribute("data-resizing")).toBe("true");
    expect(frame.getAttribute("aria-hidden")).toBe("true");
    expect(frame.className).toContain("bg-(--side-panel-bg)");
    expect(frame.className).toContain("text-(--side-panel-fg)");
    expect(frame.firstElementChild?.className).toContain("overflow-hidden");
  });

  it("reports toggle, maximize, restore, and panel-toggle actions", async () => {
    const onToggle = vi.fn();
    const onMaximizedChange = vi.fn();
    const onWindowToggle = vi.fn();
    await act(async () => root.render(
      <TooltipProvider>
        <SidePanelToggleButton open={false} onToggle={onToggle} shortcut="]" />
        <SidePanelWindowControls maximized={false} onMaximizedChange={onMaximizedChange} onToggle={onWindowToggle} />
      </TooltipProvider>,
    ));
    const toggleButtons = container.querySelectorAll<HTMLButtonElement>('[aria-label="Toggle side panel"]');
    expect(toggleButtons).toHaveLength(2);
    expect(toggleButtons[0]?.getAttribute("aria-pressed")).toBe("false");
    expect(toggleButtons[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(toggleButtons[0]?.className).toContain("h-(--side-panel-tab-height)");
    await act(async () => toggleButtons[0]?.click());
    const maximizeButton = container.querySelector<HTMLButtonElement>('[aria-label="Maximize side panel"]');
    expect(maximizeButton?.className).toContain("text-muted-foreground");
    expect(maximizeButton?.className).toContain("h-(--side-panel-tab-height)");
    await act(async () => maximizeButton?.click());
    await act(async () => toggleButtons[1]?.click());
    expect(onToggle).toHaveBeenCalledOnce();
    expect(onMaximizedChange).toHaveBeenCalledWith(true);
    expect(onWindowToggle).toHaveBeenCalledOnce();
  });

  it("offers an explicit X close control for the task-detail sidebar", async () => {
    const onToggle = vi.fn();
    await act(async () => root.render(
      <TooltipProvider>
        <SidePanelWindowControls
          maximized={false}
          onMaximizedChange={vi.fn()}
          onToggle={onToggle}
          closeControl="close"
        />
      </TooltipProvider>,
    ));

    const closeButton = container.querySelector<HTMLButtonElement>('[aria-label="Close side panel"]');
    expect(closeButton).not.toBeNull();
    expect(closeButton?.querySelector(".lucide-x")).not.toBeNull();
    expect(container.querySelector('[aria-label="Toggle side panel"]')).toBeNull();
    await act(async () => closeButton?.click());
    expect(onToggle).toHaveBeenCalledOnce();
  });

  it("keeps the task-detail frame borderless except for its docked left edge", async () => {
    await act(async () => root.render(
      <SidePanelFrame header={<div>Tabs</div>} footer={<div>Actions</div>} headerSize="task-detail">
        Body
      </SidePanelFrame>,
    ));
    const frame = container.querySelector("section")!;
    const header = container.querySelector("header")!;
    const footer = container.querySelector("footer")!;
    expect(frame.className).toContain("border-l");
    expect(header.className).toContain("h-(--side-panel-header-height)");
    expect(header.className).not.toContain("h-(--sz-60px)");
    expect(header.className).not.toContain("border-b");
    expect(footer.className).not.toContain("border-t");
  });

  it("preserves the shared default header and footer treatment", async () => {
    await act(async () => root.render(
      <SidePanelFrame header={<div>Tabs</div>} footer={<div>Actions</div>}>
        Body
      </SidePanelFrame>,
    ));
    expect(container.querySelector("header")?.className).toContain("h-(--side-panel-header-height)");
    expect(container.querySelector("footer")?.className).toContain("border-t");
  });

  it("keeps the prose scrollbar on the full-width viewport while centering its content", async () => {
    await act(async () => root.render(
      <SidePanelFrame contentMode="prose">Document body</SidePanelFrame>,
    ));
    const viewport = container.querySelector<HTMLElement>('[data-side-panel-content-viewport="true"]')!;
    const prose = container.querySelector<HTMLElement>('[data-side-panel-prose-content="true"]')!;
    expect(viewport.className).toContain("overflow-auto");
    expect(viewport.className).not.toContain("max-w-4xl");
    expect(viewport.className).not.toContain("mx-auto");
    expect(prose.className).toContain("mx-auto");
    expect(prose.className).toContain("max-w-4xl");
  });

  it("shows the prose scrollbar only while scroll activity is recent", async () => {
    vi.useFakeTimers();
    document.documentElement.style.setProperty("--motion-scrollbar-idle-delay", "600ms");
    await act(async () => root.render(
      <SidePanelFrame contentMode="prose">Document body</SidePanelFrame>,
    ));
    const viewport = container.querySelector<HTMLElement>('[data-side-panel-content-viewport="true"]')!;
    expect(viewport.className).toContain("scrollbar-while-scrolling");
    expect(viewport.getAttribute("data-scroll-active")).toBeNull();

    act(() => viewport.dispatchEvent(new Event("scroll", { bubbles: true })));
    expect(viewport.getAttribute("data-scroll-active")).toBe("true");
    act(() => vi.advanceTimersByTime(599));
    expect(viewport.getAttribute("data-scroll-active")).toBe("true");
    act(() => vi.advanceTimersByTime(1));
    expect(viewport.getAttribute("data-scroll-active")).toBeNull();
  });
});
