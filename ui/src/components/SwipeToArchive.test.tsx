// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeToArchive } from "./SwipeToArchive";

// Tell React this environment uses act() for event flushing.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function dispatchTouchEvent(
  node: Element,
  type: "touchstart" | "touchmove" | "touchend",
  coords: { x: number; y: number },
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const touchPoint = { clientX: coords.x, clientY: coords.y };

  Object.defineProperty(event, "touches", {
    configurable: true,
    value: type === "touchend" ? [] : [touchPoint],
  });
  Object.defineProperty(event, "changedTouches", {
    configurable: true,
    value: [touchPoint],
  });

  node.dispatchEvent(event);
}

describe("SwipeToArchive", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    container.remove();
  });

  it("suppresses descendant clicks after a horizontal swipe and archives the row", () => {
    const onArchive = vi.fn();
    const onClick = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <SwipeToArchive onArchive={onArchive}>
          <button type="button" onClick={onClick}>
            Open issue
          </button>
        </SwipeToArchive>,
      );
    });

    const wrapper = container.firstElementChild as HTMLDivElement;
    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    Object.defineProperty(wrapper, "offsetWidth", { configurable: true, value: 200 });
    Object.defineProperty(wrapper, "offsetHeight", { configurable: true, value: 48 });

    act(() => {
      dispatchTouchEvent(wrapper, "touchstart", { x: 180, y: 20 });
    });
    act(() => {
      dispatchTouchEvent(wrapper, "touchmove", { x: 80, y: 22 });
    });
    act(() => {
      dispatchTouchEvent(wrapper, "touchend", { x: 80, y: 22 });
    });

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onClick).not.toHaveBeenCalled();

    act(() => {
      vi.advanceTimersByTime(140);
    });

    expect(onArchive).toHaveBeenCalledTimes(1);

    act(() => {
      root.unmount();
    });
  });

  it("does not suppress a normal tap click", () => {
    const onArchive = vi.fn();
    const onClick = vi.fn();
    const root = createRoot(container);

    act(() => {
      root.render(
        <SwipeToArchive onArchive={onArchive}>
          <button type="button" onClick={onClick}>
            Open issue
          </button>
        </SwipeToArchive>,
      );
    });

    const button = container.querySelector("button");
    expect(button).not.toBeNull();

    act(() => {
      button!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });

    expect(onClick).toHaveBeenCalledTimes(1);
    expect(onArchive).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it("renders the selected inbox treatment on the swipe surface", () => {
    const root = createRoot(container);

    act(() => {
      root.render(
        <SwipeToArchive onArchive={() => {}} selected>
          <button type="button">Open issue</button>
        </SwipeToArchive>,
      );
    });

    const surface = container.querySelector("[data-inbox-row-surface]") as HTMLDivElement | null;
    expect(surface).not.toBeNull();
    expect(surface?.className).toContain("bg-zinc-100");
    expect(surface?.className).toContain("dark:bg-zinc-800");
    expect(surface?.className).not.toContain("bg-card");
    expect(surface?.style.backgroundColor).toBe("");
    expect(surface?.style.boxShadow).toBe("");

    act(() => {
      root.unmount();
    });
  });
});
