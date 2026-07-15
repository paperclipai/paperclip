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
  schedule: (filters: InvalidateQueryFilters) => void;
  /** Flush any buffered invalidations immediately (e.g. before teardown). */
  flush: () => void;
  dispose: () => void;
}

export const DEFAULT_INVALIDATION_INTERVAL_MS = 300;

export function createInvalidationBatcher(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  intervalMs: number = DEFAULT_INVALIDATION_INTERVAL_MS,
): InvalidationBatcher {
  // Keyed by a stable serialization of the filters so repeated invalidations of
  // the same key (the common case) collapse to one entry.
  const pending = new Map<string, InvalidateQueryFilters>();
  let timer: ReturnType<typeof setTimeout> | null = null;

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    if (pending.size === 0) return;
    const filtersList = [...pending.values()];
    pending.clear();
    for (const filters of filtersList) {
      void queryClient.invalidateQueries(filters);
    }
  };

  const schedule = (filters: InvalidateQueryFilters) => {
    pending.set(serializeFilters(filters), filters);
    if (timer === null) {
      timer = setTimeout(flush, intervalMs);
    }
  };

  const dispose = () => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
    pending.clear();
  };

  return { schedule, flush, dispose };
}

function serializeFilters(filters: InvalidateQueryFilters): string {
  // queryKey drives the identity; refetchType/exact change the behavior, so
  // keep them distinct while still collapsing exact repeats.
  try {
    return JSON.stringify([filters.queryKey ?? null, filters.refetchType ?? null, filters.exact ?? null]);
  } catch {
    // Non-serializable filter (shouldn't happen for our query keys) — fall back
    // to a unique key so it is never dropped.
    return `__nonserializable__:${Math.random()}`;
  }
}

/**
 * Wrap a QueryClient so `invalidateQueries` is routed through `batcher` while
 * every other method (reads, `setQueryData`, …) passes straight through to the
 * real client. Returned value is a `QueryClient` and can be used anywhere one
 * is expected. Private class fields keep working because methods are bound to
 * the real client via `Reflect.get(target, prop, target)`.
 */
export function createCoalescingQueryClient(
  queryClient: QueryClient,
  batcher: InvalidationBatcher,
): QueryClient {
  return new Proxy(queryClient, {
    get(target, prop) {
      if (prop === "invalidateQueries") {
        return (filters?: InvalidateQueryFilters) => {
          batcher.schedule(filters ?? {});
          return Promise.resolve();
        };
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}
