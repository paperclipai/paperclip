import type { InvalidateQueryFilters, QueryClient } from "@tanstack/react-query";

/**
 * Coalesces React Query invalidations triggered by the live-events stream.
 *
 * `LiveUpdatesProvider` used to call `queryClient.invalidateQueries(...)`
 * synchronously for every websocket event. During an active agent run these
 * fire many times per second, and each invalidation cascades into refetches
 * and re-renders — the dominant source of steady-state CPU churn (and, over a
 * long-lived tab, off-heap allocation growth).
 *
 * The batcher collects invalidation filters over a short window, de-duplicates
 * identical ones, and flushes them in a single pass at most once per interval.
 * A trailing-throttle (not a pure debounce) is used deliberately: during a
 * continuous event stream a pure debounce would never flush, so UI updates
 * would stall; throttling guarantees the buffered invalidations flush every
 * `intervalMs`.
 */
export interface InvalidationBatcher {
  /** Schedule an invalidation; resolves once the batched flush has run. */
  schedule: (filters: InvalidateQueryFilters) => Promise<void>;
  /** Flush any buffered invalidations immediately (e.g. before teardown). */
  flush: () => Promise<void>;
  dispose: () => void;
}

export const DEFAULT_INVALIDATION_INTERVAL_MS = 300;

type Deferred = { promise: Promise<void>; resolve: () => void };

function createDeferred(): Deferred {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

export function createInvalidationBatcher(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  intervalMs: number = DEFAULT_INVALIDATION_INTERVAL_MS,
): InvalidationBatcher {
  // Keyed by a stable serialization of the filters so repeated invalidations of
  // the same key (the common case) collapse to one entry.
  const pending = new Map<string, InvalidateQueryFilters>();
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Resolves when the currently-buffered window has been flushed. `schedule`
  // hands this back so callers that await it observe the real invalidation.
  let windowDeferred: Deferred | null = null;

  const flush = async (): Promise<void> => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    const deferred = windowDeferred;
    windowDeferred = null;
    if (pending.size === 0) {
      deferred?.resolve();
      return;
    }
    const filtersList = [...pending.values()];
    pending.clear();
    try {
      await Promise.all(filtersList.map((filters) => queryClient.invalidateQueries(filters)));
    } finally {
      deferred?.resolve();
    }
  };

  const schedule = (filters: InvalidateQueryFilters): Promise<void> => {
    pending.set(serializeFilters(filters), filters);
    if (windowDeferred === null) {
      windowDeferred = createDeferred();
    }
    if (timer === null) {
      timer = setTimeout(() => void flush(), intervalMs);
    }
    return windowDeferred.promise;
  };

  const dispose = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
    // Release any awaiters so they don't hang forever after teardown.
    windowDeferred?.resolve();
    windowDeferred = null;
  };

  return { schedule, flush, dispose };
}

let uniqueFilterCounter = 0;

function serializeFilters(filters: InvalidateQueryFilters): string {
  // A predicate is an opaque function — two predicate-based filters can never be
  // proven equal, so never coalesce them (that would silently drop one). Give
  // each its own key.
  if (typeof filters.predicate === "function") {
    return `__predicate__:${(uniqueFilterCounter += 1)}`;
  }
  // queryKey drives the identity; refetchType/exact/type change the behavior, so
  // keep them distinct while still collapsing exact repeats.
  try {
    return JSON.stringify([
      filters.queryKey ?? null,
      filters.refetchType ?? null,
      filters.exact ?? null,
      filters.type ?? null,
    ]);
  } catch {
    // Non-serializable filter (shouldn't happen for our query keys) — fall back
    // to a unique key so it is never dropped.
    return `__nonserializable__:${(uniqueFilterCounter += 1)}`;
  }
}

/**
 * Wrap a QueryClient so `invalidateQueries` is routed through `batcher` while
 * every other method (reads, `setQueryData`, …) passes straight through to the
 * real client. Returned value is a `QueryClient` and can be used anywhere one
 * is expected. Private class fields keep working because methods are bound to
 * the real client via `Reflect.get(target, prop, target)`.
 *
 * The batched `invalidateQueries` returns a promise that resolves only after the
 * flush actually runs, so callers that await it still observe completion.
 */
export function createCoalescingQueryClient(
  queryClient: QueryClient,
  batcher: InvalidationBatcher,
): QueryClient {
  return new Proxy(queryClient, {
    get(target, prop) {
      if (prop === "invalidateQueries") {
        return (filters?: InvalidateQueryFilters) => batcher.schedule(filters ?? {});
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
