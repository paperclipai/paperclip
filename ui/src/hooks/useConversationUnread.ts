import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";

/**
 * Shared hook for tracking unread conversation counts and IDs.
 * Used by both the sidebar badge and the conversations page to avoid
 * duplicate queries against the same API endpoint.
 */
export function useConversationUnread(companyId: string | null | undefined) {
  const { data: unreadIssues = [] } = useQuery({
    queryKey: queryKeys.conversations.unread(companyId!),
    queryFn: () =>
      issuesApi.list(companyId!, {
        kind: "conversation",
        touchedByUserId: "me",
        unreadForUserId: "me",
        status: "backlog,todo,in_progress,in_review,blocked",
      }),
    enabled: !!companyId,
    refetchInterval: 8_000,
  });

  const unreadConvoIds = useMemo(
    () => new Set(unreadIssues.map((i) => i.id)),
    [unreadIssues],
  );

  return { unreadConvoIds, unreadCount: unreadConvoIds.size };
}
