import { getPageVisibility } from "./page-visibility";
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

/**
 * Minimum time between two flushes of the ambient lane. Company-wide lists and
 * projections (sidebar task summaries, the agent list, issue lists, badges)
 * change on almost every run or task event in a busy company. After the lane
 * has been quiet for this interval, an event refreshes them within one normal
 * batch. An event inside the interval waits until the interval ends, so the
 * lane flushes at most once per interval instead of on every batch.
 */
export const AMBIENT_INVALIDATION_SPACING_MS = 5_000;

export function createInvalidationBatcher(
  queryClient: Pick<QueryClient, "invalidateQueries">,
  intervalMs: number = DEFAULT_INVALIDATION_INTERVAL_MS,
  options: { minSpacingMs?: number } = {},
): InvalidationBatcher {
  const minSpacingMs = options.minSpacingMs ?? 0;
  // Start of the last flush that sent invalidations; spacing counts from it.
  let lastFlushAt = Number.NEGATIVE_INFINITY;
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
    const filtersList = removeCoveredFilters([...pending.values()]);
    pending.clear();
    lastFlushAt = Date.now();
    try {
      await Promise.all(filtersList.map((filters) => queryClient.invalidateQueries(
        getPageVisibility().visible ? filters : { ...filters, refetchType: "none" },
      )));
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
      // Leading edge: a quiet lane flushes after the normal batch interval.
      // Trailing edge: a busy lane waits until its spacing has elapsed.
      const delay = Math.max(intervalMs, lastFlushAt + minSpacingMs - Date.now());
      timer = setTimeout(() => void flush(), delay);
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

const EXCLUDED_QUERY_KEYS = Symbol("excludedQueryKeys");
type QueryKeyPrefix = readonly unknown[];
type ExclusionPredicate = ((query: { queryKey: readonly unknown[] }) => boolean) & {
  [EXCLUDED_QUERY_KEYS]: readonly QueryKeyPrefix[];
};

function startsWithKey(key: readonly unknown[], prefix: QueryKeyPrefix): boolean {
  if (prefix.length > key.length) return false;
  return prefix.every((part, index) => JSON.stringify(part) === JSON.stringify(key[index]));
}

/**
 * A `predicate` that skips queries under the given key prefixes. Unlike an
 * arbitrary predicate, the batcher can read its exclusions, so repeated
 * invalidations with the same key and exclusions still coalesce into one, and
 * the filter still covers its non-excluded children in the same batch.
 */
export function excludingQueryKeys(...excluded: QueryKeyPrefix[]): ExclusionPredicate {
  const predicate = ((query: { queryKey: readonly unknown[] }) =>
    !excluded.some((prefix) => startsWithKey(query.queryKey, prefix))) as ExclusionPredicate;
  predicate[EXCLUDED_QUERY_KEYS] = excluded;
  return predicate;
}

function readExclusions(filters: InvalidateQueryFilters): readonly QueryKeyPrefix[] | null {
  const predicate = filters.predicate as Partial<ExclusionPredicate> | undefined;
  if (typeof predicate !== "function") return [];
  return predicate[EXCLUDED_QUERY_KEYS] ?? null;
}

function filterBehaviorKey(filters: InvalidateQueryFilters): string {
  return JSON.stringify([
    filters.type ?? "all",
    filters.refetchType ?? filters.type ?? "active",
    filters.stale ?? null,
    filters.fetchStatus ?? null,
  ]);
}

/** A collection prefix already refreshes its children in the same batch. */
function removeCoveredFilters(filters: InvalidateQueryFilters[]): InvalidateQueryFilters[] {
  // Each prefix keeps the exclusions of every filter that names it; a plain
  // prefix has none.
  const prefixesByBehavior = new Map<string, Map<string, Array<readonly QueryKeyPrefix[]>>>();
  const isScalar = (value: unknown) => value === null || typeof value === "string"
    || typeof value === "boolean" || typeof value === "number" && Number.isFinite(value);
  for (const filter of filters) {
    const exclusions = readExclusions(filter);
    if (!exclusions || filter.exact || !filter.queryKey?.every(isScalar)) continue;
    const behavior = filterBehaviorKey(filter);
    const prefixes = prefixesByBehavior.get(behavior) ?? new Map<string, Array<readonly QueryKeyPrefix[]>>();
    const keyJson = JSON.stringify(filter.queryKey);
    prefixes.set(keyJson, [...(prefixes.get(keyJson) ?? []), exclusions]);
    prefixesByBehavior.set(behavior, prefixes);
  }
  return filters.filter(filter => {
    const ownExclusions = readExclusions(filter);
    if (!ownExclusions || !filter.queryKey) return true;
    const prefixes = prefixesByBehavior.get(filterBehaviorKey(filter));
    if (!prefixes) return true;
    const key = filter.queryKey;
    // An excluded subtree overlapping this filter's subtree is not refreshed by
    // the covering prefix, so that prefix does not cover this filter.
    const coveredBy = (exclusions: readonly QueryKeyPrefix[]) =>
      !exclusions.some((excluded) => startsWithKey(key, excluded) || (!filter.exact && startsWithKey(excluded, key)));
    // A non-exact filter covers itself, so only check its shorter prefixes.
    // A filter with exclusions is also covered by a plain filter on its own key.
    const hasExclusions = ownExclusions.length > 0;
    const last = filter.exact || hasExclusions ? key.length : key.length - 1;
    for (let length = 0; length <= last; length += 1) {
      if (length > 0 && !isScalar(key[length - 1])) break;
      const entries = prefixes.get(JSON.stringify(key.slice(0, length)));
      const sameKeyNonExact = length === key.length && !filter.exact;
      if (entries?.some((exclusions) => sameKeyNonExact ? exclusions.length === 0 : coveredBy(exclusions))) return false;
    }
    return true;
  });
}

function serializeFilters(filters: InvalidateQueryFilters): string {
  // A predicate is an opaque function — two predicate-based filters can never be
  // proven equal, so never coalesce them (that would silently drop one). Give
  // each its own key.
  const exclusions = readExclusions(filters);
  if (exclusions === null) {
    return `__predicate__:${(uniqueFilterCounter += 1)}`;
  }
  // Query selection and refetch behavior both belong to the identity. In
  // particular, dropping an idle/fresh filter in favor of a paused/stale one
  // can lose the only refresh that actually matches a cached query.
  try {
    return JSON.stringify([
      filters.queryKey ?? null,
      filterBehaviorKey(filters),
      filters.exact ?? false,
      ...(exclusions.length > 0 ? [{ excluding: exclusions }] : []),
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

/**
 * Route invalidations to one of two batchers by query key. `isAmbient` selects
 * the slower lane (see `AMBIENT_INVALIDATION_SPACING_MS`). Every other filter,
 * including one without a query key, uses the fast lane.
 */
export function createLaneRoutingBatcher(
  fast: InvalidationBatcher,
  ambient: InvalidationBatcher,
  isAmbient: (queryKey: readonly unknown[]) => boolean,
): InvalidationBatcher {
  return {
    schedule: (filters) => (filters.queryKey && isAmbient(filters.queryKey) ? ambient : fast).schedule(filters),
    flush: async () => {
      await Promise.all([fast.flush(), ambient.flush()]);
    },
    dispose: () => {
      fast.dispose();
      ambient.dispose();
    },
  };
}
