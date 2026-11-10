import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueComment } from "@paperclipai/shared";
import { getIssueRecentCommentsQueryOptions, mergeWindowComments } from "@/lib/issue-comment-window-query";
import { queryKeys } from "@/lib/queryKeys";

export { mergeWindowComments } from "@/lib/issue-comment-window-query";

/** Freeze the cold-open window, then retain every message observed while open. */
export function useIssueHistoryWindow(
  issueRef: string | undefined,
  showFullHistory: boolean,
  issue?: Pick<Issue, "id" | "identifier">,
  continuous = false,
) {
  const queryClient = useQueryClient();
  const expansionKey = ["issues", "history-expanded", issueRef] as const;
  const { data: expanded = false } = useQuery({
    queryKey: expansionKey,
    queryFn: () => false,
    enabled: false,
    initialData: false,
    gcTime: Infinity,
  });
  const historyExpanded = !continuous && (showFullHistory || expanded);
  const expandHistory = useCallback(() => {
    for (const ref of new Set([issueRef, issue?.id, issue?.identifier])) {
      if (ref) queryClient.setQueryData(["issues", "history-expanded", ref], true);
    }
  }, [issueRef, issue?.id, issue?.identifier, queryClient]);
  useEffect(() => {
    // Keep identifier and UUID navigation on the same expansion preference.
    if (!continuous && (showFullHistory || expanded)) expandHistory();
  }, [continuous, showFullHistory, expanded, expandHistory]);
  const recent = useQuery({
    ...getIssueRecentCommentsQueryOptions(queryClient, issueRef ?? ""),
    enabled: Boolean(issueRef) && !historyExpanded,
  });
  const { data: acknowledgedComments = [] } = useQuery<IssueComment[]>({
    queryKey: queryKeys.issues.acknowledgedComments(issueRef ?? ""),
    queryFn: () => [],
    enabled: false,
    initialData: [],
  });
  const retainComment = useCallback((comment: IssueComment) => {
    for (const ref of new Set([issueRef, issue?.id, issue?.identifier, comment.issueId])) {
      if (!ref) continue;
      queryClient.setQueryData<IssueComment[]>(queryKeys.issues.acknowledgedComments(ref), current =>
        mergeWindowComments(current ?? [], [comment]),
      );
    }
  }, [issueRef, issue?.id, issue?.identifier, queryClient]);
  useEffect(() => {
    if (!recent.data) return;
    const observed = new Set(recent.data.comments.map(comment => comment.id));
    for (const ref of new Set([issueRef, issue?.id, issue?.identifier])) {
      if (!ref) continue;
      queryClient.setQueryData<IssueComment[]>(queryKeys.issues.acknowledgedComments(ref), current => {
        if (!current?.some(comment => observed.has(comment.id))) return current;
        return current.filter(comment => !observed.has(comment.id));
      });
    }
  }, [recent.data, issueRef, issue?.id, issue?.identifier, queryClient]);
  return {
    acknowledgedComments,
    retainComment,
    historyExpanded,
    expandHistory,
    recent,
  };
}
