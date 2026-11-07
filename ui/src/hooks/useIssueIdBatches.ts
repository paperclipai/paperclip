import { useEffect, useMemo } from "react";
import { useQueries, useQuery, useQueryClient } from "@tanstack/react-query";

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
    client.setQueryData<string[][]>([...base, "batch-ids"], current => {
      const existing = new Set(current?.flat() ?? []);
      const incoming = (JSON.parse(missingKey) as string[]).filter(id => !existing.has(id));
      if (!incoming.length) return current;
      const appended: string[][] = [];
      for (let index = 0; index < incoming.length; index += 100) appended.push(incoming.slice(index, index + 100));
      return [...current ?? [], ...appended];
    });
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
