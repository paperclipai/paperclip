// @vitest-environment jsdom
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { RUN_STARTUP_STAGES } from "@paperclipai/shared";
import {
  RUN_STARTUP_STAGE_LABELS,
  runStartupStageLabel,
  STARTUP_LABEL_MIN_DISPLAY_MS,
  useHeldLabel,
} from "./run-startup-stage";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const unmounts: Array<() => void> = [];
afterEach(() => {
  for (const unmount of unmounts.splice(0)) unmount();
  vi.useRealTimers();
});

function renderHeldLabel(initial: string | null) {
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const result = { current: null as string | null };
  let label = initial;
  function Harness() { result.current = useHeldLabel(label); return null; }
  const rerender = (next: string | null) => { label = next; act(() => root.render(createElement(Harness))); };
  unmounts.push(() => { act(() => root.unmount()); host.remove(); });
  rerender(initial);
  return { result, rerender };
}

it("names every startup stage and the resumed session", () => {
  for (const stage of RUN_STARTUP_STAGES) expect(RUN_STARTUP_STAGE_LABELS[stage]).toBeTruthy();
  expect(runStartupStageLabel("starting_environment")).toBe("Waking up");
  expect(runStartupStageLabel("connecting_tools")).toBe("Connecting tools");
  expect(runStartupStageLabel("starting_agent")).toBe("Starting agent");
  expect(runStartupStageLabel("starting_agent", true)).toBe("Resuming session");
  expect(runStartupStageLabel("preparing_workspace", true)).toBe("Preparing workspace");
  expect(runStartupStageLabel(null)).toBeNull();
});

it("shows a changed label at once after the minimum time", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHeldLabel("Getting ready");
  act(() => { vi.advanceTimersByTime(STARTUP_LABEL_MIN_DISPLAY_MS); });
  rerender("Waking up");
  expect(result.current).toBe("Waking up");
});

it("holds a fresh label, then skips to the latest one", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHeldLabel("Getting ready");
  act(() => { vi.advanceTimersByTime(100); });
  rerender("Waking up");
  rerender("Preparing workspace");
  expect(result.current).toBe("Getting ready");
  act(() => { vi.advanceTimersByTime(STARTUP_LABEL_MIN_DISPLAY_MS - 101); });
  expect(result.current).toBe("Getting ready");
  act(() => { vi.advanceTimersByTime(1); });
  expect(result.current).toBe("Preparing workspace");
});

it("holds the last stage before returning to the default", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHeldLabel("Starting agent");
  rerender(null);
  expect(result.current).toBe("Starting agent");
  act(() => { vi.advanceTimersByTime(STARTUP_LABEL_MIN_DISPLAY_MS); });
  expect(result.current).toBeNull();
});

it("keeps the shown label when a change is undone within the hold", () => {
  vi.useFakeTimers();
  const { result, rerender } = renderHeldLabel("Getting ready");
  rerender("Waking up");
  rerender("Getting ready");
  act(() => { vi.advanceTimersByTime(STARTUP_LABEL_MIN_DISPLAY_MS * 2); });
  expect(result.current).toBe("Getting ready");
});
