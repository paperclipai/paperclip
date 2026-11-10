import type { QueryClient } from "@tanstack/react-query";
import type { IssueComment, IssueRecentComments } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "./queryKeys";

export function mergeWindowComments(...windows: readonly IssueComment[][]): IssueComment[] {
  return [...new Map(windows.flat().map((comment) => [comment.id, comment])).values()]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime() || a.id.localeCompare(b.id));
}

export function getIssueRecentCommentsQueryOptions(queryClient: QueryClient, issueRef: string) {
  const recentKey = [...queryKeys.issues.comments(issueRef), "recent"] as const;
  return {
    queryKey: recentKey,
    queryFn: async ({ signal }: { signal: AbortSignal }): Promise<IssueRecentComments> => {
      const previous = queryClient.getQueryData<IssueRecentComments>(recentKey);
      const snapshot = await issuesApi.recentComments(issueRef, { signal });
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
        const page = await issuesApi.listComments(issueRef, {
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
        oldestCommentId: previous.oldestCommentId,
        latestCommentId: incoming.at(-1)?.id ?? snapshot.latestCommentId,
        comments: mergeWindowComments(previous.comments, incoming, snapshot.comments),
      };
    },
  };
}
