/**
 * React 19.2 emits a `performance.measure()` for (nearly) every component render
 * to populate its DevTools "Performance Tracks" (the entries carry
 * `detail.devtools` and are named after components). React never clears them, so
 * on a long-lived tab they accumulate into *millions* of native
 * `PerformanceMeasure` entries — gigabytes of memory that `performance.memory`
 * does not even report. On a busy Paperclip tab this was measured at ~340
 * measures/sec, reaching 12M+ entries after ~12h and dominating the tab's
 * footprint.
 *
 * Nothing in this app uses the User Timing API, so we periodically clear the
 * buffer. Confirmed live: a single `clearMeasures()` dropped a 12.4M-entry
 * buffer to ~1.5k and reclaimed the memory. We only clear measures (React's
 * tracks pass explicit start/end times and leave no marks), so mark-based timing
 * elsewhere is unaffected.
 *
 * Set `window.__paperclipKeepPerfMeasures = true` to keep them — e.g. while
 * recording a React Performance Track in the DevTools Performance panel.
 */
const DEFAULT_INTERVAL_MS = 10_000;

interface PerfMeasureReaperGlobal {
  __paperclipKeepPerfMeasures?: boolean;
}

export function startPerfMeasureReaper(intervalMs: number = DEFAULT_INTERVAL_MS): () => void {
  if (typeof performance === "undefined" || typeof performance.clearMeasures !== "function") {
    return () => {};
  }
  const reap = () => {
    if ((globalThis as PerfMeasureReaperGlobal).__paperclipKeepPerfMeasures) return;
    // clearMeasures() is cheap and does not materialize the (huge) buffer —
    // unlike getEntriesByType('measure'), so never call that to gate on size.
    performance.clearMeasures();
  };
  const id = setInterval(reap, intervalMs);
  return () => clearInterval(id);
}
