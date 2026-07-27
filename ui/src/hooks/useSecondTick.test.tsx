// @vitest-environment jsdom

import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { __secondTickInternals, useSecondTick } from "./useSecondTick";

function mount(active: boolean) {
  const container = document.createElement("div");
  const root = createRoot(container);
  function Probe() {
    useSecondTick(active);
    return null;
  }
  flushSync(() => root.render(<Probe />));
  return { unmount: () => flushSync(() => root.unmount()) };
}

describe("useSecondTick", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("shares a single timer across multiple active subscribers and stops when idle", () => {
    const a = mount(true);
    const b = mount(true);

    expect(__secondTickInternals.subscriberCount()).toBe(2);
    expect(__secondTickInternals.isRunning()).toBe(true);

    a.unmount();
    expect(__secondTickInternals.subscriberCount()).toBe(1);
    expect(__secondTickInternals.isRunning()).toBe(true); // still one subscriber

    b.unmount();
    expect(__secondTickInternals.subscriberCount()).toBe(0);
    expect(__secondTickInternals.isRunning()).toBe(false); // timer stopped when idle
  });

  it("does not subscribe or start a timer when inactive", () => {
    const c = mount(false);
    expect(__secondTickInternals.subscriberCount()).toBe(0);
    expect(__secondTickInternals.isRunning()).toBe(false);
    c.unmount();
  });
});
