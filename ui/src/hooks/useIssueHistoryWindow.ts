import { useCallback, useEffect } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { Issue, IssueComment, IssueRecentComments } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

export function mergeWindowComments(...windows: readonly IssueComment[][]): IssueComment[] {
  return [...new Map(windows.flat().map((comment) => [comment.id, comment])).values()]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
}

/** Freeze the cold-open window, then retain every message observed while open. */
export function useIssueHistoryWindow(
  issueRef: string | undefined,
  showFullHistory: boolean,
  issue?: Pick<Issue, "id" | "identifier">,
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
  const historyExpanded = showFullHistory || expanded;
  const expandHistory = useCallback(() => {
    for (const ref of new Set([issueRef, issue?.id, issue?.identifier])) {
      if (ref) queryClient.setQueryData(["issues", "history-expanded", ref], true);
    }
  }, [issueRef, issue?.id, issue?.identifier, queryClient]);
  useEffect(() => {
    // Keep identifier and UUID navigation on the same expansion preference.
    if (showFullHistory || expanded) expandHistory();
  }, [showFullHistory, expanded, expandHistory]);
  const recentKey = [...queryKeys.issues.comments(issueRef ?? ""), "recent"] as const;
  const recent = useQuery({
    queryKey: recentKey,
    enabled: Boolean(issueRef) && !historyExpanded,
    queryFn: async ({ signal }): Promise<IssueRecentComments> => {
      const previous = queryClient.getQueryData<IssueRecentComments>(recentKey);
      const snapshot = await issuesApi.recentComments(issueRef!, { signal });
      if (!previous) return snapshot;
      // A burst can contain more than the cold-open window. Catch up from the
      // saved cursor instead of dropping messages between two invalidations.
      let cursor = previous.latestCommentId;
      const incoming: IssueComment[] = [];
      // Canceling queued input deletes its comment, including a saved cursor.
      // Retry from an earlier observed row, then from the start if that row
      // was also deleted. Never advance to the preview past unread replies.
      const recoveryAnchors = [
        previous.comments.findLast((comment) => comment.id !== cursor)?.id ?? null,
        null,
      ];
      while (cursor !== snapshot.latestCommentId) {
        const page = await issuesApi.listComments(issueRef!, {
          order: "asc",
          ...(cursor ? { after: cursor } : {}),
          limit: 50,
        }, { signal });
        if (signal.aborted) throw new DOMException("Aborted", "AbortError");
        if (!page.length) {
          if (cursor && recoveryAnchors.length) {
            cursor = recoveryAnchors.shift() ?? null;
            continue;
          }
          break;
        }
        incoming.push(...page);
        const next = page.at(-1)!.id;
        if (next === cursor) break;
        cursor = next;
        if (page.length < 50 || page.some((comment) => comment.id === snapshot.latestCommentId)) break;
      }
      return {
        ...snapshot,
        hasMore: previous.hasMore,
        latestCommentId: incoming.at(-1)?.id ?? snapshot.latestCommentId,
        comments: mergeWindowComments(previous.comments, incoming, snapshot.comments),
      };
    },
  });
  return {
    historyExpanded,
    expandHistory,
    recent,
  };
}
