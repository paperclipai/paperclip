import { useCallback, useState } from "react";
import { useInfiniteQuery, useQueryClient, type InfiniteData } from "@tanstack/react-query";
import type { IssueComment } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

export interface ConversationHistoryPage {
  comments: IssueComment[];
  nextCursor: string | null;
  fallbackCursors?: string[];
}

export function useConversationHistoryPages(issueRef: string | undefined, active: boolean, oldestCommentId: string | null | undefined, recentComments: IssueComment[]) {
  const client = useQueryClient();
  const [requestedRef, setRequestedRef] = useState<string | null>(null);
  const key = queryKeys.issues.earlierComments(issueRef ?? "pending");
  const cached = client.getQueryData<InfiniteData<ConversationHistoryPage, string | null>>(key);
  const started = requestedRef === issueRef || Boolean(cached);
  const query = useInfiniteQuery({
    queryKey: key,
    enabled: active && !!issueRef && started,
    retry: false,
    initialPageParam: oldestCommentId ?? null,
    queryFn: async ({ pageParam, signal }): Promise<ConversationHistoryPage> => {
      const read = (cursor: string | null) => issuesApi.listComments(issueRef!, {
        order: "desc", limit: 50, ...(cursor ? { after: cursor } : {}),
      }, { signal });
      let comments = await read(pageParam);
      if (!comments.length && pageParam) {
        const previous = client.getQueryData<InfiniteData<ConversationHistoryPage, string | null>>(key);
        const saved = previous?.pages.find(page => page.nextCursor === pageParam)?.fallbackCursors;
        const boundary = recentComments.findIndex(comment => comment.id === pageParam);
        const candidates = saved ?? (boundary < 0 ? [] : recentComments.slice(boundary + 1).map(comment => comment.id));
        const anchors = [...new Set([candidates.find(id => id !== pageParam), candidates.at(-1), null])];
        for (const anchor of anchors) {
          if (anchor === undefined || anchor === pageParam) continue;
          comments = await read(anchor);
          if (comments.length) break;
        }
      }
      return {
        comments, nextCursor: comments.length === 50 ? comments.at(-1)!.id : null,
        fallbackCursors: comments.slice(0, -1).reverse().map(comment => comment.id),
      };
    },
    getNextPageParam: page => page.nextCursor ?? undefined,
  });
  const load = useCallback(() => {
    if (!active || !issueRef) return;
    if (!started) { setRequestedRef(issueRef); return; }
    return query.fetchNextPage({ cancelRefetch: false });
  }, [active, issueRef, started, query.fetchNextPage]);
  return { ...query, load };
}
