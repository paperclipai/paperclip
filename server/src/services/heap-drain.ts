import v8 from "node:v8";
import { logger } from "../middleware/logger.js";

const HEAP_DRAIN_PERCENT = Math.min(
  100,
  Math.max(1, Number(process.env.HEAP_DRAIN_PERCENT) || 75),
);
const HEAP_DRAIN_TIMEOUT_MS = Math.max(
  1000,
  Number(process.env.HEAP_DRAIN_TIMEOUT_MS) || 120_000,
);
const HEAP_DRAIN_POLL_MS = 5_000;

let draining = false;

export function isIntakeSuspended(): boolean {
  return draining;
}

export function startHeapDrainMonitor(opts: {
  getActiveRunCount: () => number;
}): void {
  const { heap_size_limit } = v8.getHeapStatistics();
  const thresholdBytes = Math.floor((HEAP_DRAIN_PERCENT / 100) * heap_size_limit);

  logger.info(
    {
      heapSizeLimitMb: Math.round(heap_size_limit / 1024 / 1024),
      thresholdMb: Math.round(thresholdBytes / 1024 / 1024),
      thresholdPercent: HEAP_DRAIN_PERCENT,
      drainTimeoutMs: HEAP_DRAIN_TIMEOUT_MS,
    },
    "heap-drain monitor started",
  );

  async function performDrain(initialActiveRunCount: number): Promise<void> {
    logger.warn(
      {
        activeRunCount: initialActiveRunCount,
        drainTimeoutMs: HEAP_DRAIN_TIMEOUT_MS,
      },
      "heap-drain: drain sequence started — waiting for in-flight runs to complete",
    );

    const deadline = Date.now() + HEAP_DRAIN_TIMEOUT_MS;

    await new Promise<void>((resolve) => {
      const poll = setInterval(() => {
        const remaining = opts.getActiveRunCount();
        logger.info({ remaining }, "heap-drain: polling in-flight runs");
        if (remaining === 0) {
          clearInterval(poll);
          resolve();
          return;
        }
        if (Date.now() >= deadline) {
          logger.warn(
            { remaining, drainTimeoutMs: HEAP_DRAIN_TIMEOUT_MS },
            "heap-drain: drain timeout reached — proceeding with restart despite in-flight runs",
          );
          clearInterval(poll);
          resolve();
        }
      }, 1_000);
      poll.unref();
    });

    logger.warn("heap-drain: drain complete — sending SIGTERM for graceful restart");
    process.kill(process.pid, "SIGTERM");
  }

  const interval = setInterval(() => {
    if (draining) return;

    const { used_heap_size } = v8.getHeapStatistics();
    if (used_heap_size < thresholdBytes) return;

    const usedPercent = Math.round((used_heap_size / heap_size_limit) * 100);
    const activeRunCount = opts.getActiveRunCount();

    logger.warn(
      {
        usedHeapMb: Math.round(used_heap_size / 1024 / 1024),
        heapSizeLimitMb: Math.round(heap_size_limit / 1024 / 1024),
        usedPercent,
        thresholdPercent: HEAP_DRAIN_PERCENT,
        activeRunCount,
      },
      "heap-drain: threshold crossed — suspending intake",
    );

    draining = true;
    clearInterval(interval);
    void performDrain(activeRunCount);
  }, HEAP_DRAIN_POLL_MS);

  // Do not prevent process exit if no runs are active.
  interval.unref();
}
