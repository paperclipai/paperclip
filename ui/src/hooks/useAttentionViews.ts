import { useCallback, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { AttentionCloseMode, AttentionItem, AttentionPersonalView, AttentionReceipt } from "@paperclipai/shared";
import { accessApi } from "@/api/access";
import { attentionApi } from "@/api/attention";
import { inboxDismissalsApi } from "@/api/inboxDismissals";
import { useOptionalToastActions } from "@/context/ToastContext";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { attentionAlreadyClosedText, attentionUserLabel, readAttentionAlreadyClosed } from "@/lib/attention-close";
import { EMPTY_ATTENTION_VIEW_COUNTS, attentionEveryoneViewAllowed } from "@/lib/attention-views";
import { invalidateAttentionRecordViews } from "@/lib/attention-record-views";
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

/**
 * Whether the signed-in person may open Everyone (PAP-768): board members
 * only. Reads the shared board access snapshot; false until it loads.
 */
export function useAttentionEveryoneView(companyId: string | null | undefined) {
  const { userId } = useCoordinatorWorkspaceEnabled();
  const boardAccess = useQuery({
    queryKey: queryKeys.access.currentBoardAccess,
    queryFn: () => accessApi.getCurrentBoardAccess(),
    enabled: !!companyId && !!userId,
    staleTime: 30_000,
  });
  return boardAccess.data?.userId === userId && attentionEveryoneViewAllowed(companyId, boardAccess.data);
}

/**
 * Claim an ownerless card. Every attention list refetches afterwards, and so
 * do task detail and chat, whose audience line names the new owner.
 */
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
    onSettled: (_result, _error, item) => {
      if (companyId) invalidateAttentionRecordViews(queryClient, companyId, item);
    },
  });
}

/**
 * Dismiss a receipt at the top of For you (PAP-749 plan §6). It is personal
 * presentation state, stored like an archived card under the receipt's key.
 */
export function useDismissAttentionReceipt(companyId: string | null | undefined) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  const mutation = useMutation({
    mutationFn: (receipt: AttentionReceipt) => inboxDismissalsApi.dismiss(companyId!, receipt.dismissalKey),
    onError: (error) => {
      toasts?.pushToast({
        title: "Could not dismiss this receipt",
        body: error instanceof Error ? error.message : undefined,
        tone: "error",
      });
    },
    onSettled: () => {
      if (companyId) void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    },
  });
  return {
    dismiss: mutation.mutate,
    dismissingId: mutation.isPending ? mutation.variables?.id ?? null : null,
  };
}

export interface AttentionCloseRequest {
  item: AttentionItem;
  mode: AttentionCloseMode;
  reason?: string | null;
  until?: string | null;
}

export interface AttentionWithdrawAllResult {
  withdrawn: AttentionItem[];
  alreadyClosed: AttentionItem[];
  failed: AttentionItem[];
}

const CLOSE_TOAST_TITLE: Record<AttentionCloseMode, string> = {
  withdraw: "Request withdrawn",
  archive: "Archived for you",
  snooze: "Snoozed for you",
};

/**
 * The Close… menu verbs and "Withdraw all stale" (PAP-749 plan §2, Rule 6;
 * §3). Every verb goes through the one close endpoint, which writes the
 * `attention.closed` audit entry. Archive and snooze can be undone (Restore
 * deletes the dismissal); withdraw cannot, because the agent is already awake.
 * A 409 from a person who was first shows "Already answered by @x".
 */
export function useAttentionCloseActions(
  companyId: string | null | undefined,
  options: {
    userLabelMap?: ReadonlyMap<string, string> | null;
    /** Called after the server accepted a close, before the feed refetches. */
    onClosed?: (item: AttentionItem, mode: AttentionCloseMode) => void;
    /** Called when a close failed, so an optimistic hide can come back. */
    onCloseFailed?: (item: AttentionItem, mode: AttentionCloseMode) => void;
    /** Called after a Restore (or an Undo) succeeded, before the feed refetches. */
    onRestored?: (item: AttentionItem) => void;
  } = {},
) {
  const queryClient = useQueryClient();
  const toasts = useOptionalToastActions();
  const { userLabelMap, onClosed, onCloseFailed, onRestored } = options;
  const [bulkPending, setBulkPending] = useState(false);

  const invalidate = useCallback(() => {
    if (!companyId) return;
    void queryClient.invalidateQueries({ queryKey: queryKeys.attention(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.inboxDismissals(companyId) });
    void queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
  }, [companyId, queryClient]);

  const errorBody = useCallback((error: unknown) => {
    const details = readAttentionAlreadyClosed(error);
    if (details) return attentionAlreadyClosedText(details, userLabelMap);
    return error instanceof Error ? error.message : undefined;
  }, [userLabelMap]);

  /**
   * Restore deletes your dismissal, so an archived or snoozed card shows in its
   * view again (PAP-749 plan §3). Resolves `false` when the server refused, so
   * a page can bring back a card it hid optimistically.
   */
  const restore = useCallback(async (item: AttentionItem): Promise<boolean> => {
    if (!companyId) return false;
    let restored = true;
    try {
      await inboxDismissalsApi.restore(companyId, item.dismissalKey);
      onRestored?.(item);
      toasts?.pushToast({
        id: `attention-restore-${item.id}`,
        title: "Restored",
        body: item.subject.title ?? undefined,
        tone: "info",
      });
    } catch (error) {
      restored = false;
      toasts?.pushToast({ title: "Could not restore this card", body: errorBody(error), tone: "error" });
    }
    invalidate();
    return restored;
  }, [companyId, errorBody, invalidate, onRestored, toasts]);

  const close = useMutation({
    mutationFn: ({ item, mode, reason, until }: AttentionCloseRequest) =>
      attentionApi.close(companyId!, item.sourceKind, item.subject.id, {
        mode,
        reason: reason?.trim() || undefined,
        until: until ?? undefined,
        // The version the person saw: the card returns only when it changes.
        fingerprint: mode === "withdraw" ? undefined : item.changeFingerprint || undefined,
      }),
    onSuccess: (result, { item, mode }) => {
      onClosed?.(item, mode);
      toasts?.pushToast({
        id: `attention-close-${item.id}`,
        dedupeKey: `attention-close-${item.dismissalKey}`,
        title: CLOSE_TOAST_TITLE[mode],
        body: mode === "snooze" && result.until
          ? `Back ${new Date(result.until).toLocaleString()}.`
          : item.subject.title ?? undefined,
        tone: mode === "withdraw" ? "success" : "info",
        ...(mode === "withdraw" ? {} : { ttlMs: 8000, action: { label: "Undo", onClick: () => void restore(item) } }),
      });
    },
    onError: (error, { item, mode }) => {
      onCloseFailed?.(item, mode);
      toasts?.pushToast({
        title: mode === "withdraw" ? "Could not withdraw this request" : "Could not hide this card",
        body: errorBody(error),
        tone: "error",
      });
    },
    onSettled: invalidate,
  });

  const transfer = useMutation({
    mutationFn: ({ item, userId, reason }: { item: AttentionItem; userId: string; reason?: string | null }) =>
      attentionApi.transfer(companyId!, item.sourceKind, item.subject.id, { userId, reason: reason?.trim() || undefined }),
    onSuccess: (_result, { item, userId }) => {
      toasts?.pushToast({
        title: `Transferred to @${attentionUserLabel(userId, userLabelMap)}`,
        body: item.subject.title ?? undefined,
        tone: "success",
      });
    },
    onError: (error) => {
      toasts?.pushToast({ title: "Could not transfer this card", body: errorBody(error), tone: "error" });
    },
    onSettled: (_result, _error, { item }) => {
      invalidate();
      // Task detail and chat name the new owner too.
      if (companyId) invalidateAttentionRecordViews(queryClient, companyId, item);
    },
  });

  /**
   * Withdraw each confirmed stale card, one at a time so one failure does not
   * hide the others. A card that a different person closed first is reported,
   * not retried.
   */
  const withdrawAll = useCallback(async (items: AttentionItem[], reason?: string | null): Promise<AttentionWithdrawAllResult> => {
    const result: AttentionWithdrawAllResult = { withdrawn: [], alreadyClosed: [], failed: [] };
    if (!companyId || items.length === 0) return result;
    setBulkPending(true);
    try {
      for (const item of items) {
        try {
          await attentionApi.close(companyId, item.sourceKind, item.subject.id, { mode: "withdraw", reason: reason?.trim() || undefined });
          result.withdrawn.push(item);
          onClosed?.(item, "withdraw");
        } catch (error) {
          (readAttentionAlreadyClosed(error) ? result.alreadyClosed : result.failed).push(item);
        }
      }
    } finally {
      setBulkPending(false);
      invalidate();
    }
    const notes = [
      result.alreadyClosed.length ? `${result.alreadyClosed.length} already answered by someone else.` : null,
      result.failed.length ? `${result.failed.length} could not be withdrawn.` : null,
    ].filter(Boolean).join(" ");
    toasts?.pushToast({
      title: result.withdrawn.length === 1 ? "Withdrew 1 stale request" : `Withdrew ${result.withdrawn.length} stale requests`,
      body: notes || undefined,
      tone: result.failed.length ? "error" : "success",
    });
    return result;
  }, [companyId, invalidate, onClosed, toasts]);

  return {
    close: close.mutate,
    closingItemId: close.isPending ? close.variables?.item.id ?? null : null,
    transfer: transfer.mutate,
    transferringItemId: transfer.isPending ? transfer.variables?.item.id ?? null : null,
    restore,
    withdrawAll,
    bulkPending,
  };
}
