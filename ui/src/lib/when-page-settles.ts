import type { QueryClient } from "@tanstack/react-query";

const IDLE_TIMEOUT_MS = 2_000;

/**
 * Run `start` once the page has painted, the tab is visible, no query is
 * fetching (the page's own reads have finished) and the browser is idle.
 * Returns a cancel function.
 */
export function whenPageSettles(queryClient: QueryClient, start: () => void) {
  const cleanups = new Set<() => void>();
  const add = (cleanup: () => void) => cleanups.add(cleanup);
  let done = false;
  const cancel = () => {
    done = true;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
  };
  const step = () => {
    if (done) return;
    for (const cleanup of cleanups) cleanup();
    cleanups.clear();
    if (document.visibilityState !== "visible") {
      const onVisible = () => { if (document.visibilityState === "visible") step(); };
      document.addEventListener("visibilitychange", onVisible);
      add(() => document.removeEventListener("visibilitychange", onVisible));
      return;
    }
    if (queryClient.isFetching() > 0) {
      add(queryClient.getQueryCache().subscribe(() => {
        if (queryClient.isFetching() === 0) step();
      }));
      return;
    }
    const run = () => {
      if (done) return;
      // Something started while waiting for idle time: wait for it as well.
      if (document.visibilityState !== "visible" || queryClient.isFetching() > 0) {
        step();
        return;
      }
      done = true;
      cleanups.clear();
      start();
    };
    if (typeof window.requestIdleCallback === "function") {
      const handle = window.requestIdleCallback(run, { timeout: IDLE_TIMEOUT_MS });
      add(() => window.cancelIdleCallback(handle));
    } else {
      const handle = window.setTimeout(run, 200);
      add(() => window.clearTimeout(handle));
    }
  };
  // Two frames: the page's primary content has painted.
  let second: number | undefined;
  const first = window.requestAnimationFrame(() => { second = window.requestAnimationFrame(step); });
  add(() => {
    window.cancelAnimationFrame(first);
    if (second !== undefined) window.cancelAnimationFrame(second);
  });
  return cancel;
}

