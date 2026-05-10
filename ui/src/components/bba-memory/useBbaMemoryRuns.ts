/**
 * useBbaMemoryRuns — TanStack Query hook bundling recent-runs + stats
 * fetches into one ergonomic API. Used by BbaMemoryRecentRunsPanel and
 * usable by any consumer wanting both data shapes with consistent
 * polling intervals.
 */
import { useQuery } from "@tanstack/react-query";
import {
  fetchRecentBbaRuns,
  fetchBbaStats,
  type BbaMemoryRun,
  type BbaStatsSummary,
} from "../../api/bbaMemory";

export interface UseBbaMemoryRunsOptions {
  limit?: number;
  windowDays?: number;
  runsRefetchMs?: number;
  statsRefetchMs?: number;
}

export interface UseBbaMemoryRunsResult {
  runs: BbaMemoryRun[];
  stats: BbaStatsSummary | undefined;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  refetch: () => void;
}

export function useBbaMemoryRuns(
  companyId: string,
  options: UseBbaMemoryRunsOptions = {},
): UseBbaMemoryRunsResult {
  const {
    limit = 20,
    windowDays = 7,
    runsRefetchMs = 30_000,
    statsRefetchMs = 60_000,
  } = options;

  const runsQuery = useQuery({
    queryKey: ["bba-memory", "recent-runs", companyId, limit],
    queryFn: ({ signal }) => fetchRecentBbaRuns(companyId, { limit, signal }),
    refetchInterval: runsRefetchMs,
  });

  const statsQuery = useQuery({
    queryKey: ["bba-memory", "stats-summary", companyId, windowDays],
    queryFn: ({ signal }) => fetchBbaStats(companyId, { windowDays, signal }),
    refetchInterval: statsRefetchMs,
  });

  const error =
    runsQuery.error instanceof Error
      ? runsQuery.error
      : statsQuery.error instanceof Error
        ? statsQuery.error
        : null;

  return {
    runs: runsQuery.data?.runs ?? [],
    stats: statsQuery.data,
    isLoading: runsQuery.isLoading || statsQuery.isLoading,
    isError: runsQuery.isError || statsQuery.isError,
    error,
    refetch: () => {
      runsQuery.refetch();
      statsQuery.refetch();
    },
  };
}
