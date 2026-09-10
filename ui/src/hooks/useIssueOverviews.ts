import { useCallback, useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import type { IssueOverview } from "@paperclipai/shared";
import { ISSUE_OVERVIEW_BATCH_SIZE, issueOverviewsApi } from "../api/issue-overviews";
import { queryKeys } from "../lib/queryKeys";
import { usePublishSharedQueryData, useSharedPollingQuery } from "./useSharedPolling";

/**
 * Foreground refresh cadence. The projection is a recorded observation, so a
 * fresh read re-reads Paperclip's own rows; it never triggers a forge check.
 */
export const ISSUE_OVERVIEW_REFETCH_INTERVAL_MS = 30_000;

/**
 * One snapshot of the requested id list.
 *
 * `failedIssueIds` is what makes a partial batch honest: the caller can render
 * the ids that loaded, and say exactly which ones are missing, instead of
 * showing a silent subset or an error that blames the whole board for the
 * failure of one chunk.
 */
export interface IssueOverviewsSnapshot {
  items: IssueOverview[];
  observedAt: string | null;
  failedIssueIds: string[];
}

export interface IssueOverviewsResult {
  byId: Map<string, IssueOverview>;
  /** Whether the requested batch is still loading for the first time. */
  isPending: boolean;
  /** A whole-batch failure, or a described partial-batch failure. */
  error: Error | null;
  /** When the data currently in `byId` was observed. `0` when never loaded. */
  dataUpdatedAt: number;
  refetch: () => void;
}

/**
 * Reads a batch of issue overviews, chunked to the route's accepted maximum.
 *
 * A chunk that fails is recorded rather than thrown away, so one bad chunk
 * never blanks the other 99-item chunks; if every chunk fails the query errors
 * and the previously loaded snapshot stays on screen.
 */
export async function fetchIssueOverviews(
  companyId: string,
  issueIds: readonly string[],
): Promise<IssueOverviewsSnapshot> {
  const items: IssueOverview[] = [];
  const failedIssueIds: string[] = [];
  let observedAt: string | null = null;
  let firstFailure: unknown = null;

  for (let index = 0; index < issueIds.length; index += ISSUE_OVERVIEW_BATCH_SIZE) {
    const chunk = issueIds.slice(index, index + ISSUE_OVERVIEW_BATCH_SIZE);
    try {
      const response = await issueOverviewsApi.getByIssueIds(companyId, chunk);
      items.push(...response.items);
      // Chunks are read in order, so the last successful read is the newest.
      observedAt = response.observedAt ?? observedAt;
    } catch (error) {
      failedIssueIds.push(...chunk);
      firstFailure ??= error;
    }
  }

  if (failedIssueIds.length === issueIds.length) {
    throw firstFailure instanceof Error
      ? firstFailure
      : new Error("Issue overviews could not be loaded");
  }

  return { items, observedAt, failedIssueIds };
}

function partialFailureError(snapshot: IssueOverviewsSnapshot, requestedCount: number): Error | null {
  if (snapshot.failedIssueIds.length === 0) return null;
  return new Error(
    `${snapshot.failedIssueIds.length} of ${requestedCount} issue overviews could not be loaded`,
  );
}

export function useIssueOverviews(
  companyId: string | null | undefined,
  issueIds: readonly string[],
): IssueOverviewsResult {
  const ids = useMemo(
    () => [...new Set(issueIds.filter((issueId) => issueId.length > 0))].sort(),
    [issueIds],
  );
  // The route truncates nothing, but many callers rebuild their id array on
  // every render. Memoizing the key keeps one cache entry and one cross-tab
  // resource for one id set instead of one per render.
  const queryKey = useMemo(
    () => queryKeys.issueOverviews.list(companyId ?? "__none__", ids),
    [companyId, ids],
  );
  const enabled = Boolean(companyId) && ids.length > 0;

  const shared = useSharedPollingQuery<IssueOverviewsSnapshot>({
    companyId,
    resourceKey: "issue-overviews",
    queryKey,
    enabled,
    refetchInterval: ISSUE_OVERVIEW_REFETCH_INTERVAL_MS,
  });

  const query = useQuery({
    queryKey,
    queryFn: () => fetchIssueOverviews(companyId!, ids),
    enabled: shared.enabled,
    refetchInterval: shared.refetchInterval,
    staleTime: ISSUE_OVERVIEW_REFETCH_INTERVAL_MS,
  });
  usePublishSharedQueryData(shared, query.data, query.dataUpdatedAt);

  const byId = useMemo(() => {
    const map = new Map<string, IssueOverview>();
    for (const item of query.data?.items ?? []) map.set(item.issueId, item);
    return map;
  }, [query.data]);

  const error = useMemo(() => {
    if (query.error) return query.error instanceof Error ? query.error : new Error(String(query.error));
    if (!query.data) return null;
    return partialFailureError(query.data, ids.length);
  }, [query.data, query.error, ids.length]);

  const refetch = useCallback(() => {
    void query.refetch();
  }, [query.refetch]);

  return {
    byId,
    isPending: enabled && query.isPending,
    error,
    dataUpdatedAt: query.dataUpdatedAt,
    refetch,
  };
}
