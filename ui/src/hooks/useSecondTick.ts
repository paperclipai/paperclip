import { useEffect, useState } from "react";

/**
 * A single, process-wide 1-second ticker shared by every subscriber.
 *
 * Live "elapsed time" displays (e.g. "2m ago", running-agent timers) used to
 * each create their own `setInterval(..., 1000)`. On a busy issue thread that
 * meant dozens of independent 1s timers, each forcing a component re-render
 * every second — a major driver of steady-state CPU churn (and, compounded
 * across a long-lived tab, off-heap allocation growth). This collapses all of
 * them onto one interval that only runs while at least one subscriber is active.
 */
const subscribers = new Set<() => void>();
let intervalId: ReturnType<typeof setInterval> | null = null;

function ensureRunning(): void {
  if (intervalId !== null) return;
  intervalId = setInterval(() => {
    for (const notify of subscribers) notify();
  }, 1000);
}

function stopIfIdle(): void {
  if (intervalId !== null && subscribers.size === 0) {
    clearInterval(intervalId);
    intervalId = null;
  }
}

/**
 * Re-render the calling component once per second while `active` is true, driven
 * by the shared ticker. Returns a monotonically increasing tick count in case a
 * caller wants it as a dependency.
 */
export function useSecondTick(active: boolean): number {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const notify = () => setTick((n) => n + 1);
    subscribers.add(notify);
    ensureRunning();
    return () => {
      subscribers.delete(notify);
      stopIfIdle();
    };
  }, [active]);
  return tick;
}

/** Test-only hook to observe the shared ticker's internal state. */
export const __secondTickInternals = {
  subscriberCount: () => subscribers.size,
  isRunning: () => intervalId !== null,
};
