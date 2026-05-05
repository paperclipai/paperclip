import { logger } from "./middleware/logger.js";

const LAG_WARN_MS = 500;
const LAG_CRITICAL_MS = 2000;
const LAG_CRITICAL_SUSTAINED_MS = 30_000;
const PROBE_INTERVAL_MS = 500;

export function startEventLoopLagProbe(opts?: { now?: () => number }): void {
  const now = opts?.now ?? (() => Date.now());
  let criticalSinceMs: number | null = null;

  function scheduleProbe(): void {
    const expected = now() + PROBE_INTERVAL_MS;
    const timer = setTimeout(() => {
      const lag = now() - expected;
      if (lag > LAG_WARN_MS) {
        logger.warn({ lagMs: lag }, "event-loop lag detected");
      }
      if (lag > LAG_CRITICAL_MS) {
        if (criticalSinceMs === null) criticalSinceMs = now();
        if (now() - criticalSinceMs > LAG_CRITICAL_SUSTAINED_MS) {
          logger.error({ lagMs: lag }, "event-loop lag critical — triggering graceful restart");
          process.kill(process.pid, "SIGTERM");
          return;
        }
      } else {
        criticalSinceMs = null;
      }
      scheduleProbe();
    }, PROBE_INTERVAL_MS);
    timer.unref();
  }

  scheduleProbe();
}
