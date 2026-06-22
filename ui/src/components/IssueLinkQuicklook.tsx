import * as React from "react";
import { useMemo } from "react";
import * as RouterDom from "react-router-dom";
import type { Issue } from "@paperclipai/shared";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { timeAgo } from "@/lib/timeAgo";
import { createIssueDetailPath, withIssueDetailHeaderSeed } from "@/lib/issueDetailBreadcrumb";
import {
  getIssueDetailQueryOptions,
  ISSUE_DETAIL_STALE_TIME_MS,
  prefetchIssueDetail,
} from "@/lib/issueDetailCache";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusIcon } from "@/components/StatusIcon";

/* ------------------------------------------------------------------ */
/*  Single-flight quicklook store                                      */
/*                                                                     */
/*  Every issue link renders its own Radix Popover. In a dense list    */
/*  (e.g. the Conference Room agent feed) independent per-card open     */
/*  state lets popovers overlap, linger, and stack — two flyouts at    */
/*  once, sometimes showing the wrong card. This module-level store    */
/*  enforces exactly one open quicklook across the whole tree: opening  */
/*  one closes any other.                                               */
/* ------------------------------------------------------------------ */

let activeQuicklookId: symbol | null = null;
const quicklookListeners = new Set<() => void>();

function emitQuicklookChange() {
  for (const listener of quicklookListeners) listener();
}

function openQuicklookId(id: symbol) {
  if (activeQuicklookId === id) return;
  activeQuicklookId = id;
  emitQuicklookChange();
}

function closeQuicklookId(id: symbol) {
  if (activeQuicklookId !== id) return;
  activeQuicklookId = null;
  emitQuicklookChange();
}

function subscribeQuicklook(listener: () => void) {
  quicklookListeners.add(listener);
  return () => {
    quicklookListeners.delete(listener);
  };
}

function useIsQuicklookOpen(id: symbol) {
  return React.useSyncExternalStore(
    subscribeQuicklook,
    () => activeQuicklookId === id,
    () => false,
  );
}

/** Hover-intent delay (ms) before a quicklook opens — prevents flicker
 *  as the pointer crosses cards on its way somewhere else. */
const QUICKLOOK_OPEN_DELAY_MS = 120;

function summarizeIssueDescription(description: string | null | undefined) {
  if (!description) return null;
  const summary = description
    .replace(/!\[[^\]]*]\([^)]+\)/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_`~-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!summary) return null;
  return summary.length > 180 ? `${summary.slice(0, 177).trimEnd()}...` : summary;
}

export function IssueQuicklookCard({
  issue,
  linkTo,
  linkState,
  compact = false,
}: {
  issue: Issue;
  linkTo: RouterDom.To;
  linkState?: unknown;
  compact?: boolean;
}) {
  const description = useMemo(() => summarizeIssueDescription(issue.description), [issue.description]);

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      <div className="flex items-start gap-2">
        <StatusIcon status={issue.status} blockerAttention={issue.blockerAttention} className="mt-0.5 shrink-0" />
        <RouterDom.Link
          to={linkTo}
          state={linkState ?? withIssueDetailHeaderSeed(null, issue)}
          className="text-sm font-medium leading-snug hover:underline line-clamp-2"
        >
          {issue.title}
        </RouterDom.Link>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="font-mono">{issue.identifier ?? issue.id.slice(0, 8)}</span>
        <span>&middot;</span>
        <span>{issue.status.replace(/_/g, " ")}</span>
        <span>&middot;</span>
        <span>{timeAgo(new Date(issue.updatedAt))}</span>
      </div>
      {description ? (
        <p className="text-xs leading-5 text-muted-foreground [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:4] overflow-hidden">
          {description}
        </p>
      ) : null}
    </div>
  );
}

export const IssueLinkQuicklook = React.forwardRef<
  HTMLAnchorElement,
  React.ComponentProps<typeof RouterDom.Link> & {
    issuePathId: string;
    disableIssueQuicklook?: boolean;
    issuePrefetch?: Issue | null;
    issueQuicklookSide?: React.ComponentProps<typeof PopoverContent>["side"];
    issueQuicklookAlign?: React.ComponentProps<typeof PopoverContent>["align"];
  }
>(function IssueLinkQuicklookImpl(
  {
    issuePathId,
    to,
    children,
    className,
    state,
    disableIssueQuicklook = false,
    issuePrefetch = null,
    issueQuicklookSide = "top",
    issueQuicklookAlign = "start",
    onClick,
    onClickCapture,
    onMouseEnter,
    onFocus,
    onBlur,
    onTouchStart,
    ...props
  },
  ref,
) {
  const queryClient = useQueryClient();
  const instanceId = React.useMemo(() => Symbol("issue-quicklook"), []);
  const open = useIsQuicklookOpen(instanceId);
  const openTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelScheduledOpen = React.useCallback(() => {
    if (openTimerRef.current) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  // Open immediately (keyboard focus, or re-entering the open popover).
  const openNow = React.useCallback(() => {
    cancelScheduledOpen();
    openQuicklookId(instanceId);
  }, [cancelScheduledOpen, instanceId]);

  // Open after the hover-intent delay (pointer entering a card).
  const scheduleOpen = React.useCallback(() => {
    cancelScheduledOpen();
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      openQuicklookId(instanceId);
    }, QUICKLOOK_OPEN_DELAY_MS);
  }, [cancelScheduledOpen, instanceId]);

  const close = React.useCallback(() => {
    cancelScheduledOpen();
    closeQuicklookId(instanceId);
  }, [cancelScheduledOpen, instanceId]);

  // Clear any pending timer and release the active slot on unmount.
  React.useEffect(() => {
    return () => {
      cancelScheduledOpen();
      closeQuicklookId(instanceId);
    };
  }, [cancelScheduledOpen, instanceId]);

  const prefetchedState = issuePrefetch ? withIssueDetailHeaderSeed(state, issuePrefetch) : state;
  const { data, isLoading } = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issuePathId, { placeholderIssue: issuePrefetch ?? undefined }),
    enabled: open,
    staleTime: ISSUE_DETAIL_STALE_TIME_MS,
  });

  const detailPath = createIssueDetailPath(issuePathId);
  const handlePrefetch = React.useCallback(() => {
    void prefetchIssueDetail(queryClient, issuePathId, { issue: issuePrefetch });
  }, [issuePathId, issuePrefetch, queryClient]);
  const link = (
    <RouterDom.Link
      ref={ref}
      to={to}
      state={prefetchedState}
      className={className}
      onMouseEnter={(event) => {
        handlePrefetch();
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        handlePrefetch();
        openNow();
        onFocus?.(event);
      }}
      onBlur={(event) => {
        // Let clicks inside the portaled quicklook content finish before closing.
        setTimeout(() => close(), 0);
        onBlur?.(event);
      }}
      onTouchStart={(event) => {
        handlePrefetch();
        onTouchStart?.(event);
      }}
      onClickCapture={(event) => {
        handlePrefetch();
        onClickCapture?.(event);
      }}
      onClick={(event) => {
        close();
        onClick?.(event);
      }}
      {...props}
    >
      {children}
    </RouterDom.Link>
  );

  if (disableIssueQuicklook) {
    return link;
  }

  return (
    <Popover open={open} onOpenChange={(next) => (next ? openNow() : close())}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => {
          handlePrefetch();
          scheduleOpen();
        }}
        onMouseLeave={close}
      >
        {link}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side={issueQuicklookSide}
        align={issueQuicklookAlign}
        onMouseEnter={openNow}
        onMouseLeave={close}
        onOpenAutoFocus={(event) => event.preventDefault()}
      >
        {data ? (
          <IssueQuicklookCard issue={data} linkTo={detailPath} linkState={prefetchedState} compact />
        ) : (
          <div className="space-y-2">
            <div className="h-4 w-24 rounded bg-accent/50" />
            <div className="h-4 w-full rounded bg-accent/40" />
            <div className="h-4 w-3/4 rounded bg-accent/30" />
            {!isLoading ? (
              <p className="text-xs text-muted-foreground">Unable to load task preview.</p>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
