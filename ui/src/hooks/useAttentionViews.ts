import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttentionItem, AttentionPersonalView } from "@paperclipai/shared";
import { attentionApi } from "@/api/attention";
import { useOptionalToastActions } from "@/context/ToastContext";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { EMPTY_ATTENTION_VIEW_COUNTS } from "@/lib/attention-views";
import { coordinatorAttentionQueryKey } from "@/lib/coordinator-attention";
import { queryKeys } from "@/lib/queryKeys";

interface AttentionViewFeedOptions {
  enabled?: boolean;
  refetchInterval?: number;
}

/**
 * The complete pending feed of one view for the signed-in person (PAP-749 plan
 * §1). It waits for the user ID, so the cache never holds a list without its
 * owner in the key.
 */
export function useAttentionViewFeed(
  companyId: string | null | undefined,
  view: AttentionPersonalView,
  options: AttentionViewFeedOptions = {},
) {
  const { userId } = useCoordinatorWorkspaceEnabled();
  return useQuery({
    queryKey: coordinatorAttentionQueryKey(companyId ?? "", userId, view),
    queryFn: () => attentionApi.list(companyId!, { all: true, view }),
    enabled: !!companyId && !!userId && (options.enabled ?? true),
    refetchOnWindowFocus: true,
    refetchInterval: options.refetchInterval,
  });
}

/**
 * The one badge (PAP-749 plan §1, Rule 5) plus the per-view counts. Every
 * surface reads the "For you" feed under the same key, so the sidebar, the
 * mobile navigation and both Decisions pages show the same numbers.
 */
export function useAttentionBadge(companyId: string | null | undefined, options: AttentionViewFeedOptions = {}) {
  const feed = useAttentionViewFeed(companyId, "mine", options);
  return {
    count: feed.data?.deskBadgeCount ?? 0,
    viewCounts: feed.data?.viewCounts ?? EMPTY_ATTENTION_VIEW_COUNTS,
  };
}

/** Claim an ownerless card; every attention list refetches afterwards. */
export function useClaimAttentionItem(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  return useMutation({
    mutationFn: (item: AttentionItem) => attentionApi.claim(companyId!, item.sourceKind, item.subject.id),
    onSuccess: (_result, item) => {
      toasts?.pushToast({
        title: "Claimed",
        body: item.subject.title ? `${item.subject.title} is now in For you.` : "The card is now in For you.",
        tone: "success",
      });
    },
    onError: (error) => {
      toasts?.pushToast({
        title: "Could not claim this card",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
    onSettled: () => {
      if (companyId) void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    },
  });
}
