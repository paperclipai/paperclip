// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useSecondTick } from "./useSecondTick";

function mount(active: boolean) {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    return <output>{useSecondTick(active)}</output>;
  }
  flushSync(() => root.render(<Probe />));
  return { container, unmount: () => flushSync(() => root.unmount()) };
}

describe("useSecondTick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares a single timer across multiple active subscribers and stops when idle", () => {
    const a = mount(true);
    const b = mount(true);

    expect(vi.getTimerCount()).toBe(1);
    flushSync(() => vi.advanceTimersByTime(1000));
    expect(a.container.textContent).toBe("1");
    expect(b.container.textContent).toBe("1");

    a.unmount();
    expect(vi.getTimerCount()).toBe(1);
    flushSync(() => vi.advanceTimersByTime(1000));
    expect(b.container.textContent).toBe("2");

    b.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not subscribe or start a timer when inactive", () => {
    const c = mount(false);
    expect(vi.getTimerCount()).toBe(0);
    flushSync(() => vi.advanceTimersByTime(3000));
    expect(c.container.textContent).toBe("0");
    const active = mount(true);
    flushSync(() => vi.advanceTimersByTime(1000));
    expect(active.container.textContent).toBe("1");
    expect(c.container.textContent).toBe("0");
    active.unmount();
    expect(vi.getTimerCount()).toBe(0);
    c.unmount();
  });
});
