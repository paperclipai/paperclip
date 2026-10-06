// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDateRange, type UseDateRangeResult } from "./useDateRange";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe("useDateRange", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 8, 28, 10, 15, 30));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the month-to-date range stable when the minute changes", () => {
    const results: UseDateRangeResult[] = [];
    function Probe() {
      results.push(useDateRange());
      return null;
    }
    const root = createRoot(document.createElement("div"));
    act(() => root.render(<Probe />));
    const initial = results.at(-1)!;

    act(() => {
      vi.advanceTimersByTime(5 * 60_000);
    });

    expect(results.length).toBeGreaterThan(1);
    expect(initial).toMatchObject({ from: new Date(2026, 8, 1).toISOString(), to: "" });
    expect(results.at(-1)).toMatchObject({ from: initial.from, to: initial.to });
    act(() => root.unmount());
  });
});
