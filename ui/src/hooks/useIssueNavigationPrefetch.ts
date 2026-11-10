import { useCallback, useEffect, useMemo, useRef } from "react";
import type { FocusEvent, MouseEvent, PointerEvent, TouchEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { prefetchIssueDetailForNavigation } from "@/lib/issueDetailCache";

/** How long a hover rests on a task link before its full chat history is warmed. */
export const ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS = 120;

export interface IssueNavigationPrefetchHandlers {
  onMouseEnter: (event: MouseEvent<HTMLAnchorElement>) => void;
  onMouseLeave: (event: MouseEvent<HTMLAnchorElement>) => void;
  onPointerDown: (event: PointerEvent<HTMLAnchorElement>) => void;
  onFocus: (event: FocusEvent<HTMLAnchorElement>) => void;
  onBlur: (event: FocusEvent<HTMLAnchorElement>) => void;
  onTouchStart: (event: TouchEvent<HTMLAnchorElement>) => void;
  onClickCapture: (event: MouseEvent<HTMLAnchorElement>) => void;
}

/**
 * Link handlers that warm a task before it is opened.
 *
 * A pointer, a touch or keyboard focus that passes over a link warms only the
 * issue and its recent comments. A hover or focus that rests on the link, a
 * mouse or pen press, or a click also warms the rest of the chat's first frame,
 * so the open renders from cache. A touch can start a scroll, so it warms the
 * full set only on the click.
 */
export function useIssueNavigationPrefetch(
  issuePathId: string,
  issue: Issue | null = null,
): IssueNavigationPrefetchHandlers {
  const queryClient = useQueryClient();
  const historyPrefetchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHistoryPrefetch = useCallback(() => {
    if (historyPrefetchTimerRef.current) clearTimeout(historyPrefetchTimerRef.current);
    historyPrefetchTimerRef.current = null;
  }, []);
  useEffect(() => cancelHistoryPrefetch, [cancelHistoryPrefetch]);
  const prefetch = useCallback((history = true) => {
    if (history) cancelHistoryPrefetch();
    void prefetchIssueDetailForNavigation(queryClient, issuePathId, { issue, history });
  }, [cancelHistoryPrefetch, issuePathId, issue, queryClient]);
  const dwell = useCallback(() => {
    prefetch(false);
    cancelHistoryPrefetch();
    historyPrefetchTimerRef.current = setTimeout(() => prefetch(true), ISSUE_HISTORY_HOVER_PREFETCH_DELAY_MS);
  }, [cancelHistoryPrefetch, prefetch]);
  return useMemo(() => ({
    onMouseEnter: () => dwell(),
    onMouseLeave: () => cancelHistoryPrefetch(),
    onPointerDown: (event) => prefetch(event.pointerType !== "touch" && event.button === 0),
    onFocus: () => dwell(),
    onBlur: () => cancelHistoryPrefetch(),
    onTouchStart: () => prefetch(false),
    onClickCapture: () => prefetch(),
  }), [cancelHistoryPrefetch, dwell, prefetch]);
}
