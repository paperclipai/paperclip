// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("react", () => ({
  useEffect: (fn: () => (() => void) | void) => {
    const cleanup = fn();
    if (cleanup) (globalThis as Record<string, unknown>).__cleanup = cleanup;
  },
}));

import { useDragSelectScroll } from "./useDragSelectScroll";

function createScrollableElement(): HTMLDivElement {
  const el = document.createElement("div");
  Object.defineProperty(el, "getBoundingClientRect", {
    value: () => ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400 }),
  });
  el.scrollTop = 100;
  document.body.appendChild(el);
  return el;
}

describe("useDragSelectScroll", () => {
  let el: HTMLDivElement;
  let rafCallbacks: FrameRequestCallback[];

  beforeEach(() => {
    el = createScrollableElement();
    rafCallbacks = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      rafCallbacks.push(cb);
      return rafCallbacks.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
  });

  afterEach(() => {
    const cleanup = (globalThis as Record<string, unknown>).__cleanup as (() => void) | undefined;
    cleanup?.();
    el.remove();
    vi.restoreAllMocks();
  });

  it("scrolls down when dragging near the bottom edge", () => {
    useDragSelectScroll({ current: el });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 390, bubbles: true }));

    expect(rafCallbacks.length).toBe(1);

    const before = el.scrollTop;
    rafCallbacks[0]!(0);
    expect(el.scrollTop).toBeGreaterThan(before);
  });

  it("scrolls up when dragging near the top edge", () => {
    useDragSelectScroll({ current: el });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 10, bubbles: true }));

    expect(rafCallbacks.length).toBe(1);

    const before = el.scrollTop;
    rafCallbacks[0]!(0);
    expect(el.scrollTop).toBeLessThan(before);
  });

  it("does not scroll when mouse is in the center", () => {
    useDragSelectScroll({ current: el });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 200, bubbles: true }));

    expect(rafCallbacks.length).toBe(1);

    const before = el.scrollTop;
    rafCallbacks[0]!(0);
    expect(el.scrollTop).toBe(before);
  });

  it("stops scrolling on mouseup", () => {
    useDragSelectScroll({ current: el });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 0, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 390, bubbles: true }));

    expect(rafCallbacks.length).toBe(0);
  });

  it("ignores right-click", () => {
    useDragSelectScroll({ current: el });

    el.dispatchEvent(new MouseEvent("mousedown", { button: 2, bubbles: true }));
    document.dispatchEvent(new MouseEvent("mousemove", { clientY: 390, bubbles: true }));

    expect(rafCallbacks.length).toBe(0);
  });
});
