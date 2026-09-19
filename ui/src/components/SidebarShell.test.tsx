// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SidebarShell, SIDEBAR_RAIL_WIDTH } from "./SidebarShell";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function pointerEvent(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("SidebarShell", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    window.localStorage.clear();
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
    window.localStorage.clear();
  });

  // The in-flow spacer that reserves layout width.
  function spacer() {
    return container.firstElementChild as HTMLDivElement;
  }

  // The absolutely-positioned overlay panel that holds the sidebar content.
  function panel() {
    return spacer().firstElementChild as HTMLDivElement;
  }

  function handle() {
    return container.querySelector('[role="separator"]') as HTMLDivElement | null;
  }

  it("uses a persisted width when expanded", () => {
    window.localStorage.setItem("test.sidebar.width", "320");

    act(() => {
      root.render(
        <SidebarShell open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    // Both the reserved spacer and the panel match the expanded width; no overlay.
    expect(spacer().style.width).toBe("320px");
    expect(panel().style.width).toBe("320px");
    expect(panel().getAttribute("data-sidebar-overlay")).toBeNull();
    expect(handle()?.getAttribute("aria-valuenow")).toBe("320");
  });

  // The bottom-left overlays — the announcement well and the toast viewport —
  // are fixed to the viewport, so without this width they land on the sidebar
  // footer, on top of the account menu and the Share feedback button.
  function reservedWidthVariable() {
    return document.documentElement.style.getPropertyValue("--sidebar-reserved-width");
  }

  it("publishes the width the bottom-left overlays have to clear", () => {
    window.localStorage.setItem("test.sidebar.width", "320");

    act(() => {
      root.render(
        <SidebarShell open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    expect(reservedWidthVariable()).toBe("320px");

    const separator = handle()!;
    separator.setPointerCapture = vi.fn();
    act(() => {
      separator.dispatchEvent(pointerEvent("pointerdown", 320));
      separator.dispatchEvent(pointerEvent("pointermove", 260));
      separator.dispatchEvent(pointerEvent("pointerup", 260));
    });

    // It tracks a drag, so the overlays do not hang over a narrowed sidebar.
    expect(reservedWidthVariable()).toBe("260px");
  });

  it("publishes only the rail width when collapsed, and none when closed", () => {
    act(() => {
      root.render(
        <SidebarShell open collapsed storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });
    expect(reservedWidthVariable()).toBe(`${SIDEBAR_RAIL_WIDTH}px`);

    act(() => {
      root.render(
        <SidebarShell open={false} storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });
    // Nothing reserved means the overlays return to the viewport edge.
    expect(reservedWidthVariable()).toBe("0px");
  });

  it("reserves nothing to clear while the panel is only peeking", () => {
    act(() => {
      root.render(
        <SidebarShell open collapsed peeking storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    // A peeking panel overlays content on purpose and is transient, so the
    // overlays must not jump sideways as the pointer crosses the rail.
    expect(reservedWidthVariable()).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
  });

  it("resizes by dragging and persists the new width", () => {
    act(() => {
      root.render(
        <SidebarShell open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    const separator = handle();
    expect(separator).not.toBeNull();
    separator!.setPointerCapture = vi.fn();

    act(() => {
      separator!.dispatchEvent(pointerEvent("pointerdown", 240));
      separator!.dispatchEvent(pointerEvent("pointermove", 320));
      separator!.dispatchEvent(pointerEvent("pointerup", 320));
    });

    expect(panel().style.width).toBe("320px");
    expect(window.localStorage.getItem("test.sidebar.width")).toBe("320");
  });

  it("matches the properties panel resize-grip hover treatment", () => {
    act(() => {
      root.render(
        <SidebarShell open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    const separator = handle();
    const indicator = separator?.firstElementChild as HTMLDivElement | null;

    expect(separator?.parentElement).toBe(spacer());
    expect(separator?.className).toContain("group");
    expect(separator?.style.right).toBe("-4px");
    expect(separator?.style.width).toBe("8px");
    expect(indicator?.className).toContain("w-0.5");
    expect(indicator?.className).toContain("group-hover:bg-ring");
    expect(indicator?.className).toContain("group-focus-visible:bg-ring");
  });

  it("supports keyboard resizing and clamps to the configured bounds", () => {
    act(() => {
      root.render(
        <SidebarShell open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    const separator = handle();
    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(panel().style.width).toBe("256px");
    expect(window.localStorage.getItem("test.sidebar.width")).toBe("256");

    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(panel().style.width).toBe("208px");

    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(panel().style.width).toBe("420px");
  });

  it("can render without a resize handle", () => {
    act(() => {
      root.render(
        <SidebarShell open resizable={false}>
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    expect(handle()).toBeNull();
    expect(panel().style.width).toBe("240px");
  });

  it("reserves only the rail width when collapsed and hides the resize handle", () => {
    window.localStorage.setItem("test.sidebar.width", "320");

    act(() => {
      root.render(
        <SidebarShell open collapsed resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    // Reserved spacer and panel both collapse to the rail; content never reflows
    // beyond the rail, and the rail is not user-resizable.
    expect(spacer().style.width).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    expect(panel().style.width).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    expect(panel().getAttribute("data-sidebar-overlay")).toBeNull();
    expect(handle()).toBeNull();
  });

  it("hides all sidebar width when closed, even if pinned collapsed", () => {
    window.localStorage.setItem("test.sidebar.width", "320");

    act(() => {
      root.render(
        <SidebarShell open={false} collapsed resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    expect(spacer().style.width).toBe("0px");
    expect(panel().style.width).toBe("0px");
    expect(panel().getAttribute("data-sidebar-overlay")).toBeNull();
    expect(handle()).toBeNull();
  });

  it("overlays content while peeking without expanding the reserved spacer", () => {
    window.localStorage.setItem("test.sidebar.width", "300");

    act(() => {
      root.render(
        <SidebarShell open collapsed peeking storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    // The reserved spacer stays at the rail (no page reflow) while the panel
    // grows to the expanded width and gets overlay styling.
    expect(spacer().style.width).toBe(`${SIDEBAR_RAIL_WIDTH}px`);
    expect(panel().style.width).toBe("300px");
    expect(panel().getAttribute("data-sidebar-overlay")).toBe("");
    expect(panel().className).toContain("shadow-lg");
    expect(panel().className).toContain("z-30");
  });

  it("opens and closes instantly with no width transition (PAP-10676)", () => {
    act(() => {
      root.render(
        <SidebarShell open>
          <div>Sidebar</div>
        </SidebarShell>,
      );
    });

    // Open/close must be instant: the panel never animates its width, so neither
    // the transition nor its reduced-motion fallback should be present.
    expect(panel().className).not.toContain("transition-(--tp-width)");
    expect(panel().className).not.toContain("motion-reduce:transition-none");
  });
});
