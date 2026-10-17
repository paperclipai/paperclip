/**
 * The app's React Query client and its outage-aware defaults.
 *
 * - Queries retry transient errors with backoff for about 30 seconds and never
 *   retry a 4xx. `networkMode: "online"` plus `bindConnectivity` means a
 *   confirmed outage pauses queries instead of failing them.
 * - Mutations fail fast by default (`networkMode: "always"`, no retry). A
 *   mutation that is safe to send twice opts in with
 *   `meta: { replay: "idempotent" }`: it pauses while the server is
 *   unreachable, retries transient errors, and resumes on reconnect.
 * - `QueryCache`/`MutationCache` events feed the connectivity store; final
 *   query errors go to Sentry unless they are transient or client errors.
 * - A mutation with `meta: { errorToast: true }` and no `onError` of its own
 *   gets a readable toast when it fails. Transient failures skip the toast
 *   while the connection banner covers them.
 */

import {
  MutationCache,
  QueryCache,
  QueryClient,
  onlineManager,
  type DefaultError,
  type Mutation,
  type MutationOptions,
  type QueryClientConfig,
} from "@tanstack/react-query";
import { classifyError, describeError, errorRetryAfterMs, isTransientError } from "@/api/errors";
import { MAX_PROBE_DELAY_MS, PROBE_BACKOFF_MS, type ConnectivityStore } from "./connectivity";

export interface AppMutationMeta extends Record<string, unknown> {
  /**
   * `"idempotent"`: sending this mutation twice has the same effect as once
   * (an absolute-value PATCH, a POST with an idempotency key). It may pause
   * across an outage and resend on reconnect.
   */
  replay?: "idempotent";
  /**
   * `true` shows the global readable error toast when this mutation has no
   * `onError` of its own. Opt-in because many surfaces already render
   * `mutation.error` inline, and a default toast would say it twice.
   */
  errorToast?: true;
}

declare module "@tanstack/react-query" {
  interface Register {
    mutationMeta: AppMutationMeta;
  }
}

/** Delay before each transient retry; together roughly 30 seconds. */
export const TRANSIENT_RETRY_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 15_000] as const;
/** Unexpected failures (5xx other than gateway errors, parse errors) retry briefly. */
export const UNKNOWN_RETRY_LIMIT = 2;

/** Retry policy shared by queries and replayable mutations. */
export function shouldRetryRequest(failureCount: number, error: unknown): boolean {
  const kind = classifyError(error);
  if (kind === "transient") return failureCount < TRANSIENT_RETRY_DELAYS_MS.length;
  if (kind === "unknown") return failureCount < UNKNOWN_RETRY_LIMIT;
  return false;
}

/**
 * Backoff for `shouldRetryRequest`; a longer server `Retry-After` wins. It is
 * not shortened: retrying before the server's window ends only fails again.
 * `parseRetryAfter` already bounds it.
 */
export function retryDelayFor(failureCount: number, error: unknown): number {
  const base = TRANSIENT_RETRY_DELAYS_MS[Math.min(failureCount, TRANSIENT_RETRY_DELAYS_MS.length - 1)];
  const retryAfterMs = errorRetryAfterMs(error);
  return retryAfterMs === null ? base : Math.max(base, retryAfterMs);
}

/**
 * For reads the app cannot open without (the access gate): retry transient
 * errors without limit, never anything else. Retries pause while the
 * connectivity store reports an outage, so this does not poll a down server.
 */
export function retryWhileTransient(_failureCount: number, error: unknown): boolean {
  return isTransientError(error);
}

/**
 * For the few reads that must fail fast: retry a transient error at most
 * `limit` times (`0` never retries) and never anything else. Prefer this over
 * `retry: false` so the call site says why it opts out of the default policy.
 */
export function retryTransientOnly(limit: number): (failureCount: number, error: unknown) => boolean {
  return (failureCount, error) => isTransientError(error) && failureCount < limit;
}

/** Backoff for `retryWhileTransient`: the connectivity probe schedule, capped at 15s. */
export function reconnectDelayFor(failureCount: number, error: unknown): number {
  const base = PROBE_BACKOFF_MS[Math.min(failureCount, PROBE_BACKOFF_MS.length - 1)];
  const retryAfterMs = errorRetryAfterMs(error);
  return retryAfterMs === null ? base : Math.min(Math.max(base, retryAfterMs), MAX_PROBE_DELAY_MS);
}

/** Query errors worth a Sentry event: not outages, not denials or missing items. */
export function shouldReportQueryError(error: unknown): boolean {
  return classifyError(error) === "unknown";
}

export interface MutationErrorToast {
  title: string;
  body: string;
}

export interface AppQueryClientDeps {
  connectivity: Pick<ConnectivityStore, "reportError" | "reportSuccess" | "getSnapshot">;
  reportError?: (error: unknown) => void;
  /** Show a toast for a failed opted-in mutation that has no handler of its own. */
  notifyMutationError?: (toast: MutationErrorToast) => void;
}

/**
 * Whether the global handler should toast for this failed mutation. A
 * transient failure is skipped only while the connection banner covers it; a
 * 429 or one route's worker being down leaves the app online, and the write is
 * still lost.
 */
export function shouldToastMutationError(
  error: unknown,
  mutation: Pick<Mutation<unknown, DefaultError, unknown, unknown>, "options" | "meta">,
  connectionDown: boolean,
): boolean {
  if (mutation.options.onError) return false;
  if (mutation.meta?.errorToast !== true) return false;
  const kind = classifyError(error);
  if (kind === "aborted") return false;
  return kind !== "transient" || !connectionDown;
}

class AppQueryClient extends QueryClient {
  override defaultMutationOptions<T extends MutationOptions<any, any, any, any>>(options?: T): T {
    const defaulted = super.defaultMutationOptions(options);
    if (options?._defaulted || defaulted.meta?.replay !== "idempotent") return defaulted;
    return {
      ...defaulted,
      networkMode: options?.networkMode ?? "online",
      retry: options?.retry ?? shouldRetryRequest,
      retryDelay: options?.retryDelay ?? retryDelayFor,
    };
  }
}

/** A polling query that keeps failing reports once per window, not on every poll. */
const QUERY_ERROR_REPORT_WINDOW_MS = 10 * 60_000;

export function createAppQueryClient(deps: AppQueryClientDeps, config: QueryClientConfig = {}): QueryClient {
  const lastReportedAt = new Map<string, number>();
  const queryCache = new QueryCache({
    onError: (error, query) => {
      if (!deps.reportError || !shouldReportQueryError(error)) return;
      const now = Date.now();
      const last = lastReportedAt.get(query.queryHash);
      if (last !== undefined && now - last < QUERY_ERROR_REPORT_WINDOW_MS) return;
      lastReportedAt.set(query.queryHash, now);
      deps.reportError(error);
    },
  });
  const mutationCache = new MutationCache({
    onError: (error, _variables, _context, mutation) => {
      const connectionDown = deps.connectivity.getSnapshot().status !== "online";
      if (!deps.notifyMutationError || !shouldToastMutationError(error, mutation, connectionDown)) return;
      const { title, body } = describeError(error);
      deps.notifyMutationError({ title, body });
    },
  });

  // Retry failures are only visible as cache events, and connectivity needs
  // the first failure, not the last one.
  queryCache.subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.action.type === "failed" || event.action.type === "error") deps.connectivity.reportError(event.action.error);
    // `setQueryData` (optimistic and live-event writes) dispatches a manual
    // success that never touched the server; only fetched data proves reachability.
    else if (event.action.type === "success" && !event.action.manual) deps.connectivity.reportSuccess();
  });
  mutationCache.subscribe((event) => {
    if (event.type !== "updated") return;
    if (event.action.type === "failed" || event.action.type === "error") deps.connectivity.reportError(event.action.error);
    else if (event.action.type === "success") deps.connectivity.reportSuccess();
  });

  return new AppQueryClient({
    ...config,
    queryCache,
    mutationCache,
    defaultOptions: {
      ...config.defaultOptions,
      queries: {
        retry: shouldRetryRequest,
        retryDelay: retryDelayFor,
        networkMode: "online",
        ...config.defaultOptions?.queries,
      },
      mutations: {
        networkMode: "always",
        retry: 0,
        ...config.defaultOptions?.mutations,
      },
    },
  });
}

/** `setPendingWrites` source for replayable mutations paused by an outage. */
export const PAUSED_MUTATIONS_SOURCE = "paused-mutations";

/**
 * Drive React Query's `onlineManager` from the connectivity store, refresh
 * live queries once when the server comes back, and count paused replayable
 * mutations as pending writes. Returns a cleanup.
 */
export function bindConnectivity(queryClient: QueryClient, store: ConnectivityStore): () => void {
  const isOnline = () => store.getSnapshot().status === "online";
  onlineManager.setEventListener((setOnline) => {
    setOnline(isOnline());
    return store.subscribe(() => setOnline(isOnline()));
  });
  const stopRecover = store.onRecover(() => {
    void queryClient.invalidateQueries({ type: "active" }, { cancelRefetch: false });
  });
  const mutationCache = queryClient.getMutationCache();
  const reportPausedMutations = () => {
    const paused = mutationCache.findAll({ predicate: (mutation) => mutation.state.isPaused }).length;
    store.setPendingWrites(PAUSED_MUTATIONS_SOURCE, paused);
  };
  reportPausedMutations();
  const stopMutationCount = mutationCache.subscribe(reportPausedMutations);
  const stopBrowserEvents = store.start();
  return () => {
    stopRecover();
    stopMutationCount();
    store.setPendingWrites(PAUSED_MUTATIONS_SOURCE, 0);
    stopBrowserEvents();
  };
}
