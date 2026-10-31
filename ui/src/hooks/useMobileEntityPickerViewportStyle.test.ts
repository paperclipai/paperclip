// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import {
  readVisualViewportGeometry,
  useMobileEntityPickerViewportStyle,
  type MobileEntityPickerViewportStyle,
} from "./useMobileEntityPickerViewportStyle";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

type ViewportStub = EventTarget & { height: number; offsetTop: number };

function stubVisualViewport(value: { height: number; offsetTop: number } | null): ViewportStub | null {
  if (value === null) {
    Object.defineProperty(window, "visualViewport", { configurable: true, value: null });
    return null;
  }
  const viewport = new EventTarget() as ViewportStub;
  viewport.height = value.height;
  viewport.offsetTop = value.offsetTop;
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  return viewport;
}

const cleanups = new Set<() => void>();

afterEach(() => {
  for (const cleanup of cleanups) cleanup();
  Reflect.deleteProperty(window, "visualViewport");
});

function renderViewportStyle() {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const result: { current: MobileEntityPickerViewportStyle } = { current: {} };
  function Harness() {
    result.current = useMobileEntityPickerViewportStyle();
    return null;
  }
  const unmount = () => {
    act(() => root.unmount());
    host.remove();
    cleanups.delete(unmount);
  };
  cleanups.add(unmount);
  act(() => root.render(createElement(Harness)));
  return { result, unmount };
}

describe("readVisualViewportGeometry", () => {
  it("returns the live height and keyboard pan offset", () => {
    stubVisualViewport({ height: 408, offsetTop: 120 });
    expect(readVisualViewportGeometry()).toEqual({ height: 408, offsetTop: 120 });
  });

  it("rejects the transient zero-height readings Safari emits mid-animation", () => {
    stubVisualViewport({ height: 0, offsetTop: 0 });
    expect(readVisualViewportGeometry()).toBeNull();
  });

  it("rejects an invalid pan offset rather than parking the sheet off-screen", () => {
    stubVisualViewport({ height: 408, offsetTop: Number.NaN });
    expect(readVisualViewportGeometry()).toBeNull();
    stubVisualViewport({ height: 408, offsetTop: -1 });
    expect(readVisualViewportGeometry()).toBeNull();
  });

  it("returns null when the browser has no visual viewport", () => {
    stubVisualViewport(null);
    expect(readVisualViewportGeometry()).toBeNull();
  });
});

describe("useMobileEntityPickerViewportStyle", () => {
  it("publishes a keyboard pan that leaves the height unchanged", () => {
    const viewport = stubVisualViewport({ height: 600, offsetTop: 0 });
    const { result } = renderViewportStyle();

    expect(result.current).toEqual({
      "--mobile-entity-picker-visual-viewport-height": "600px",
      "--mobile-entity-picker-visual-viewport-offset-top": "0px",
    });

    viewport!.offsetTop = 120;
    act(() => {
      viewport!.dispatchEvent(new Event("scroll"));
    });

    expect(result.current).toEqual({
      "--mobile-entity-picker-visual-viewport-height": "600px",
      "--mobile-entity-picker-visual-viewport-offset-top": "120px",
    });
  });

  it("keeps the previous geometry when Safari emits a transient invalid reading", () => {
    const viewport = stubVisualViewport({ height: 600, offsetTop: 40 });
    const { result } = renderViewportStyle();

    expect(result.current["--mobile-entity-picker-visual-viewport-offset-top"]).toBe("40px");

    viewport!.height = 0;
    act(() => {
      viewport!.dispatchEvent(new Event("resize"));
    });

    expect(result.current).toEqual({
      "--mobile-entity-picker-visual-viewport-height": "600px",
      "--mobile-entity-picker-visual-viewport-offset-top": "40px",
    });
  });
});
