// @vitest-environment jsdom

import { StrictMode } from "react";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { IssueChatLongThreadPerf } from "./IssueChatLongThreadPerf";

vi.mock("../components/IssueChatThread", () => ({ IssueChatThread: () => null }));

const mounted: Array<{ root: Root; container: HTMLDivElement }> = [];

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    flushSync(() => root.unmount());
    container.remove();
  }
  vi.useRealTimers();
});

function mount(strict: boolean) {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const view = { root, container };
  mounted.push(view);
  flushSync(() => root.render(strict ? <StrictMode><IssueChatLongThreadPerf /></StrictMode> : <IssueChatLongThreadPerf />));
  return view;
}

function metric(container: HTMLElement, name: string) {
  return container.querySelector(`[data-testid="perf-${name}"]`)!.textContent!;
}

it.each([false, true])("publishes finite actual fixture metrics with StrictMode=%s", strict => {
  const { container } = mount(strict);
  flushSync(() => vi.runOnlyPendingTimers());
  for (const name of ["mount-duration", "latest-duration", "max-duration", "total-duration"])
    expect(metric(container, name)).toMatch(/^\d+(?:\.\d+)? ms$/);
  expect(Number(metric(container, "commit-count"))).toBeGreaterThanOrEqual(1);
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels unpublished metrics on unmount and allows a fresh StrictMode mount", () => {
  const first = mount(true);
  expect(vi.getTimerCount()).toBe(1);
  flushSync(() => first.root.unmount());
  first.container.remove();
  mounted.splice(mounted.indexOf(first), 1);
  expect(vi.getTimerCount()).toBe(0);
  flushSync(() => vi.runOnlyPendingTimers());
  expect(first.container.textContent).toBe("");
  const second = mount(true);
  flushSync(() => vi.runOnlyPendingTimers());
  expect(metric(second.container, "mount-duration")).toMatch(/^\d+(?:\.\d+)? ms$/);
  expect(vi.getTimerCount()).toBe(0);
});
