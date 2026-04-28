import { logger } from "../middleware/logger.js";

/**
 * A detected interval during which the host clock advanced far more than the
 * tracker's monotonic timer expected, indicating the process was suspended
 * (typically macOS Sleep -> Wake).
 */
export interface SleepBoundary {
  sleptAt: Date;
  wokeAt: Date;
  gapMs: number;
}

export interface SleepBoundaryStats {
  boundaryCount: number;
  totalSleepMs: number;
  lastBoundary: SleepBoundary | null;
}

export interface SleepBoundaryTrackerOptions {
  /** Sampling interval in milliseconds. Defaults to 10s. */
  intervalMs?: number;
  /**
   * Extra wall-clock slack on top of intervalMs before a tick is treated as a
   * sleep boundary. Defaults to 30s -- comfortably above timer jitter under
   * load but well below the shortest realistic sleep gap.
   */
  thresholdMs?: number;
  /** Maximum boundaries retained in the ring buffer. Defaults to 256. */
  maxBoundaries?: number;
  /** "Just woke" window used by `recentlyWoke()`. Defaults to 5s (DarkWake). */
  recentWakeWindowMs?: number;
  /** Injected wall clock; defaults to `Date.now`. */
  now?: () => number;
  /** Injected timer; defaults to `setInterval`/`clearInterval`. */
  setIntervalImpl?: typeof setInterval;
  clearIntervalImpl?: typeof clearInterval;
  /** Optional logger override (used by tests). */
  log?: { warn: (obj: unknown, msg?: string) => void; info: (obj: unknown, msg?: string) => void };
}

const DEFAULT_INTERVAL_MS = 10_000;
const DEFAULT_THRESHOLD_MS = 30_000;
const DEFAULT_MAX_BOUNDARIES = 256;
const DEFAULT_RECENT_WAKE_WINDOW_MS = 5_000;

export interface SleepBoundaryTracker {
  start(): void;
  stop(): void;
  isRunning(): boolean;
  getBoundariesBetween(start: Date | null, end: Date | null): SleepBoundary[];
  wasAsleepBetween(start: Date | null, end: Date | null): boolean;
  getStats(): SleepBoundaryStats;
  /** True when a sleep boundary ended within `recentWakeWindowMs` of `at`. */
  recentlyWoke(at?: Date): boolean;
}

/**
 * Test-only handle returned by `createSleepBoundaryTracker`. Exposes a synthetic
 * sample injector so tests don't have to wait on a real timer; production
 * callers consume the narrower `SleepBoundaryTracker` interface.
 */
export interface SleepBoundaryTrackerTestHandle extends SleepBoundaryTracker {
  recordSampleForTest(now: number, expected: number): SleepBoundary | null;
}

export function createSleepBoundaryTracker(
  options: SleepBoundaryTrackerOptions = {},
): SleepBoundaryTrackerTestHandle {
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const thresholdMs = options.thresholdMs ?? DEFAULT_THRESHOLD_MS;
  const maxBoundaries = options.maxBoundaries ?? DEFAULT_MAX_BOUNDARIES;
  const recentWakeWindowMs = options.recentWakeWindowMs ?? DEFAULT_RECENT_WAKE_WINDOW_MS;
  const now = options.now ?? (() => Date.now());
  const setIntervalImpl = options.setIntervalImpl ?? setInterval;
  const clearIntervalImpl = options.clearIntervalImpl ?? clearInterval;
  const log = options.log ?? logger;

  const boundaries: SleepBoundary[] = [];
  let totalSleepMs = 0;
  let timer: ReturnType<typeof setInterval> | null = null;
  let lastSampleAt = now();

  function recordBoundary(currentNow: number, expected: number): SleepBoundary | null {
    const gap = currentNow - expected;
    if (gap <= thresholdMs) return null;
    const boundary: SleepBoundary = {
      sleptAt: new Date(expected - intervalMs),
      wokeAt: new Date(currentNow),
      gapMs: gap,
    };
    boundaries.push(boundary);
    if (boundaries.length > maxBoundaries) {
      const dropped = boundaries.shift();
      if (dropped) totalSleepMs -= dropped.gapMs;
    }
    totalSleepMs += gap;
    log.warn(
      {
        sleptAt: boundary.sleptAt.toISOString(),
        wokeAt: boundary.wokeAt.toISOString(),
        gapMs: gap,
      },
      "sleep boundary detected (host appears to have suspended)",
    );
    return boundary;
  }

  function tick() {
    const currentNow = now();
    const expected = lastSampleAt + intervalMs;
    recordBoundary(currentNow, expected);
    lastSampleAt = currentNow;
  }

  return {
    start() {
      if (timer) return;
      lastSampleAt = now();
      timer = setIntervalImpl(tick, intervalMs);
      // Avoid keeping the Node process alive when nothing else is pending
      // (e.g. graceful shutdown waits on pending IO, not this watchdog).
      if (timer && typeof (timer as { unref?: () => void }).unref === "function") {
        (timer as { unref: () => void }).unref();
      }
    },
    stop() {
      if (!timer) return;
      clearIntervalImpl(timer);
      timer = null;
    },
    isRunning() {
      return timer !== null;
    },
    getBoundariesBetween(start, end) {
      if (!start || !end) return [];
      const startMs = start.getTime();
      const endMs = end.getTime();
      if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs <= startMs) return [];
      return boundaries.filter((boundary) => {
        const sleepEnd = boundary.wokeAt.getTime();
        const sleepStart = boundary.sleptAt.getTime();
        // Boundary overlaps the run window if sleep started before window end
        // and sleep ended after window start.
        return sleepStart < endMs && sleepEnd > startMs;
      });
    },
    wasAsleepBetween(start, end) {
      return this.getBoundariesBetween(start, end).length > 0;
    },
    getStats() {
      return {
        boundaryCount: boundaries.length,
        totalSleepMs,
        lastBoundary: boundaries.length > 0 ? boundaries[boundaries.length - 1] : null,
      };
    },
    recentlyWoke(at = new Date()) {
      const cutoff = at.getTime() - recentWakeWindowMs;
      for (let i = boundaries.length - 1; i >= 0; i -= 1) {
        const wokeAt = boundaries[i].wokeAt.getTime();
        if (wokeAt < cutoff) return false;
        if (wokeAt <= at.getTime()) return true;
      }
      return false;
    },
    recordSampleForTest(currentNow, expected) {
      const boundary = recordBoundary(currentNow, expected);
      lastSampleAt = currentNow;
      return boundary;
    },
  };
}

let sharedTracker: SleepBoundaryTracker | null = null;

/**
 * Process-wide singleton. The server boots one tracker; services and tests
 * read it through `getSleepBoundaryTracker`.
 */
export function getSleepBoundaryTracker(): SleepBoundaryTracker {
  if (!sharedTracker) {
    sharedTracker = createSleepBoundaryTracker();
  }
  return sharedTracker;
}

/** Test-only override. */
export function setSleepBoundaryTrackerForTest(tracker: SleepBoundaryTracker | null): void {
  sharedTracker = tracker;
}
