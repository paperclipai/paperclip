import { useEffect, useMemo } from "react";
import { useQueries, useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";

const ISSUE_ID_BATCH_SIZE = 100;

/** Append the ids not yet in any batch, as new batches of at most 100 ids. */
function appendIssueIdBatches(current: string[][] | undefined, ids: readonly string[]) {
  const existing = new Set(current?.flat() ?? []);
  const incoming = ids.filter(id => !existing.has(id));
  if (!incoming.length) return current;
  const appended: string[][] = [];
  for (let index = 0; index < incoming.length; index += ISSUE_ID_BATCH_SIZE) {
    appended.push(incoming.slice(index, index + ISSUE_ID_BATCH_SIZE));
  }
  return [...current ?? [], ...appended];
}

/**
 * Warm the batches that `useIssueIdBatches` reads for these ids, under the same
 * keys, so a page that mounts with them renders from cache.
 */
export function prefetchIssueIdBatches<T>(
  client: QueryClient,
  key: readonly unknown[],
  ids: readonly string[],
  fetchBatch: (ids: string[]) => Promise<T[]>,
  staleTime: number,
) {
  if (!ids.length) return Promise.resolve();
  const batches = client.setQueryData<string[][]>([...key, "batch-ids"], current => appendIssueIdBatches(current, ids)) ?? [];
  const wanted = new Set(ids);
  return Promise.all(batches.filter(batch => batch.some(id => wanted.has(id))).map(batch => client.prefetchQuery({
    queryKey: [...key, "batch", batch], queryFn: () => fetchBatch(batch), staleTime,
  }))).then(() => undefined);
}

export function useIssueIdBatches<T>(key: readonly unknown[], ids: string[], fetchBatch: (ids: string[]) => Promise<T[]>, enabled: boolean) {
  const client = useQueryClient();
  const serializedKey = JSON.stringify(key);
  const base = useMemo(() => JSON.parse(serializedKey) as unknown[], [serializedKey]);
  const { data: batches = [] } = useQuery<string[][]>({
    queryKey: [...base, "batch-ids"], queryFn: () => [], enabled: false, initialData: [],
  });
  const known = new Set(batches.flat());
  const missing = ids.filter(id => !known.has(id));
  const missingKey = JSON.stringify(missing);
  useEffect(() => {
    if (!enabled || missingKey === "[]") return;
    client.setQueryData<string[][]>([...base, "batch-ids"], current => appendIssueIdBatches(current, JSON.parse(missingKey) as string[]));
  }, [client, base, missingKey, enabled]);
  const queries = useQueries({ queries: batches.map(batch => ({
    queryKey: [...base, "batch", batch], queryFn: () => fetchBatch(batch), enabled,
  })) });
  return {
    data: queries.flatMap(query => query.data ?? []),
    isPending: enabled && (missing.length > 0 || queries.some(query => query.isPending)),
    isLoading: enabled && (missing.length > 0 || queries.some(query => query.isLoading)),
    isError: enabled && queries.some(query => query.isError),
    refetch: () => Promise.all(queries.map(query => query.refetch())),
  };
}
