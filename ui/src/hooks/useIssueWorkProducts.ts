import { useEffect, useRef } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { keepPreviousDataForSameQueryTail } from "@/lib/query-placeholder-data";

/** Paint saved work first; provider refreshes must never gate access to it. */
export function useIssueWorkProducts(issueId: string | null | undefined) {
  const queryClient = useQueryClient();
  const enrichedIssue = useRef<string | null>(null);
  const queryKey = queryKeys.issues.workProducts(issueId ?? "__none__");
  const query = useQuery({
    queryKey,
    queryFn: () => {
      const refreshPullRequests = queryClient.getQueryData(queryKey) !== undefined;
      if (refreshPullRequests) enrichedIssue.current = issueId!;
      return issuesApi.listWorkProducts(issueId!, { refreshPullRequests });
    },
    enabled: Boolean(issueId),
    refetchOnMount: "always",
    placeholderData: keepPreviousDataForSameQueryTail<IssueWorkProduct[]>(issueId ?? "__none__"),
  });
  const { data, isFetching, refetch } = query;
  useEffect(() => {
    if (!issueId || isFetching || enrichedIssue.current === issueId
      || !data?.some((product) => product.type === "pull_request")) return;
    enrichedIssue.current = issueId;
    void refetch();
  }, [issueId, data, isFetching, refetch]);
  return query;
}
