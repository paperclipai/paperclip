// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useWindowAutoFollow } from "./useWindowAutoFollow";
import { TaskChatScrollNavigation } from "./scroll-navigation";

function Host({ contentKey, enabled }: { contentKey: unknown; enabled: boolean }) {
  useWindowAutoFollow(contentKey, enabled);
  return <div>thread</div>;
}

/**
 * jsdom has no layout: document scroll geometry is faked on the scrolling
 * element, window.scrollTo is stubbed to record calls and update scrollY.
 */
describe("useWindowAutoFollow", () => {
  let container: HTMLDivElement;
  let root: Root;
  let scrollToCalls: number[];

  function fakeWindowGeometry({ scrollHeight = 2000, innerHeight = 800 } = {}) {
    const el = document.scrollingElement ?? document.documentElement;
    let currentScrollHeight = scrollHeight;
    Object.defineProperty(el, "scrollHeight", {
      get: () => currentScrollHeight,
      configurable: true,
    });
    Object.defineProperty(window, "innerHeight", { value: innerHeight, configurable: true });
    return {
      setScrollHeight(value: number) {
        currentScrollHeight = value;
      },
    };
  }

  function setWindowScrollY(y: number) {
    Object.defineProperty(window, "scrollY", { value: y, configurable: true });
  }

  function render(contentKey: unknown, enabled = true) {
    flushSync(() => {
      root.render(<Host contentKey={contentKey} enabled={enabled} />);
    });
  }

  /** Fire a window scroll event and flush the continuous-priority update. */
  function scrollWindowTo(y: number) {
    setWindowScrollY(y);
    window.dispatchEvent(new Event("scroll"));
    return new Promise<void>((resolve) => {
      setTimeout(resolve);
    });
  }

  /** Wait out the mount effect's rAF re-follow so it can't leak into asserts. */
  function flushRaf() {
    return new Promise<void>((resolve) => {
      requestAnimationFrame(() => setTimeout(resolve));
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    scrollToCalls = [];
    fakeWindowGeometry();
    setWindowScrollY(0);
    vi.stubGlobal("scrollTo", (options?: ScrollToOptions | number) => {
      const top = typeof options === "number" ? options : (options?.top ?? 0);
      scrollToCalls.push(top);
      // Mirror the browser: a follow to the bottom leaves the window pinned.
      setWindowScrollY(Math.max(0, top - window.innerHeight));
    });
  });

  afterEach(() => {
    flushSync(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("reapplies same-task targets and POP positions on mobile without remounting", async () => {
    vi.stubGlobal("scrollTo", (options: ScrollToOptions) => setWindowScrollY(Math.min(1200, options.top ?? 0)));
    function MobileThread() {
      useWindowAutoFollow("unchanged", true);
      return <div data-testid="task-chat-thread">{[100, 500].map((top, index) => (
        <div key={index} id={`mobile-comment-${index}`} data-thread-anchor={`mobile-comment-${index}`} ref={(node) => {
          if (node) node.getBoundingClientRect = () => ({ top: top - window.scrollY, bottom: top + 100 - window.scrollY, height: 100 } as DOMRect);
        }}>Comment {index}</div>
      ))}</div>;
    }
    const navigate = (key: string, hash: string, restore = false) => flushSync(() => root.render(
      <TaskChatScrollNavigation.Provider value={{ key, hash, restore }}><MobileThread /></TaskChatScrollNavigation.Provider>,
    ));
    navigate("mobile-entry-one", "#mobile-comment-0");
    const thread = container.firstElementChild;
    expect(window.scrollY).toBe(100);
    await scrollWindowTo(150);
    navigate("mobile-entry-two", "#mobile-comment-1");
    expect(container.firstElementChild).toBe(thread);
    expect(window.scrollY).toBe(500);
    navigate("mobile-entry-one", "#mobile-comment-0", true);
    expect(window.scrollY).toBe(150);
    navigate("mobile-entry-one", "#mobile-comment-1", true);
    expect(window.scrollY).toBe(500);
  });

  it("owns browser restoration only while the mobile thread is enabled", () => {
    window.history.scrollRestoration = "auto";
    render(0);
    expect(window.history.scrollRestoration).toBe("manual");
    render(0, false);
    expect(window.history.scrollRestoration).toBe("auto");
  });

  it("scrolls the window to the bottom on mount", () => {
    render(0);
    expect(scrollToCalls).toContain(2000);
  });

  it("follows content growth while pinned to the bottom", async () => {
    render(0);
    await flushRaf();
    await scrollWindowTo(1200); // pinned: 2000 - 1200 - 800 = 0
    scrollToCalls = [];
    render(1);
    expect(scrollToCalls).toContain(2000);
  });

  it("holds position when the user has scrolled up", async () => {
    render(0);
    await flushRaf();
    await scrollWindowTo(100); // far from the bottom
    scrollToCalls = [];
    render(1);
    expect(scrollToCalls).toHaveLength(0);
  });

  it("follows document growth while pinned on mobile", async () => {
    let triggerResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          triggerResize = () =>
            callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );
    const geometry = fakeWindowGeometry();
    render(0);
    await flushRaf();
    await scrollWindowTo(1200);
    scrollToCalls = [];

    geometry.setScrollHeight(2300);
    triggerResize();

    expect(scrollToCalls).toContain(2300);
  });

  it("holds document position through mobile composer growth when scrolled up", async () => {
    let triggerResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          triggerResize = () =>
            callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );
    const geometry = fakeWindowGeometry();
    render(0);
    await flushRaf();
    await scrollWindowTo(100);
    scrollToCalls = [];

    geometry.setScrollHeight(2300);
    triggerResize();

    expect(scrollToCalls).toHaveLength(0);
  });

  /**
   * REK-311 punt 5, en de testvraag die daar openstond: houdt de ankertak de
   * EERSTE transcriptbatch vast? Het antwoord is ja zodra de lezer heeft
   * gescrold — `pinnedRef` staat dan op false en er ligt een anker — en nee
   * zolang die nog `true` is, want dan is "volgen" correct.
   *
   * Dit is de ontbrekende helft van de twee bestaande tests hierboven: die
   * veranderen alleen de totale scrollHeight, dus ze kunnen een batch boven de
   * lezer niet van een batch eronder onderscheiden, en zonder
   * `data-thread-anchor`-rijen is het anker null en is vasthouden triviaal.
   */
  it("holds the first transcript batch that lands above a scrolled-up mobile reader", async () => {
    let triggerResize = () => {};
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          triggerResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );
    const geometry = fakeWindowGeometry();
    const state = { shift: 0 };
    function MobileThread({ contentKey, ids }: { contentKey: unknown; ids: string[] }) {
      useWindowAutoFollow(contentKey, true);
      return (
        <div data-testid="task-chat-thread">
          {ids.map((id, index) => (
            <div
              key={id}
              data-thread-anchor={id}
              ref={(node) => {
                if (!node) return;
                const docTop = 100 + index * 400 + state.shift;
                node.getBoundingClientRect = () => {
                  const top = docTop - window.scrollY;
                  return { top, bottom: top + 200, height: 200 } as DOMRect;
                };
              }}
            />
          ))}
        </div>
      );
    }
    function rowTop(id: string): number {
      return container
        .querySelector(`[data-thread-anchor="${id}"]`)!
        .getBoundingClientRect().top;
    }

    // A browser-like scrollTo: record the requested top verbatim. The suite's
    // default stub mirrors only the "follow to bottom" case, which would read
    // an anchor compensation of `scrollY + delta` as a jump to the bottom.
    vi.stubGlobal("scrollTo", (options?: ScrollToOptions | number) => {
      const top = typeof options === "number" ? options : (options?.top ?? 0);
      scrollToCalls.push(top);
      setWindowScrollY(Math.max(0, top));
    });
    flushSync(() => root.render(<MobileThread contentKey={1} ids={["a", "b", "c"]} />));
    await flushRaf();
    await scrollWindowTo(200); // 2000 - 200 - 800 = 1000, far from pinned
    const before = rowTop("a");
    expect(before).toBe(-100); // docTop 100 - scrollY 200

    // The first batch arrives and lands ABOVE the reader: the document grows
    // and the anchored row moves down by 100 + one 400px row.
    state.shift = 100;
    geometry.setScrollHeight(2500);
    flushSync(() => root.render(<MobileThread contentKey={2} ids={["new", "a", "b", "c"]} />));
    triggerResize();

    // 100px of moved content + the 400px row inserted above = 500px. The
    // invariant is that `a` did not move; with the hold broken the window
    // would still be at 200 and `a` would sit at 500.
    expect(window.scrollY).toBe(700);
    expect(rowTop("a")).toBe(before);
  });

  it("does nothing when disabled", () => {
    render(0, false);
    expect(scrollToCalls).toHaveLength(0);
    render(1, false);
    expect(scrollToCalls).toHaveLength(0);
  });
});
