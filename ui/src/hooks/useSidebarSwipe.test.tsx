// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSidebarSwipe } from "./useSidebarSwipe";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function TestHarness({
  enabled = true,
  isOpen = false,
  onOpenChange,
}: {
  enabled?: boolean;
  isOpen?: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  useSidebarSwipe({ enabled, isOpen, onOpenChange });
  return <div>sidebar swipe test</div>;
}

type TouchType = "touchstart" | "touchmove" | "touchend" | "touchcancel";

function touch(type: TouchType, x: number, y: number) {
  const e = new Event(type, { bubbles: true, cancelable: true });
  const point = { clientX: x, clientY: y };
  const ended = type === "touchend" || type === "touchcancel";
  Object.assign(e, { touches: ended ? [] : [point], changedTouches: [point] });
  document.dispatchEvent(e);
}

describe("useSidebarSwipe", () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    container.remove();
  });

  function render(props: { enabled?: boolean; isOpen?: boolean; onOpenChange: (open: boolean) => void }) {
    act(() => {
      root.render(<TestHarness {...props} />);
    });
  }

  it("opens the sidebar on a deliberate horizontal swipe from the left edge", () => {
    const onOpenChange = vi.fn();
    render({ onOpenChange });

    touch("touchstart", 10, 300);
    touch("touchmove", 40, 302);
    touch("touchmove", 90, 305);
    touch("touchend", 90, 305);

    expect(onOpenChange).toHaveBeenCalledWith(true);
  });

  it("ignores a diagonal scroll that starts near the left edge (GH #19)", () => {
    const onOpenChange = vi.fn();
    render({ onOpenChange });

    // First movement is dominantly vertical — the user is scrolling, even
    // though the gesture drifts right far enough to pass the old threshold.
    touch("touchstart", 10, 300);
    touch("touchmove", 40, 340);
    touch("touchmove", 65, 370);
    touch("touchend", 65, 370);

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores a swipe that drifts mostly vertical overall", () => {
    const onOpenChange = vi.fn();
    render({ onOpenChange });

    touch("touchstart", 10, 300);
    touch("touchmove", 30, 300);
    touch("touchend", 75, 240);

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores a gesture the browser cancels (system back-navigation)", () => {
    const onOpenChange = vi.fn();
    render({ onOpenChange });

    touch("touchstart", 2, 300);
    touch("touchmove", 50, 300);
    touch("touchcancel", 50, 300);
    // A stray touchend after the cancel must not be attributed to the gesture.
    touch("touchend", 120, 300);

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores a tap with no movement", () => {
    const onOpenChange = vi.fn();
    render({ onOpenChange });

    touch("touchstart", 10, 300);
    touch("touchend", 12, 300);

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("ignores swipes that start away from the left edge", () => {
    const onOpenChange = vi.fn();
    render({ onOpenChange });

    touch("touchstart", 100, 300);
    touch("touchmove", 150, 300);
    touch("touchend", 180, 300);

    expect(onOpenChange).not.toHaveBeenCalled();
  });

  it("closes the sidebar on a left swipe when open", () => {
    const onOpenChange = vi.fn();
    render({ isOpen: true, onOpenChange });

    touch("touchstart", 200, 300);
    touch("touchmove", 150, 300);
    touch("touchend", 120, 300);

    expect(onOpenChange).toHaveBeenCalledWith(false);
  });

  it("tracks isOpen across re-renders", () => {
    const onOpenChange = vi.fn();
    render({ isOpen: false, onOpenChange });

    touch("touchstart", 10, 300);
    touch("touchmove", 50, 300);
    touch("touchend", 90, 300);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    render({ isOpen: true, onOpenChange });

    touch("touchstart", 200, 300);
    touch("touchmove", 150, 300);
    touch("touchend", 120, 300);
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it("does nothing when disabled", () => {
    const onOpenChange = vi.fn();
    render({ enabled: false, onOpenChange });

    touch("touchstart", 10, 300);
    touch("touchmove", 90, 300);
    touch("touchend", 90, 300);

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});
