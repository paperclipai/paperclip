import { useCallback, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { inboxDismissalsApi } from "../api/inboxDismissals";
import { sidebarBadgesApi } from "../api/sidebarBadges";
import { queryKeys } from "../lib/queryKeys";
import { usePublishSharedQueryData, useSharedPollingQuery } from "./useSharedPolling";
import {
  buildInboxDismissedAtByKey,
  loadDismissedInboxAlerts,
  saveDismissedInboxAlerts,
  loadReadInboxItems,
  saveReadInboxItems,
  READ_ITEMS_KEY,
} from "../lib/inbox";

export function useDismissedInboxAlerts() {
  const [dismissed, setDismissed] = useState<Set<string>>(loadDismissedInboxAlerts);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== "paperclip:inbox:dismissed") return;
      setDismissed(loadDismissedInboxAlerts());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const dismiss = (id: string) => {
    setDismissed((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveDismissedInboxAlerts(next);
      return next;
    });
  };

  return { dismissed, dismiss };
}

export function useInboxDismissals(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const queryKey = companyId
    ? queryKeys.inboxDismissals(companyId)
    : ["inbox-dismissals", "__disabled__"] as const;

  const { data: dismissals = [] } = useQuery({
    queryKey,
    queryFn: () => inboxDismissalsApi.list(companyId!),
    enabled: !!companyId,
  });

  const dismissMutation = useMutation({
    mutationFn: ({ itemKey }: { itemKey: string }) => inboxDismissalsApi.dismiss(companyId!, itemKey),
    onMutate: async ({ itemKey }) => {
      if (!companyId) return { previous: [] as typeof dismissals };
      await queryClient.cancelQueries({ queryKey });
      const previous = queryClient.getQueryData<typeof dismissals>(queryKey) ?? [];
      const now = new Date();
      queryClient.setQueryData(queryKey, [
        {
          id: `optimistic:${itemKey}`,
          companyId,
          userId: "me",
          itemKey,
          dismissedAt: now,
          createdAt: now,
          updatedAt: now,
        },
        ...previous.filter((dismissal) => dismissal.itemKey !== itemKey),
      ]);
      return { previous };
    },
    onError: (_error, _variables, context) => {
      if (!context) return;
      queryClient.setQueryData(queryKey, context.previous);
    },
    onSettled: () => {
      if (!companyId) return;
      invalidateDismissalConsumers();
    },
  });

  function invalidateDismissalConsumers() {
    if (!companyId) return;
    queryClient.invalidateQueries({ queryKey });
    queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
    // The attention feed derives its rows from server-side dismissals, so any
    // dismiss/snooze/restore must re-pull it to keep the queue and curtains in sync.
    queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
  }

  const snoozeMutation = useMutation({
    mutationFn: ({ itemKey, snoozedUntil }: { itemKey: string; snoozedUntil: string }) =>
      inboxDismissalsApi.snooze(companyId!, itemKey, snoozedUntil),
    onSettled: invalidateDismissalConsumers,
  });

  const restoreMutation = useMutation({
    mutationFn: ({ itemKey }: { itemKey: string }) => inboxDismissalsApi.restore(companyId!, itemKey),
    onSettled: invalidateDismissalConsumers,
  });

  const dismissedAtByKey = useMemo(
    () => buildInboxDismissedAtByKey(dismissals),
    [dismissals],
  );

  // Stable identities (react-query keeps `mutate` referentially stable) so
  // consumers can hand these to memoized rows without breaking memoization.
  const dismissMutate = dismissMutation.mutate;
  const snoozeMutate = snoozeMutation.mutate;
  const restoreMutate = restoreMutation.mutate;
  const dismiss = useCallback((itemKey: string) => dismissMutate({ itemKey }), [dismissMutate]);
  const snooze = useCallback(
    (itemKey: string, snoozedUntil: string) => snoozeMutate({ itemKey, snoozedUntil }),
    [snoozeMutate],
  );
  const restore = useCallback((itemKey: string) => restoreMutate({ itemKey }), [restoreMutate]);

  return {
    dismissals,
    dismissedAtByKey,
    dismiss,
    snooze,
    restore,
    isPending: dismissMutation.isPending || snoozeMutation.isPending || restoreMutation.isPending,
  };
}

export function useReadInboxItems() {
  const [readItems, setReadItems] = useState<Set<string>>(loadReadInboxItems);

  useEffect(() => {
    const handleStorage = (event: StorageEvent) => {
      if (event.key !== READ_ITEMS_KEY) return;
      setReadItems(loadReadInboxItems());
    };
    window.addEventListener("storage", handleStorage);
    return () => window.removeEventListener("storage", handleStorage);
  }, []);

  const markRead = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.add(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  const markUnread = (id: string) => {
    setReadItems((prev) => {
      const next = new Set(prev);
      next.delete(id);
      saveReadInboxItems(next);
      return next;
    });
  };

  return { readItems, markRead, markUnread };
}

export function useInboxBadge(companyId: string | null | undefined) {
  const badgeQueryKey = queryKeys.sidebarBadges(companyId!);
  const sharedBadges = useSharedPollingQuery({
    companyId,
    resourceKey: "sidebar-badges",
    queryKey: badgeQueryKey,
    enabled: !!companyId,
    leaderOnly: true,
  });
  const { data: badges, dataUpdatedAt } = useQuery({
    queryKey: badgeQueryKey,
    queryFn: () => sidebarBadgesApi.get(companyId!),
    enabled: sharedBadges.enabled,
  });
  usePublishSharedQueryData(sharedBadges, badges, dataUpdatedAt);

  return badges ?? {
    inbox: 0,
    approvals: 0,
    failedRuns: 0,
    joinRequests: 0,
    mineIssues: 0,
  };
}
