import { describe, expect, it } from "vitest";
import {
  createProcessMemorySample,
  getProcessMemoryMonitorSubscriberCount,
  startProcessMemoryMonitor,
} from "../services/process-memory-monitor.js";

describe("process memory monitoring", () => {
  it("reports bounded metadata without process payloads", () => {
    const sample = createProcessMemorySample({ durationMs: 250, count: 4 }, 1_000);

    expect(sample).toMatchObject({
      event: "process_memory",
      gcDurationMs: 250,
      gcPressure: 0.25,
      gcCount: 4,
    });
    expect(sample.rssBytes).toBeGreaterThan(0);
    expect(sample.heapLimitBytes).toBeGreaterThan(0);
    expect(Object.keys(sample).sort()).toEqual([
      "arrayBuffersBytes",
      "event",
      "externalBytes",
      "gcCount",
      "gcDurationMs",
      "gcPressure",
      "heapLimitBytes",
      "heapTotalBytes",
      "heapUsedBytes",
      "heapUtilization",
      "rssBytes",
      "uptimeSeconds",
    ]);
  });

  it("shares one process monitor across repeated starts and cleans it up", () => {
    const stopFirst = startProcessMemoryMonitor(60_000);
    const stopSecond = startProcessMemoryMonitor(60_000);

    expect(getProcessMemoryMonitorSubscriberCount()).toBe(2);
    stopFirst();
    stopFirst();
    expect(getProcessMemoryMonitorSubscriberCount()).toBe(1);
    stopSecond();
    expect(getProcessMemoryMonitorSubscriberCount()).toBe(0);
  });
});
