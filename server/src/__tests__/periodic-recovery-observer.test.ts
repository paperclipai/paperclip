import { afterEach, describe, expect, it, vi } from "vitest";
import * as observability from "../services/recovery-observability.js";

afterEach(() => vi.useRealTimers());

describe("periodic recovery completion receipts", () => {
  it("reports only after the existing asynchronous work completes", async () => {
    expect(observability.createPeriodicRecoveryObserver).toBeTypeOf("function");
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const report = vi.fn();
    const observe = observability.createPeriodicRecoveryObserver(report);
    let finish!: (value: string) => void;
    const work = vi.fn(() => new Promise<string>((resolve) => { finish = resolve; }));

    const pending = observe(work);
    expect(work).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    vi.setSystemTime(new Date("2026-01-01T00:00:02.000Z"));
    finish("original result");

    await expect(pending).resolves.toBe("original result");
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0]).toEqual({
      observerId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      cycle: 1,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T00:00:02.000Z",
    });
  });

  it("preserves failures without emitting a successful receipt or retrying", async () => {
    const report = vi.fn();
    const observe = observability.createPeriodicRecoveryObserver(report);
    const error = new Error("synthetic stage failure");
    const work = vi.fn().mockRejectedValue(error);
    await expect(observe(work)).rejects.toBe(error);
    expect(work).toHaveBeenCalledTimes(1);
    expect(report).not.toHaveBeenCalled();
    await observe(async () => undefined);
    expect(report.mock.calls[0][0].cycle).toBe(2);
  });

  it("preserves synchronous failures without reporting completion", async () => {
    const report = vi.fn();
    const observe = observability.createPeriodicRecoveryObserver(report);
    const error = new Error("synthetic synchronous failure");
    await expect(observe(() => { throw error; })).rejects.toBe(error);
    expect(report).not.toHaveBeenCalled();
  });

  it("does not invent scheduled work or receipts when it is not called", async () => {
    vi.useFakeTimers();
    const report = vi.fn();
    observability.createPeriodicRecoveryObserver(report);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vi.getTimerCount()).toBe(0);
    expect(report).not.toHaveBeenCalled();
  });

  it("distinguishes observer lifetimes and overlapping real completions", async () => {
    const report = vi.fn();
    const observe = observability.createPeriodicRecoveryObserver(report);
    let finish!: () => void;
    const first = observe(() => new Promise<void>((resolve) => { finish = resolve; }));
    await observe(async () => undefined);
    expect(report).toHaveBeenCalledTimes(1);
    expect(report.mock.calls[0][0].cycle).toBe(2);
    finish();
    await first;
    expect(report.mock.calls[1][0].cycle).toBe(1);
    expect(report.mock.calls[0][0].observerId).toBe(report.mock.calls[1][0].observerId);
    await observability.createPeriodicRecoveryObserver(report)(async () => undefined);
    expect(report.mock.calls[2][0].cycle).toBe(1);
    expect(report.mock.calls[2][0].observerId).not.toBe(report.mock.calls[0][0].observerId);
  });
});
