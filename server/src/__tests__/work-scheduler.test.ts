import { afterEach, describe, expect, it, vi } from "vitest";
import { createWorkScheduler } from "../services/work-scheduler.js";
afterEach(() => vi.useRealTimers());
describe("work scheduler", () => {
  it("owns one timer, replaces named deadlines, and exposes the earliest wake", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const s = createWorkScheduler();
    const first = vi.fn(), second = vi.fn();
    s.schedule("first", 100, first);
    s.schedule("second", 50, second);
    s.schedule("first", 20, first);
    expect(vi.getTimerCount()).toBe(1);
    expect(s.nextWakeAt()).toBe(20);
    await vi.advanceTimersByTimeAsync(20);
    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
    expect(s.nextWakeAt()).toBe(50);
    s.cancel("second");
    expect(s.nextWakeAt()).toBeNull();
    expect(vi.getTimerCount()).toBe(0);
  });
  it("honors cancellation during dispatch and isolates a failing callback", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const warn = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    const s = createWorkScheduler(), cancelled = vi.fn(), later = vi.fn();
    s.schedule("first", 10, () => { s.cancel("cancelled"); throw new Error("failure"); });
    s.schedule("cancelled", 10, cancelled);
    s.schedule("later", 20, later);
    await vi.advanceTimersByTimeAsync(20);
    expect(cancelled).not.toHaveBeenCalled();
    expect(later).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore(); s.stop();
  });
  it("does not fire distant deadlines early and cannot restart after stop", async () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    const s = createWorkScheduler(), run = vi.fn();
    s.schedule("far", 3_000_000_000, run);
    await vi.advanceTimersByTimeAsync(2_147_483_647);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(852_516_353);
    expect(run).toHaveBeenCalledTimes(1);
    s.stop(); s.schedule("late", Date.now(), run);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => createWorkScheduler().schedule("bad", NaN, run)).toThrow("finite");
  });
});
