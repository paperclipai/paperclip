import { useEffect, useState } from "react";

/** The longest an idle start may wait on a busy page. */
export const IDLE_READY_TIMEOUT_MS = 2_000;

/**
 * False on mount, true once the browser first has idle time (or after
 * `timeoutMs`). Use it to start reads that never gate a page's first frame,
 * so they do not compete with the reads and rendering that do.
 */
export function useIdleReady(timeoutMs = IDLE_READY_TIMEOUT_MS) {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (ready) return;
    const run = () => setReady(true);
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: timeoutMs });
      return () => window.cancelIdleCallback(handle);
    }
    const timer = window.setTimeout(run, Math.min(timeoutMs, 200));
    return () => window.clearTimeout(timer);
  }, [ready, timeoutMs]);
  return ready;
}
