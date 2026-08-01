// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TaskMessageScroller } from "./TaskMessageScroller";

const PILL_SELECTOR = 'button[aria-label="Scroll to latest"]';

/**
 * jsdom has no layout, so scroll geometry is faked per element: scrollHeight /
 * clientHeight are pinned and scrollTop is backed by a plain variable.
 */
function fakeGeometry(el: HTMLElement, { scrollHeight = 1000, clientHeight = 400 } = {}) {
  let scrollTop = 0;
  Object.defineProperty(el, "scrollHeight", { value: scrollHeight, configurable: true });
  Object.defineProperty(el, "clientHeight", { value: clientHeight, configurable: true });
  Object.defineProperty(el, "scrollTop", {
    get: () => scrollTop,
    set: (v: number) => {
      scrollTop = v;
    },
    configurable: true,
  });
}

/**
 * Scroll/wheel are continuous-priority events, so React flushes the resulting
 * state updates asynchronously — wait a macrotask after dispatching.
 */
function flushEvents() {
  return new Promise<void>((resolve) => {
    setTimeout(resolve);
  });
}

describe("TaskMessageScroller", () => {
  let container: HTMLDivElement;
  let root: Root;

  function render(contentKey: unknown = 0) {
    flushSync(() => {
      root.render(
        <TaskMessageScroller contentKey={contentKey}>
          <div>messages</div>
        </TaskMessageScroller>,
      );
    });
  }

  function scroller(): HTMLDivElement {
    return container.querySelector<HTMLDivElement>('[data-testid="task-chat-scroller"]')!;
  }

  function pill(): HTMLButtonElement | null {
    return container.querySelector<HTMLButtonElement>(PILL_SELECTOR);
  }

  /** Set scrollTop and fire a scroll event, like a user or the browser would. */
  async function scrollTo(el: HTMLElement, top: number) {
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll", { bubbles: true }));
    await flushEvents();
  }

  async function dispatch(el: HTMLElement, event: Event) {
    el.dispatchEvent(event);
    await flushEvents();
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("renders children inside the scroll container, pill hidden, scrolled to bottom on mount", () => {
    render();
    const el = scroller();
    expect(el.textContent).toContain("messages");
    expect(pill()).toBeNull();
    // Mount effect pins to the bottom.
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  it("auto-follows content instantly while pinned", async () => {
    render(1);
    const el = scroller();
    fakeGeometry(el);
    await scrollTo(el, 600); // bottom: 1000 - 600 - 400 = 0 → pinned
    render(2);
    expect(el.scrollTop).toBe(1000);
    expect(pill()).toBeNull();
  });

  it("holds position and shows the icon-only pill when scrolled up", async () => {
    render(1);
    const el = scroller();
    fakeGeometry(el);
    await scrollTo(el, 100); // 500px from bottom → unpinned
    const btn = pill();
    expect(btn).not.toBeNull();
    expect(btn!.className).toContain("tc-scroll-pill-in");
    expect(btn!.className).toContain("size-8");
    expect(btn!.className).not.toContain("-translate-x-1/2");
    // Icon-only: no visible text.
    expect(btn!.textContent).toBe("");
    // New content must not yank the held position.
    render(2);
    expect(el.scrollTop).toBe(100);
  });

  it("small drifts within the pin threshold do not show the pill", async () => {
    render();
    const el = scroller();
    fakeGeometry(el);
    await scrollTo(el, 560); // 40px from bottom, threshold is 48
    expect(pill()).toBeNull();
  });

  it("clicking the pill smooth-scrolls, ignores intermediate scroll events, re-pins on arrival", async () => {
    render(1);
    const el = scroller();
    fakeGeometry(el);
    const scrollToSpy = vi.fn();
    el.scrollTo = scrollToSpy as unknown as typeof el.scrollTo;

    await scrollTo(el, 100);
    const btn = pill()!;
    btn.click();
    await flushEvents();
    expect(scrollToSpy).toHaveBeenCalledWith({ top: 1000, behavior: "smooth" });

    // Intermediate glide positions fire scroll events; they must not unpin
    // (i.e. the easing flag swallows them and the pill state stays put).
    await scrollTo(el, 250);
    await scrollTo(el, 400);
    expect(pill()).not.toBeNull();

    // Arrival within the threshold re-pins and hides the pill (immediately
    // here: no matchMedia in jsdom → reduced-motion/unmount-now path).
    await scrollTo(el, 600);
    expect(pill()).toBeNull();

    // Re-pinned: content growth follows instantly again.
    render(2);
    expect(el.scrollTop).toBe(1000);
  });

  it("a wheel gesture during the glide cancels easing and stays unpinned", async () => {
    render(1);
    const el = scroller();
    fakeGeometry(el);
    el.scrollTo = vi.fn() as unknown as typeof el.scrollTo;

    await scrollTo(el, 100);
    pill()!.click();
    await flushEvents();
    await dispatch(el, new Event("wheel", { bubbles: true }));

    // Easing cancelled → user is unpinned, pill visible, content holds.
    expect(pill()).not.toBeNull();
    render(2);
    expect(el.scrollTop).toBe(100);

    // Scroll events far from the bottom now behave normally (still unpinned).
    await scrollTo(el, 200);
    expect(pill()).not.toBeNull();
  });

  it("plays the exit animation before unmounting when motion is enabled", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: false }), // motion allowed
    );
    render();
    const el = scroller();
    fakeGeometry(el);
    await scrollTo(el, 100);
    expect(pill()!.className).toContain("tc-scroll-pill-in");

    // Scrolling back to the bottom starts the exit animation but keeps the
    // pill mounted until animationend.
    await scrollTo(el, 600);
    const exiting = pill();
    expect(exiting).not.toBeNull();
    expect(exiting!.className).toContain("tc-scroll-pill-out");

    // jsdom has no window.AnimationEvent, so React's vendor-prefix detection
    // maps onAnimationEnd to "webkitAnimationEnd" here (real browsers get the
    // unprefixed event).
    await dispatch(exiting!, new Event("webkitAnimationEnd", { bubbles: true }));
    expect(pill()).toBeNull();
  });

  it("unmounts immediately on hide under prefers-reduced-motion", async () => {
    vi.stubGlobal(
      "matchMedia",
      vi.fn().mockReturnValue({ matches: true }), // reduce
    );
    render();
    const el = scroller();
    fakeGeometry(el);
    await scrollTo(el, 100);
    expect(pill()).not.toBeNull();
    await scrollTo(el, 600);
    expect(pill()).toBeNull(); // no animationend needed
  });
});
