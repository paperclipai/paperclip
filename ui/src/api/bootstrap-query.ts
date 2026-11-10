import { useLayoutEffect } from "react";
import { hashKey, useQuery, useQueryClient, type QueryClient, type UseQueryOptions } from "@tanstack/react-query";

const appliedSnapshots = new WeakMap<QueryClient, Map<string, object>>();

/** Apply each canonical session snapshot once, including when its account has cached reads. */
export function useBootstrapQuery<TData>(
  options: UseQueryOptions<TData>,
  snapshot: { identity: object; data: TData; updatedAt: number } | undefined,
) {
  const client = useQueryClient();
  const key = hashKey(options.queryKey);
  const pending = !!snapshot && (appliedSnapshots.get(client)?.get(key) !== snapshot.identity
    || client.getQueryState(options.queryKey)?.data === undefined);
  const query = useQuery({ ...options, enabled: pending ? false : options.enabled });

  useLayoutEffect(() => {
    if (!snapshot || (appliedSnapshots.get(client)?.get(key) === snapshot.identity
      && client.getQueryState(options.queryKey)?.data !== undefined)) return;
    let applied = appliedSnapshots.get(client);
    if (!applied) appliedSnapshots.set(client, applied = new Map());
    applied.set(key, snapshot.identity);
    // An older same-account read must not win after a fresh session snapshot.
    void client.cancelQueries({ queryKey: options.queryKey, exact: true });
    client.setQueryData(options.queryKey, snapshot.data, { updatedAt: snapshot.updatedAt });
  }, [client, key, options.queryKey, snapshot]);

  // Effects run after render. Publish the canonical snapshot immediately so
  // cached membership/access from an earlier visit cannot reach consumers.
  // Once applied, ordinary readers and mutations own this entry again.
  return pending && snapshot ? {
    ...query, data: snapshot.data, dataUpdatedAt: snapshot.updatedAt,
    status: "success" as const, fetchStatus: "idle" as const,
    error: null, failureReason: null, failureCount: 0,
    isLoading: false, isPending: false, isFetching: false, isRefetching: false,
    isError: false, isSuccess: true, isLoadingError: false, isRefetchError: false,
  } : query;
}
