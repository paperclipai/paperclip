import { useCallback, useEffect, useRef, useState } from "react";

interface StaleIndicatorOptions {
  /** How many milliseconds before data is considered stale. Default 60_000 (60s). */
  staleAfterMs?: number;
  /** Interval (ms) to re-check staleness. Default 10_000 (10s). */
  checkIntervalMs?: number;
}

interface StaleIndicatorResult {
  /** Seconds since last update, or null if no data yet. */
  secondsAgo: number | null;
  /** True when secondsAgo exceeds the stale threshold. */
  isStale: boolean;
  /** Call this when data is refreshed. */
  markFresh: () => void;
  /** Human-readable label like "Last updated 2m ago". Null if no data. */
  label: string | null;
}

export function useStaleIndicator(options: StaleIndicatorOptions = {}): StaleIndicatorResult {
  const { staleAfterMs = 60_000, checkIntervalMs = 10_000 } = options;
  const lastFreshAt = useRef<number | null>(null);
  const [secondsAgo, setSecondsAgo] = useState<number | null>(null);

  const markFresh = useCallback(() => {
    lastFreshAt.current = Date.now();
    setSecondsAgo(0);
  }, []);

  useEffect(() => {
    const timer = setInterval(() => {
      if (lastFreshAt.current === null) return;
      const elapsed = Math.round((Date.now() - lastFreshAt.current) / 1000);
      setSecondsAgo(elapsed);
    }, checkIntervalMs);
    return () => clearInterval(timer);
  }, [checkIntervalMs]);

  const isStale = secondsAgo !== null && secondsAgo * 1000 >= staleAfterMs;

  let label: string | null = null;
  if (secondsAgo !== null) {
    if (secondsAgo < 5) {
      label = "Just updated";
    } else if (secondsAgo < 60) {
      label = `Last updated ${secondsAgo}s ago`;
    } else {
      const minutes = Math.floor(secondsAgo / 60);
      label = `Last updated ${minutes}m ago`;
    }
  }

  return { secondsAgo, isStale, markFresh, label };
}
