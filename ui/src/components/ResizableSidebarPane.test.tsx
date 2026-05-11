// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ResizableSidebarPane } from "./ResizableSidebarPane";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function pointerEvent(type: string, clientX: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX });
  Object.defineProperty(event, "pointerId", { value: 1 });
  return event;
}

describe("ResizableSidebarPane", () => {
  let container: HTMLDivElement;
  let root: Root;
  let originalInnerWidth: number;

  beforeEach(() => {
    originalInnerWidth = window.innerWidth;
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
    document.documentElement.style.removeProperty("--test-sidebar-width");
    setInnerWidth(originalInnerWidth);
  });

  function pane() {
    return container.firstElementChild as HTMLDivElement;
  }

  function handle() {
    return container.querySelector('[role="separator"]') as HTMLDivElement | null;
  }

  function setInnerWidth(width: number) {
    Object.defineProperty(window, "innerWidth", {
      configurable: true,
      writable: true,
      value: width,
    });
  }

  it("uses a persisted width when open", () => {
    window.localStorage.setItem("test.sidebar.width", "320");

    act(() => {
      root.render(
        <ResizableSidebarPane open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </ResizableSidebarPane>,
      );
    });

    expect(pane().style.width).toBe("320px");
    expect(handle()?.getAttribute("aria-valuenow")).toBe("320");
  });

  it("resizes by dragging and persists the new width", () => {
    act(() => {
      root.render(
        <ResizableSidebarPane open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </ResizableSidebarPane>,
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

    expect(pane().style.width).toBe("320px");
    expect(window.localStorage.getItem("test.sidebar.width")).toBe("320");
  });

  it("supports keyboard resizing and clamps to the configured bounds", () => {
    act(() => {
      root.render(
        <ResizableSidebarPane open resizable storageKey="test.sidebar.width">
          <div>Sidebar</div>
        </ResizableSidebarPane>,
      );
    });

    const separator = handle();
    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    });
    expect(pane().style.width).toBe("256px");
    expect(window.localStorage.getItem("test.sidebar.width")).toBe("256");

    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    });
    expect(pane().style.width).toBe("208px");

    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "End", bubbles: true }));
    });
    expect(pane().style.width).toBe("420px");
  });

  it("can render without a resize handle", () => {
    act(() => {
      root.render(
        <ResizableSidebarPane open resizable={false}>
          <div>Sidebar</div>
        </ResizableSidebarPane>,
      );
    });

    expect(handle()).toBeNull();
    expect(pane().style.width).toBe("240px");
  });

  it("supports custom defaults and bounds", () => {
    act(() => {
      root.render(
        <ResizableSidebarPane
          open
          resizable
          storageKey="test.properties.width"
          defaultWidth={400}
          minWidth={320}
          maxWidth={640}
        >
          <div>Properties</div>
        </ResizableSidebarPane>,
      );
    });

    expect(pane().style.width).toBe("400px");
    expect(handle()?.getAttribute("aria-valuemin")).toBe("320");
    expect(handle()?.getAttribute("aria-valuemax")).toBe("640");
  });

  it("uses right-side drag and keyboard semantics", () => {
    act(() => {
      root.render(
        <ResizableSidebarPane
          open
          resizable
          side="right"
          storageKey="test.properties.width"
          defaultWidth={400}
          minWidth={320}
          maxWidth={640}
        >
          <div>Properties</div>
        </ResizableSidebarPane>,
      );
    });

    const separator = handle();
    expect(separator).not.toBeNull();
    separator!.setPointerCapture = vi.fn();

    act(() => {
      separator!.dispatchEvent(pointerEvent("pointerdown", 400));
      separator!.dispatchEvent(pointerEvent("pointermove", 360));
      separator!.dispatchEvent(pointerEvent("pointerup", 360));
    });

    expect(pane().style.width).toBe("440px");
    expect(window.localStorage.getItem("test.properties.width")).toBe("440");

    act(() => {
      separator?.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    });

    expect(pane().style.width).toBe("456px");
    expect(window.localStorage.getItem("test.properties.width")).toBe("456");
  });

  it("exposes the visible width as a CSS variable", () => {
    act(() => {
      root.render(
        <ResizableSidebarPane
          open
          resizable
          storageKey="test.properties.width"
          defaultWidth={400}
          minWidth={320}
          maxWidth={640}
          widthVariable="--test-sidebar-width"
        >
          <div>Properties</div>
        </ResizableSidebarPane>,
      );
    });

    expect(document.documentElement.style.getPropertyValue("--test-sidebar-width")).toBe("400px");

    act(() => {
      root.render(
        <ResizableSidebarPane
          open={false}
          resizable
          storageKey="test.properties.width"
          defaultWidth={400}
          minWidth={320}
          maxWidth={640}
          widthVariable="--test-sidebar-width"
        >
          <div>Properties</div>
        </ResizableSidebarPane>,
      );
    });

    expect(document.documentElement.style.getPropertyValue("--test-sidebar-width")).toBe("0px");
  });

  it("clamps to compact width below the configured viewport without overwriting the stored wide width", () => {
    window.localStorage.setItem("test.properties.width", "520");
    setInnerWidth(900);

    act(() => {
      root.render(
        <ResizableSidebarPane
          open
          resizable
          storageKey="test.properties.width"
          defaultWidth={400}
          minWidth={320}
          maxWidth={640}
          compactBelowViewport={1024}
          compactMaxWidth={320}
        >
          <div>Properties</div>
        </ResizableSidebarPane>,
      );
    });

    expect(pane().style.width).toBe("320px");
    expect(handle()).toBeNull();
    expect(window.localStorage.getItem("test.properties.width")).toBe("520");

    act(() => {
      setInnerWidth(1200);
      window.dispatchEvent(new Event("resize"));
    });

    expect(pane().style.width).toBe("520px");
    expect(handle()?.getAttribute("aria-valuemax")).toBe("640");
  });
});
