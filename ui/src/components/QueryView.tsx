/**
 * One way to render a read.
 *
 * Every surface that shows the result of a `useQuery` faces the same question
 * during a deploy or a gateway blip: the refetch failed, but the data is still
 * in the cache. The answer is always the same, so it lives here:
 *
 * - **If data exists, render the data.** A transient failure with data is
 *   `stale`: a normal render, with an optional small "Updating paused" hint
 *   and no red text. The app-level connection banner explains the outage.
 * - An outage with no data is `reconnecting`: a skeleton or a muted
 *   placeholder that fills in by itself when the server is back.
 * - A non-transient failure (403, 404, validation, conflict, a real 500) is
 *   `error`: readable `describeError` copy with a Retry button. So is a
 *   transient failure with no data once the retry policy has given up while
 *   the server is reachable (a 429, one plugin worker restarting, a 504 on
 *   one slow route): the app-wide probe loop is not running, so nothing else
 *   would refetch it.
 * - A `not_found` state is shown only when `classifyError` says `not_found`,
 *   never for an outage.
 *
 * `useQueryView(query)` returns the state; `<QueryView>` renders it with
 * sensible defaults; `<QueryErrorState>` is the error presentation on its own,
 * for surfaces that keep their own loading and empty states.
 */

import { useCallback, type ReactNode } from "react";
import { AlertTriangle, RefreshCcw } from "lucide-react";
import { classifyError, describeError, isTransientError, type ErrorKind } from "@/api/errors";
import { PageSkeleton } from "@/components/PageSkeleton";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useConnectivity, useConnectivityStore, type ConnectivityStatus } from "@/lib/connectivity";
import { cn } from "@/lib/utils";

export type QueryViewKind = "loading" | "ready" | "stale" | "reconnecting" | "error";

export type QueryViewSize = "page" | "panel" | "inline";

/** The slice of a React Query result the view logic reads. */
export interface QueryViewSource<TData> {
  data: TData | undefined;
  error: unknown;
  /** `pending` until the first data arrives (also while disabled). */
  status: "pending" | "error" | "success";
  fetchStatus: "fetching" | "paused" | "idle";
  /** The error of the attempt currently being retried, before `error` is set. */
  failureReason?: unknown;
  refetch: () => unknown;
}

export interface QueryViewState<TData> {
  kind: QueryViewKind;
  /** The latest data, including cached data behind a `stale` or `error` kind. */
  data: TData | undefined;
  error: unknown;
  /** The classification of `error` when `kind` is `error`, otherwise null. */
  errorKind: ErrorKind | null;
  /** Fetch again now; during an outage it also probes the server at once. */
  retry: () => void;
  isFetching: boolean;
}

function hasError(value: unknown): boolean {
  return value !== null && value !== undefined;
}

/**
 * Which of the five states a query is in. Pure, so plugin hooks and tests can
 * use it without React. `connectivity` is the app-wide connection status; a
 * query with data is `stale` while the server is unreachable even before its
 * own refetch fails.
 */
export function queryViewKind(
  query: Pick<QueryViewSource<unknown>, "data" | "error" | "status" | "fetchStatus" | "failureReason">,
  connectivity: ConnectivityStatus = "online",
): QueryViewKind {
  const hasData = query.data !== undefined;
  if (hasError(query.error)) {
    const transient = isTransientError(query.error);
    if (hasData) return transient ? "stale" : "error";
    // With nothing to show, a transient failure is worth waiting out quietly
    // only while the app-wide probe loop is running: it refetches every live
    // query on recovery. While the server is reachable nothing else would
    // refetch, so a route that keeps failing (a 429, one plugin worker
    // restarting, a 504 on one slow endpoint) gets readable copy with a
    // Retry button once the retry policy gives up.
    if (transient && connectivity !== "online") return "reconnecting";
    return "error";
  }
  const retryingTransient = hasError(query.failureReason) && isTransientError(query.failureReason);
  if (hasData) {
    return query.fetchStatus === "paused" || retryingTransient || connectivity !== "online" ? "stale" : "ready";
  }
  if (query.fetchStatus === "paused" || retryingTransient) return "reconnecting";
  if (connectivity !== "online" && query.fetchStatus === "fetching") return "reconnecting";
  return "loading";
}

/** The view state for a query result, plus a retry that also wakes the connectivity probe. */
export function useQueryView<TData>(query: QueryViewSource<TData>): QueryViewState<TData> {
  const { status: connectivity } = useConnectivity();
  const store = useConnectivityStore();
  const { refetch } = query;
  const retry = useCallback(() => {
    if (store.getSnapshot().status !== "online") store.probeNow();
    void refetch();
  }, [store, refetch]);
  const kind = queryViewKind(query, connectivity);
  return {
    kind,
    data: query.data,
    error: query.error ?? null,
    errorKind: kind === "error" ? classifyError(query.error) : null,
    retry,
    isFetching: query.fetchStatus === "fetching",
  };
}

// --- Presentation -----------------------------------------------------------------

export interface QueryErrorStateProps {
  error: unknown;
  size?: QueryViewSize;
  /** What the user was doing, as a verb phrase: "load the task". */
  action?: string;
  onRetry?: () => void;
  /** Disables the Retry button while a retry is in flight. */
  retrying?: boolean;
  className?: string;
}

/** Errors a retry cannot fix: the Retry button is left out. */
const NOT_RETRYABLE: ReadonlySet<ErrorKind> = new Set(["auth", "forbidden", "not_found"]);

/**
 * The standard presentation of a non-transient query error: readable copy
 * from `describeError` and a Retry button. Never renders a raw error code.
 */
export function QueryErrorState({ error, size = "panel", action, onRetry, retrying = false, className }: QueryErrorStateProps) {
  const kind = classifyError(error);
  const { title, body } = describeError(error, { action });
  const retryButton = onRetry && !NOT_RETRYABLE.has(kind) ? (
    <Button
      type="button"
      variant="outline"
      size={size === "page" ? "sm" : "xs"}
      onClick={onRetry}
      disabled={retrying}
    >
      <RefreshCcw aria-hidden="true" className={cn(retrying && "animate-spin")} />
      {retrying ? "Retrying…" : "Retry"}
    </Button>
  ) : null;

  if (size === "inline") {
    return (
      <span role="alert" data-query-view="error" className={cn("inline-flex flex-wrap items-center gap-2 text-sm text-muted-foreground", className)}>
        <span>{body}</span>
        {retryButton}
      </span>
    );
  }

  if (size === "page") {
    return (
      <div role="alert" data-query-view="error" className={cn("mx-auto flex max-w-md flex-col items-center gap-3 py-16 text-center", className)}>
        <AlertTriangle aria-hidden="true" className="size-6 text-muted-foreground" />
        <div className="space-y-1">
          <p className="text-sm font-medium text-foreground">{title}</p>
          <p className="text-sm text-muted-foreground">{body}</p>
        </div>
        {retryButton}
      </div>
    );
  }

  return (
    <div
      role="alert"
      data-query-view="error"
      className={cn("flex items-start gap-3 rounded-md border border-border bg-muted/40 px-3 py-3 text-sm", className)}
    >
      <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="space-y-0.5">
          <p className="font-medium text-foreground">{title}</p>
          <p className="text-muted-foreground">{body}</p>
        </div>
        {retryButton ? <div>{retryButton}</div> : null}
      </div>
    </div>
  );
}

export interface QueryPlaceholderProps {
  size?: QueryViewSize;
  /** Accessible label for the busy region. */
  label?: string;
  className?: string;
}

/** A quiet placeholder for `loading` and `reconnecting`: it fills in by itself. */
export function QueryPlaceholder({ size = "panel", label = "Loading", className }: QueryPlaceholderProps) {
  if (size === "page") {
    return (
      <div role="status" aria-busy="true" aria-label={label} data-query-view="placeholder" className={className}>
        <PageSkeleton variant="detail" />
      </div>
    );
  }
  if (size === "inline") {
    return (
      <span role="status" aria-busy="true" aria-label={label} data-query-view="placeholder" className={cn("inline-flex", className)}>
        <Skeleton className="h-4 w-24" />
      </span>
    );
  }
  return (
    <div role="status" aria-busy="true" aria-label={label} data-query-view="placeholder" className={cn("space-y-2 py-1", className)}>
      <Skeleton className="h-4 w-2/3" />
      <Skeleton className="h-4 w-full" />
      <Skeleton className="h-4 w-1/2" />
    </div>
  );
}

/** The small hint above stale content, for surfaces that opt in with `staleHint`. */
export function QueryStaleHint({ className }: { className?: string }) {
  return (
    <p role="status" data-query-view="stale" className={cn("text-xs text-muted-foreground", className)}>
      Updating paused while reconnecting…
    </p>
  );
}

export interface QueryViewProps<TData> {
  query: QueryViewSource<TData>;
  size?: QueryViewSize;
  /** What the user was doing, for error copy: "load the task". */
  action?: string;
  /** Shown while loading with no data. Defaults to a placeholder for the size. */
  loading?: ReactNode;
  /** Shown while reconnecting with no data. Defaults to `loading`. */
  reconnecting?: ReactNode;
  /** Shown when the error is a real `not_found`. Defaults to the error state. */
  notFound?: ReactNode;
  /** Show a small "Updating paused" hint above stale content. Off by default. */
  staleHint?: boolean;
  className?: string;
  children: (data: TData, view: QueryViewState<TData>) => ReactNode;
}

/**
 * Render a query by its view state. Loaded data always renders, even while a
 * refetch is failing; placeholders are quiet; only real errors show an error.
 */
export function QueryView<TData>({
  query,
  size = "panel",
  action,
  loading,
  reconnecting,
  notFound,
  staleHint = false,
  className,
  children,
}: QueryViewProps<TData>) {
  const view = useQueryView(query);
  switch (view.kind) {
    case "loading":
      return <>{loading ?? <QueryPlaceholder size={size} className={className} />}</>;
    case "reconnecting":
      return <>{reconnecting ?? loading ?? <QueryPlaceholder size={size} label="Reconnecting" className={className} />}</>;
    case "error":
      if (view.errorKind === "not_found" && notFound !== undefined) return <>{notFound}</>;
      return (
        <QueryErrorState
          error={view.error}
          size={size}
          action={action}
          onRetry={view.retry}
          retrying={view.isFetching}
          className={className}
        />
      );
    case "stale":
      return (
        <>
          {staleHint ? <QueryStaleHint /> : null}
          {children(view.data as TData, view)}
        </>
      );
    case "ready":
      return <>{children(view.data as TData, view)}</>;
  }
}
