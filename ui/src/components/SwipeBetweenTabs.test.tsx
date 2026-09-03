// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SwipeBetweenTabs } from "./SwipeBetweenTabs";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function touch(node: Element, type: "touchstart" | "touchend", x: number, y: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  Object.defineProperty(event, "touches", { value: type === "touchend" ? [] : [point] });
  Object.defineProperty(event, "changedTouches", { value: [point] });
  node.dispatchEvent(event);
}

describe("SwipeBetweenTabs", () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => container.remove());

  const render = (value: string, onValueChange = vi.fn(), filled = false) => {
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <SwipeBetweenTabs items={["mine", "recent", "unread"]} value={value} onValueChange={onValueChange}>
          {filled ? <div data-testid="card">Task card</div> : <div data-testid="empty">Inbox zero</div>}
        </SwipeBetweenTabs>,
      );
    });
    return { root, onValueChange };
  };

  it("changes an empty screen in both horizontal directions", () => {
    const onValueChange = vi.fn();
    const { root } = render("recent", onValueChange);
    const surface = container.querySelector("[data-swipe-between-tabs]")!;

    flushSync(() => {
      touch(surface, "touchstart", 240, 100);
      touch(surface, "touchend", 120, 104);
    });
    expect(onValueChange).toHaveBeenLastCalledWith("unread");

    flushSync(() => {
      touch(surface, "touchstart", 120, 100);
      touch(surface, "touchend", 240, 104);
    });
    expect(onValueChange).toHaveBeenLastCalledWith("mine");
    expect(onValueChange).toHaveBeenCalledTimes(2);
    flushSync(() => root.unmount());
  });

  it("changes a filled screen but leaves row swipe actions in control", () => {
    const onValueChange = vi.fn();
    const { root } = render("recent", onValueChange, true);
    const surface = container.querySelector("[data-swipe-between-tabs]")!;
    const card = container.querySelector("[data-testid='card']")!;

    flushSync(() => {
      touch(card, "touchstart", 240, 100);
      touch(card, "touchend", 120, 102);
    });
    expect(onValueChange).toHaveBeenCalledWith("unread");

    card.setAttribute("data-row-swipe-action", "");
    flushSync(() => {
      touch(card, "touchstart", 240, 100);
      touch(card, "touchend", 120, 102);
    });
    expect(onValueChange).toHaveBeenCalledTimes(1);
    expect(surface.className).toContain("touch-pan-y");
    flushSync(() => root.unmount());
  });

  it("ignores vertical gestures, controls, and the end of the tab list", () => {
    const onValueChange = vi.fn();
    const root = createRoot(container);
    flushSync(() => {
      root.render(
        <SwipeBetweenTabs items={["mine", "recent"]} value="recent" onValueChange={onValueChange}>
          <button type="button">Filter</button>
          <div data-testid="body">Body</div>
        </SwipeBetweenTabs>,
      );
    });
    const body = container.querySelector("[data-testid='body']")!;
    const button = container.querySelector("button")!;

    flushSync(() => {
      touch(body, "touchstart", 200, 80);
      touch(body, "touchend", 190, 180);
      touch(button, "touchstart", 220, 80);
      touch(button, "touchend", 100, 82);
      touch(body, "touchstart", 220, 80);
      touch(body, "touchend", 100, 82);
    });
    expect(onValueChange).not.toHaveBeenCalled();
    flushSync(() => root.unmount());
  });
});
