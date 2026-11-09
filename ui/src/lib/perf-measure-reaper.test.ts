import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { startPerfMeasureReaper } from "./perf-measure-reaper";

describe("startPerfMeasureReaper", () => {
  let clearMeasures: ReturnType<typeof vi.fn>;
  let original: typeof performance.clearMeasures;

  beforeEach(() => {
    vi.useFakeTimers();
    clearMeasures = vi.fn();
    original = performance.clearMeasures;
    performance.clearMeasures = clearMeasures as unknown as typeof performance.clearMeasures;
    delete (globalThis as { __paperclipKeepPerfMeasures?: boolean }).__paperclipKeepPerfMeasures;
  });

  afterEach(() => {
    performance.clearMeasures = original;
    vi.useRealTimers();
    delete (globalThis as { __paperclipKeepPerfMeasures?: boolean }).__paperclipKeepPerfMeasures;
  });

  it("clears measures on each interval", () => {
    const stop = startPerfMeasureReaper(10_000);
    expect(clearMeasures).not.toHaveBeenCalled();
    vi.advanceTimersByTime(10_000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(10_000);
    expect(clearMeasures).toHaveBeenCalledTimes(2);
    stop();
  });

  it("stop() halts further clearing", () => {
    const stop = startPerfMeasureReaper(10_000);
    vi.advanceTimersByTime(10_000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    stop();
    vi.advanceTimersByTime(50_000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
  });

  it("skips clearing while the opt-out flag is set (e.g. profiling)", () => {
    const stop = startPerfMeasureReaper(10_000);
    (globalThis as { __paperclipKeepPerfMeasures?: boolean }).__paperclipKeepPerfMeasures = true;
    vi.advanceTimersByTime(30_000);
    expect(clearMeasures).not.toHaveBeenCalled();
    (globalThis as { __paperclipKeepPerfMeasures?: boolean }).__paperclipKeepPerfMeasures = false;
    vi.advanceTimersByTime(10_000);
    expect(clearMeasures).toHaveBeenCalledTimes(1);
    stop();
  });

  it("is a no-op when performance.clearMeasures is unavailable", () => {
    performance.clearMeasures = undefined as unknown as typeof performance.clearMeasures;
    const stop = startPerfMeasureReaper(10_000);
    vi.advanceTimersByTime(30_000);
    // nothing to assert other than: it did not throw and returns a callable stop
    expect(typeof stop).toBe("function");
    stop();
  });
});
