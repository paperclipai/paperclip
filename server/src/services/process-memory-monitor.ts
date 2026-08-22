import { PerformanceObserver, type PerformanceEntry } from "node:perf_hooks";
import v8 from "node:v8";
import { logger } from "../middleware/logger.js";

const DEFAULT_SAMPLE_INTERVAL_MS = 30_000;
const HEAP_WARNING_RATIO = 0.75;
const GC_PRESSURE_RATIO = 0.2;

let activeMonitor: { subscribers: number; stop: () => void } | null = null;

export interface ProcessMemorySample {
  event: "process_memory";
  rssBytes: number;
  heapUsedBytes: number;
  heapTotalBytes: number;
  heapLimitBytes: number;
  externalBytes: number;
  arrayBuffersBytes: number;
  heapUtilization: number;
  gcDurationMs: number;
  gcPressure: number;
  gcCount: number;
  uptimeSeconds: number;
}

export function createProcessMemorySample(
  gc: { durationMs: number; count: number },
  intervalMs: number,
): ProcessMemorySample {
  const memory = process.memoryUsage();
  const heapLimitBytes = v8.getHeapStatistics().heap_size_limit;
  return {
    event: "process_memory",
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    heapLimitBytes,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    heapUtilization: heapLimitBytes > 0 ? memory.heapUsed / heapLimitBytes : 0,
    gcDurationMs: gc.durationMs,
    gcPressure: intervalMs > 0 ? gc.durationMs / intervalMs : 0,
    gcCount: gc.count,
    uptimeSeconds: process.uptime(),
  };
}

export function startProcessMemoryMonitor(intervalMs = DEFAULT_SAMPLE_INTERVAL_MS): () => void {
  if (activeMonitor) {
    activeMonitor.subscribers += 1;
    let released = false;
    return () => {
      if (released || !activeMonitor) return;
      released = true;
      activeMonitor.subscribers -= 1;
      if (activeMonitor.subscribers === 0) {
        activeMonitor.stop();
        activeMonitor = null;
      }
    };
  }

  let gcDurationMs = 0;
  let gcCount = 0;
  const observer = new PerformanceObserver((list) => {
    for (const entry of list.getEntries() as PerformanceEntry[]) {
      gcDurationMs += entry.duration;
      gcCount += 1;
    }
  });
  observer.observe({ entryTypes: ["gc"] });

  logger.info({
    event: "process_start",
    pid: process.pid,
    parentPid: process.ppid,
    startedAt: new Date(Date.now() - process.uptime() * 1000).toISOString(),
    heapLimitBytes: v8.getHeapStatistics().heap_size_limit,
  }, "Process memory monitoring started");

  const timer = setInterval(() => {
    const sample = createProcessMemorySample({ durationMs: gcDurationMs, count: gcCount }, intervalMs);
    gcDurationMs = 0;
    gcCount = 0;
    if (sample.heapUtilization >= HEAP_WARNING_RATIO || sample.gcPressure >= GC_PRESSURE_RATIO) {
      logger.warn(sample, "Process memory pressure detected");
    } else {
      logger.info(sample, "Process memory sample");
    }
  }, intervalMs);
  timer.unref();

  const stop = () => {
    clearInterval(timer);
    observer.disconnect();
  };
  activeMonitor = { subscribers: 1, stop };

  let released = false;
  return () => {
    if (released || !activeMonitor) return;
    released = true;
    activeMonitor.subscribers -= 1;
    if (activeMonitor.subscribers === 0) {
      activeMonitor.stop();
      activeMonitor = null;
    }
  };
}

export function getProcessMemoryMonitorSubscriberCount(): number {
  return activeMonitor?.subscribers ?? 0;
}
