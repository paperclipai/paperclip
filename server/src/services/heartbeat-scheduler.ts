/**
 * Backpressure-aware heartbeat scheduler.
 *
 * Replaces the raw `setInterval` in index.ts with a self-rescheduling
 * timer that prevents tick pileup. If a tick takes longer than the
 * interval, the next tick starts immediately after — but never
 * overlaps with the current one.
 *
 * Also adds:
 * - Graceful shutdown (stops scheduling new ticks, waits for in-flight)
 * - Tick duration metrics for observability
 * - Error isolation (a failed tick doesn't kill the scheduler)
 */
import { logger } from "../middleware/logger.js";

export interface HeartbeatSchedulerOptions {
  intervalMs: number;
  tickTimers: (now: Date) => Promise<{ enqueued: number }>;
  reapOrphanedRuns: (opts: { staleThresholdMs: number }) => Promise<void>;
  staleThresholdMs?: number;
}

export interface HeartbeatScheduler {
  start(): void;
  stop(): Promise<void>;
}

export function createHeartbeatScheduler(opts: HeartbeatSchedulerOptions): HeartbeatScheduler {
  const { intervalMs, tickTimers, reapOrphanedRuns, staleThresholdMs = 5 * 60 * 1000 } = opts;

  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightPromise: Promise<void> | null = null;

  // Simple moving-window stats for the last 10 ticks.
  const tickDurations: number[] = [];
  const MAX_DURATION_SAMPLES = 10;

  function recordDuration(ms: number) {
    tickDurations.push(ms);
    if (tickDurations.length > MAX_DURATION_SAMPLES) {
      tickDurations.shift();
    }
  }

  async function tick() {
    if (!running) return;

    const startMs = Date.now();

    try {
      const result = await tickTimers(new Date());
      if (result.enqueued > 0) {
        logger.info({ ...result }, "heartbeat timer tick enqueued runs");
      }
    } catch (err) {
      logger.error({ err }, "heartbeat timer tick failed");
    }

    try {
      await reapOrphanedRuns({ staleThresholdMs });
    } catch (err) {
      logger.error({ err }, "periodic reap of orphaned heartbeat runs failed");
    }

    const elapsedMs = Date.now() - startMs;
    recordDuration(elapsedMs);

    if (elapsedMs > intervalMs) {
      const avgMs = Math.round(tickDurations.reduce((a, b) => a + b, 0) / tickDurations.length);
      logger.warn(
        { elapsedMs, intervalMs, avgTickMs: avgMs },
        "heartbeat tick exceeded interval — consider increasing HEARTBEAT_SCHEDULER_INTERVAL_MS",
      );
    }

    scheduleNext(Math.max(0, intervalMs - elapsedMs));
  }

  function scheduleNext(delayMs: number) {
    if (!running) return;
    timer = setTimeout(() => {
      inFlightPromise = tick().finally(() => {
        inFlightPromise = null;
      });
    }, delayMs);
  }

  return {
    start() {
      if (running) return;
      running = true;
      logger.info({ intervalMs, staleThresholdMs }, "heartbeat scheduler started");
      // First tick fires immediately.
      inFlightPromise = tick().finally(() => {
        inFlightPromise = null;
      });
    },

    async stop() {
      running = false;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      // Wait for any in-flight tick to finish.
      if (inFlightPromise) {
        await inFlightPromise;
      }
      logger.info("heartbeat scheduler stopped");
    },
  };
}
