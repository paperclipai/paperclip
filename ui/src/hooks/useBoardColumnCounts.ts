import { useQueries } from "@tanstack/react-query";
import { ISSUE_STATUSES, type IssueStatus } from "@paperclipai/shared";
import { issuesApi, type IssueListFilters } from "../api/issues";
import type { IssueFilterState } from "../lib/issue-filters";
import { queryKeys } from "../lib/queryKeys";

export function useBoardColumnCounts({
  companyId, enabled, filters, viewState, columnPageLengths, cardLimit,
}: {
  companyId: string | null | undefined;
  enabled: boolean;
  filters: IssueListFilters;
  viewState: IssueFilterState;
  columnPageLengths: (number | undefined)[];
  cardLimit: number;
}) {
  const hasClientOnlyFilters = viewState.priorities.length > 0 || viewState.assignees.length > 0
    || viewState.creators.length > 0 || viewState.labels.length > 0 || viewState.projects.length > 0
    || viewState.workspaces.length > 0 || !!viewState.liveOnly || viewState.externalObjectStatuses.length > 0;
  const canCount = enabled && !!companyId && !hasClientOnlyFilters;
  const includesStatus = (status: IssueStatus) => viewState.statuses.length === 0 || viewState.statuses.includes(status);
  const queries = useQueries({
    queries: ISSUE_STATUSES.map((status) => ({
      queryKey: [...queryKeys.issues.list(companyId ?? "__no-company__"), "board-column-count", filters, status],
      queryFn: ({ signal }: { signal: AbortSignal }) => issuesApi.count(companyId!, { ...filters, status }, { signal }),
      enabled: canCount && includesStatus(status),
    })),
  });
  const columnCounts = Object.fromEntries(ISSUE_STATUSES.flatMap((status, index) => {
    if (!includesStatus(status)) return [[status, 0]];
    const query = queries[index];
    const count = query?.isError ? undefined : query?.data?.count;
    return canCount && count !== undefined ? [[status, count]] : [];
  }));
  return {
    columnCounts,
    cappedStatuses: ISSUE_STATUSES.filter((status, index) => enabled && includesStatus(status) && columnPageLengths[index] === cardLimit),
    hasError: canCount && queries.some((query, index) => includesStatus(ISSUE_STATUSES[index]!) && query.isError),
  };
}
