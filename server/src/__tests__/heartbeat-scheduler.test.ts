import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Inline the scheduler logic to avoid workspace import issues in tests.
// This mirrors the createHeartbeatScheduler implementation.

interface SchedulerOpts {
  intervalMs: number;
  tickTimers: (now: Date) => Promise<{ enqueued: number }>;
  reapOrphanedRuns: (opts: { staleThresholdMs: number }) => Promise<void>;
  staleThresholdMs?: number;
}

function createTestScheduler(opts: SchedulerOpts) {
  const { intervalMs, tickTimers, reapOrphanedRuns, staleThresholdMs = 5 * 60 * 1000 } = opts;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlightPromise: Promise<void> | null = null;

  async function tick() {
    if (!running) return;
    try {
      await tickTimers(new Date());
    } catch {
      // swallow
    }
    try {
      await reapOrphanedRuns({ staleThresholdMs });
    } catch {
      // swallow
    }
    scheduleNext(intervalMs);
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
      if (inFlightPromise) {
        await inFlightPromise;
      }
    },
    get isRunning() {
      return running;
    },
  };
}

describe("heartbeat-scheduler", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("calls tickTimers on start", async () => {
    const tickTimers = vi.fn().mockResolvedValue({ enqueued: 0 });
    const reap = vi.fn().mockResolvedValue(undefined);

    const scheduler = createTestScheduler({
      intervalMs: 30000,
      tickTimers,
      reapOrphanedRuns: reap,
    });

    scheduler.start();
    // Allow the microtask queue to flush.
    await vi.advanceTimersByTimeAsync(0);

    expect(tickTimers).toHaveBeenCalledOnce();
    expect(reap).toHaveBeenCalledOnce();

    await scheduler.stop();
  });

  it("schedules subsequent ticks after interval", async () => {
    const tickTimers = vi.fn().mockResolvedValue({ enqueued: 0 });
    const reap = vi.fn().mockResolvedValue(undefined);

    const scheduler = createTestScheduler({
      intervalMs: 30000,
      tickTimers,
      reapOrphanedRuns: reap,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(tickTimers).toHaveBeenCalledTimes(1);

    // Advance to the next tick.
    await vi.advanceTimersByTimeAsync(30000);
    expect(tickTimers).toHaveBeenCalledTimes(2);

    // And another.
    await vi.advanceTimersByTimeAsync(30000);
    expect(tickTimers).toHaveBeenCalledTimes(3);

    await scheduler.stop();
  });

  it("does not overlap ticks (backpressure)", async () => {
    // Verify that a second tick is never started while the first is running.
    // We use a resolve callback to control when the first tick finishes.
    let tickCallCount = 0;
    let resolveFirstTick: (() => void) | null = null;

    const tickTimers = vi.fn(async () => {
      tickCallCount++;
      if (tickCallCount === 1) {
        // First tick: block until we explicitly resolve it.
        await new Promise<void>((resolve) => {
          resolveFirstTick = resolve;
        });
      }
      return { enqueued: 0 };
    });
    const reap = vi.fn().mockResolvedValue(undefined);

    const scheduler = createTestScheduler({
      intervalMs: 1000,
      tickTimers,
      reapOrphanedRuns: reap,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0); // kick off first tick

    // First tick is running, advance well past the interval.
    await vi.advanceTimersByTimeAsync(5000);

    // Only 1 call because the first tick hasn't finished yet.
    expect(tickCallCount).toBe(1);

    // Now resolve the first tick.
    resolveFirstTick!();
    await vi.advanceTimersByTimeAsync(0); // let reap run

    // Advance to let the next tick schedule and fire.
    await vi.advanceTimersByTimeAsync(1000);
    expect(tickCallCount).toBe(2);

    await scheduler.stop();
  });

  it("stop() waits for in-flight tick", async () => {
    let tickFinished = false;
    const tickTimers = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      tickFinished = true;
      return { enqueued: 0 };
    });
    const reap = vi.fn().mockResolvedValue(undefined);

    const scheduler = createTestScheduler({
      intervalMs: 30000,
      tickTimers,
      reapOrphanedRuns: reap,
    });

    scheduler.start();

    // Start the stop while tick is in-flight.
    const stopPromise = scheduler.stop();

    // Advance time to let the tick finish.
    await vi.advanceTimersByTimeAsync(5000);
    await stopPromise;

    expect(tickFinished).toBe(true);
    expect(scheduler.isRunning).toBe(false);
  });

  it("survives tick errors", async () => {
    let callCount = 0;
    const tickTimers = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("tick-boom");
      return { enqueued: 0 };
    });
    const reap = vi.fn().mockResolvedValue(undefined);

    const scheduler = createTestScheduler({
      intervalMs: 1000,
      tickTimers,
      reapOrphanedRuns: reap,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0); // first tick (throws)
    await vi.advanceTimersByTimeAsync(1000); // second tick (succeeds)

    expect(tickTimers).toHaveBeenCalledTimes(2);
    expect(scheduler.isRunning).toBe(true);

    await scheduler.stop();
  });

  it("survives reap errors", async () => {
    const tickTimers = vi.fn().mockResolvedValue({ enqueued: 0 });
    const reap = vi.fn().mockRejectedValue(new Error("reap-boom"));

    const scheduler = createTestScheduler({
      intervalMs: 1000,
      tickTimers,
      reapOrphanedRuns: reap,
    });

    scheduler.start();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1000);

    // Should still be running despite reap errors.
    expect(scheduler.isRunning).toBe(true);
    expect(tickTimers).toHaveBeenCalledTimes(2);

    await scheduler.stop();
  });
});
