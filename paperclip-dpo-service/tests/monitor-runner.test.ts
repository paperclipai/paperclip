import { describe, it, expect, vi } from "vitest";
import { startMonitorRunner } from "../src/monitor-runner.js";

describe("startMonitorRunner", () => {
  it("polls tailer and classifier at interval", async () => {
    vi.useFakeTimers();
    const tailer = { poll: vi.fn().mockReturnValue([]) };
    const classifierProbe = vi.fn().mockResolvedValue("reachable" as const);
    const monitor = { evaluate: vi.fn(), recordClassifierStatus: vi.fn() };
    const stop = startMonitorRunner({
      tailer, classifierProbe, monitor, intervalMs: 1000,
    });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(tailer.poll).toHaveBeenCalledTimes(2);
    expect(classifierProbe).toHaveBeenCalledTimes(2);
    expect(monitor.evaluate).toHaveBeenCalledTimes(2);
    expect(monitor.recordClassifierStatus).toHaveBeenCalledWith("reachable");
    stop();
    vi.useRealTimers();
  });
});
