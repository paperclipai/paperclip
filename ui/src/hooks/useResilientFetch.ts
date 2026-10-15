/**
 * The read-resilience contract of `useQuery` for reads that cannot live in the
 * shared React Query cache.
 *
 * Some reads must stay in component memory: a bearer viewer URL, a pairing
 * code preview, an offset-based log page that is appended rather than
 * replaced, or a privileged load that is fenced by a permission epoch. Those
 * used to be hand-rolled `useEffect` fetches, each with its own idea of what a
 * failure means. This hook gives them the same behaviour the shared query
 * components already have:
 *
 * - The last good value is retained through a transient failure, so loaded
 *   content stays on screen while the connection banner explains the outage.
 * - Transient errors retry with the app's retry policy
 *   (`shouldRetryRequest` / `retryDelayFor` from `lib/query-client`). While the
 *   connectivity store reports an outage the fetch pauses instead of polling a
 *   down server, and it resumes by itself when the store recovers.
 * - Every error is classified with `classifyError`; a non-transient failure
 *   (403, 404, 409, validation, a real 500 after its brief retry) is surfaced
 *   as a real `error` for `useQueryView` / `<QueryErrorState>` to render.
 * - A result that arrives after its `key` changed, after the hook was
 *   disabled, or after `refetch` superseded it is dropped, so a stale response
 *   can never describe the current resource.
 *
 * Nothing here is written to a shared or persisted cache: the value lives in
 * this component's state and dies with it.
 *
 * The result is a `QueryViewSource`, so `useQueryView` and `<QueryView>` read
 * it the same way they read a `useQuery` result; `view` is provided for
 * convenience.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { classifyError, type ErrorKind } from "@/api/errors";
import { useQueryView, type QueryViewSource, type QueryViewState } from "@/components/QueryView";
import { useConnectivityStore } from "@/lib/connectivity";
import { retryDelayFor, shouldRetryRequest } from "@/lib/query-client";

export interface ResilientFetchOptions<TData> {
  /**
   * Identifies the resource, like a query key. When it changes the previous
   * value is dropped synchronously and any in-flight request is ignored.
   */
  key: readonly unknown[];
  /** Performs the read. The signal is aborted when the result is no longer wanted. */
  fetcher: (signal: AbortSignal) => Promise<TData>;
  /** `false` keeps the hook idle; the current value is kept. Defaults to `true`. */
  enabled?: boolean;
  /** Fetch again this many milliseconds after each settled attempt while enabled. */
  refetchInterval?: number | false;
  /**
   * Keep the last good value behind a non-transient error (the `useQuery`
   * default). `false` drops it, for values that a real error revokes: a bearer
   * URL after a 403 must not keep its iframe alive.
   */
  keepDataOnError?: boolean;
  /** Retry policy; defaults to the query client's `shouldRetryRequest`. */
  retry?: (failureCount: number, error: unknown) => boolean;
  /** Retry backoff; defaults to the query client's `retryDelayFor`. */
  retryDelay?: (failureCount: number, error: unknown) => number;
  /**
   * Called once for each successful attempt whose result is still current.
   * For reads that accumulate (an offset-based log page) this is where the
   * page is applied; `data` is only the latest page.
   */
  onSuccess?: (data: TData) => void;
}

export interface ResilientFetchResult<TData> extends QueryViewSource<TData> {
  /** The classification of `error`, or null when there is none. */
  errorKind: ErrorKind | null;
  isFetching: boolean;
  /** Waiting for the connectivity store to report the server reachable again. */
  isPaused: boolean;
  /** Bumped on every applied success; an effect can key off it. */
  dataUpdatedAt: number;
  /** Fetch again now, superseding any attempt in flight. */
  refetch: () => void;
  /** The view state for this read, from `useQueryView`. */
  view: QueryViewState<TData>;
}

interface FetchState<TData> {
  keyHash: string;
  data: TData | undefined;
  error: unknown;
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  failureReason: unknown;
  dataUpdatedAt: number;
}

function initialState<TData>(keyHash: string): FetchState<TData> {
  return {
    keyHash,
    data: undefined,
    error: null,
    status: "pending",
    fetchStatus: "idle",
    failureReason: undefined,
    dataUpdatedAt: 0,
  };
}

/** A stable hash of a key, like React Query's: object key order does not matter. */
export function hashFetchKey(key: readonly unknown[]): string {
  return JSON.stringify(key, (_, value) =>
    value && typeof value === "object" && !Array.isArray(value)
      ? Object.keys(value as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((sorted, name) => {
          sorted[name] = (value as Record<string, unknown>)[name];
          return sorted;
        }, {})
      : value,
  );
}

export function useResilientFetch<TData>(options: ResilientFetchOptions<TData>): ResilientFetchResult<TData> {
  const {
    key,
    enabled = true,
    refetchInterval = false,
    keepDataOnError = true,
    retry = shouldRetryRequest,
    retryDelay = retryDelayFor,
  } = options;
  const keyHash = hashFetchKey(key);
  const store = useConnectivityStore();
  const [state, setState] = useState<FetchState<TData>>(() => initialState<TData>(keyHash));

  // The latest options, so async completions and timers never see a stale closure.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  const policyRef = useRef({ enabled, refetchInterval, keepDataOnError, retry, retryDelay });
  policyRef.current = { enabled, refetchInterval, keepDataOnError, retry, retryDelay };

  /** Identifies the attempt whose result may still be applied. */
  const ticketRef = useRef(0);
  const controllerRef = useRef<AbortController | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const failureCountRef = useRef(0);
  const mountedRef = useRef(true);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  /** Forget any attempt in flight and any pending retry or poll. */
  const cancel = useCallback(() => {
    ticketRef.current += 1;
    clearTimer();
    const controller = controllerRef.current;
    controllerRef.current = null;
    controller?.abort();
    if (!mountedRef.current) return;
    setState((current) =>
      current.fetchStatus === "idle" && current.failureReason === undefined
        ? current
        : { ...current, fetchStatus: "idle", failureReason: undefined },
    );
  }, [clearTimer]);

  const beginRef = useRef<() => void>(() => undefined);

  const schedule = useCallback((delay: number) => {
    clearTimer();
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      beginRef.current();
    }, delay);
  }, [clearTimer]);

  const schedulePoll = useCallback(() => {
    const { refetchInterval: interval, enabled: isEnabled } = policyRef.current;
    if (!isEnabled || interval === false || !(interval > 0)) return;
    schedule(interval);
  }, [schedule]);

  const begin = useCallback(() => {
    clearTimer();
    controllerRef.current?.abort();
    if (!mountedRef.current) return;
    if (store.getSnapshot().status !== "online") {
      // An outage: the store's probe loop decides when the server is back,
      // and `onRecover` resumes this read. Polling a down server helps no one.
      controllerRef.current = null;
      setState((current) => (current.fetchStatus === "paused" ? current : { ...current, fetchStatus: "paused" }));
      return;
    }
    const ticket = ++ticketRef.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    setState((current) => (current.fetchStatus === "fetching" ? current : { ...current, fetchStatus: "fetching" }));

    let attempt: Promise<TData>;
    try {
      attempt = Promise.resolve(optionsRef.current.fetcher(controller.signal));
    } catch (error) {
      attempt = Promise.reject(error);
    }
    attempt.then(
      (data) => {
        if (ticket !== ticketRef.current || !mountedRef.current) return;
        controllerRef.current = null;
        failureCountRef.current = 0;
        setState((current) => ({
          ...current,
          data,
          error: null,
          status: "success",
          fetchStatus: "idle",
          failureReason: undefined,
          dataUpdatedAt: current.dataUpdatedAt + 1,
        }));
        store.reportSuccess();
        optionsRef.current.onSuccess?.(data);
        schedulePoll();
      },
      (error: unknown) => {
        if (ticket !== ticketRef.current || !mountedRef.current) return;
        controllerRef.current = null;
        const kind = classifyError(error);
        if (kind === "aborted") {
          // Not ours (ours changed the ticket): the caller withdrew the read.
          setState((current) => ({ ...current, fetchStatus: "idle", failureReason: undefined }));
          return;
        }
        store.reportError(error);
        // As in React Query: the count of failures before this one.
        const failureCount = failureCountRef.current;
        failureCountRef.current += 1;
        const policy = policyRef.current;
        if (policy.retry(failureCount, error)) {
          if (store.getSnapshot().status !== "online") {
            setState((current) => ({ ...current, failureReason: error, fetchStatus: "paused" }));
            return;
          }
          setState((current) => ({ ...current, failureReason: error, fetchStatus: "fetching" }));
          schedule(policy.retryDelay(failureCount, error));
          return;
        }
        failureCountRef.current = 0;
        const keepData = policy.keepDataOnError || kind === "transient";
        setState((current) => ({
          ...current,
          data: keepData ? current.data : undefined,
          error,
          status: "error",
          fetchStatus: "idle",
          failureReason: undefined,
        }));
        schedulePoll();
      },
    );
  }, [clearTimer, schedule, schedulePoll, store]);
  beginRef.current = begin;

  // A new key drops the old value at once: a stale response must never
  // describe the new resource, even for one render.
  const current = state.keyHash === keyHash ? state : initialState<TData>(keyHash);
  useEffect(() => {
    setState((previous) => (previous.keyHash === keyHash ? previous : initialState<TData>(keyHash)));
  }, [keyHash]);

  useEffect(() => {
    if (!enabled) return;
    failureCountRef.current = 0;
    begin();
    return cancel;
  }, [begin, cancel, enabled, keyHash]);

  // The store recovered from an outage: refetch, as `bindConnectivity` does
  // for every active query.
  useEffect(
    () =>
      store.onRecover(() => {
        if (!policyRef.current.enabled) return;
        failureCountRef.current = 0;
        begin();
      }),
    [begin, store],
  );

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      ticketRef.current += 1;
      clearTimer();
      controllerRef.current?.abort();
      controllerRef.current = null;
    };
  }, [clearTimer]);

  const refetch = useCallback(() => {
    failureCountRef.current = 0;
    begin();
  }, [begin]);

  const source: QueryViewSource<TData> = {
    data: current.data,
    error: current.error,
    status: current.status,
    fetchStatus: current.fetchStatus,
    failureReason: current.failureReason,
    refetch,
  };
  const view = useQueryView(source);

  return {
    ...source,
    errorKind: current.error === null || current.error === undefined ? null : classifyError(current.error),
    isFetching: current.fetchStatus === "fetching",
    isPaused: current.fetchStatus === "paused",
    dataUpdatedAt: current.dataUpdatedAt,
    refetch,
    view,
  };
}
