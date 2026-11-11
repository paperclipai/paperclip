import { useQueries } from "@tanstack/react-query";
import type { IssueDisplayStatus } from "@paperclipai/shared";
import { issuesApi, type IssueCountFilters } from "../api/issues";
import type { IssueFilterState } from "../lib/issue-filters";
import { queryKeys } from "../lib/queryKeys";

/**
 * Server totals for board columns. `statuses` must be the board's column order so
 * `columnPageLengths[i]` is the card page loaded for `statuses[i]`.
 */
export function useBoardColumnCounts({
  companyId, enabled, filters, viewState, statuses, columnPageLengths, cardLimit,
}: {
  companyId: string | null | undefined;
  enabled: boolean;
  filters: IssueCountFilters;
  viewState: IssueFilterState;
  statuses: readonly IssueDisplayStatus[];
  columnPageLengths: (number | undefined)[];
  cardLimit: number;
}) {
  const hasClientOnlyFilters = viewState.priorities.length > 0 || viewState.assignees.length > 0
    || viewState.creators.length > 0 || viewState.labels.length > 0 || viewState.projects.length > 0
    || viewState.workspaces.length > 0 || !!viewState.liveOnly || viewState.externalObjectStatuses.length > 0;
  const canCount = enabled && !!companyId && !hasClientOnlyFilters;
  const includesStatus = (status: IssueDisplayStatus) => viewState.statuses.length === 0 || viewState.statuses.includes(status);
  const queries = useQueries({
    queries: statuses.map((status) => ({
      queryKey: [...queryKeys.issues.list(companyId ?? "__no-company__"), "board-column-count", filters, status],
      queryFn: ({ signal }: { signal: AbortSignal }) => issuesApi.count(companyId!, { ...filters, displayStatus: status }, { signal }),
      enabled: canCount && includesStatus(status),
    })),
  });
  const columnCounts = Object.fromEntries(statuses.flatMap((status, index) => {
    if (!includesStatus(status)) return [[status, 0]];
    // A failed refetch keeps the last server total; only a missing total falls back to a lower bound.
    const count = queries[index]?.data?.count;
    return canCount && count !== undefined ? [[status, count]] : [];
  })) as Partial<Record<IssueDisplayStatus, number>>;
  return {
    columnCounts,
    cappedStatuses: statuses.filter((status, index) => enabled && includesStatus(status) && columnPageLengths[index] === cardLimit),
    hasError: canCount && queries.some((query, index) => includesStatus(statuses[index]!) && query.data === undefined && query.isError),
  };
}
