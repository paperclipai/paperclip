/**
 * Live agent-run transcript viewers stream stdout/stderr and structured events
 * for the entire lifetime of a run — which can be hours. The viewer keeps every
 * streamed line/event in React state and renders each into a rich DOM block, so
 * an unbounded buffer becomes an unbounded live DOM tree: the tab's memory
 * footprint climbs into the multi-GB range even while the JS heap stays small
 * (the cost is in retained render objects and GPU layers, not JS objects).
 *
 * These caps bound the *live* tail retained in memory. Older output is not lost:
 * it stays in the persisted run log on the server and remains reachable for
 * terminated runs through the "Load more log" pagination, which is not subject
 * to these caps.
 */
export const MAX_LIVE_LOG_LINES = 5_000;
export const MAX_LIVE_EVENTS = 2_000;

/**
 * Number of transcript blocks the live "nice" view mounts. Terminated runs
 * render in full so explicitly paginated history stays visible; live runs tail
 * the stream, so mounting only the most recent blocks keeps the DOM (and its
 * off-heap render memory) bounded no matter how long the run streams.
 */
export const LIVE_TRANSCRIPT_RENDER_LIMIT = 1_500;

/**
 * Append `additions` to `prev`, dropping the oldest entries so the result never
 * exceeds `max`. Returns `prev` unchanged when there is nothing to add, so React
 * state setters can bail out of a re-render, and never mutates its inputs.
 */
export function appendCapped<T>(prev: T[], additions: readonly T[], max: number): T[] {
  if (additions.length === 0) return prev;
  const next = [...prev, ...additions];
  return next.length > max ? next.slice(next.length - max) : next;
}
