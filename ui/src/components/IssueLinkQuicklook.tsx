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
  prefetchIssueDetailForNavigation,
} from "@/lib/issueDetailCache";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { StatusGlyph } from "@/components/StatusGlyph";
import { ProjectTile } from "@/components/ProjectTile";

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

/**
 * Distance from the quicklook's outer edge to its first column of text: the
 * `p-3` padding in `QUICKLOOK_CONTENT_CLASS` (12px) plus the 1px border that
 * `PopoverContent` draws. Both sit between the box edge and the content, so
 * both have to be cancelled to line the text up with the trigger's.
 */
const QUICKLOOK_CONTENT_INSET_PX = 12 + 1;

/** Shared shell for every surface that renders `IssueQuicklookCard`. */
export const QUICKLOOK_CONTENT_CLASS = "w-72 p-3";

/**
 * Cancel the card's own inset along the align axis, so the preview lines up
 * with the *text* that opened it rather than with that text's box.
 *
 * Radix aligns box to box: with `align="start"` the card's left edge meets the
 * trigger's left edge, which leaves the card's text pushed right by its border
 * and padding — visibly off against the task key above it. Pulling the box back
 * by exactly that inset puts the card's first column of text on the same
 * vertical line as the trigger's. `end` needs the mirror of it; `center` has no
 * edge to line up with, so it gets nothing.
 */
export function quicklookAlignOffset(align: "start" | "center" | "end" = "start"): number {
  if (align === "start") return -QUICKLOOK_CONTENT_INSET_PX;
  if (align === "end") return QUICKLOOK_CONTENT_INSET_PX;
  return 0;
}

export type IssueQuicklookIssue = Pick<Issue, "id" | "title" | "updatedAt"> & {
  identifier?: string | null;
  status: string;
  priority: string;
  description?: string | null;
  blockerAttention?: Issue["blockerAttention"];
  projectId?: string | null;
  project?: { name?: string | null } | null;
  originKind?: string;
  originId?: string | null;
};

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

/** "·" between facts in the quicklook's meta and status lines. */
function QuicklookSeparator({ className }: { className?: string }) {
  return (
    <span className={cn("text-xs", className)} aria-hidden>
      ·
    </span>
  );
}

/** "in_review" -> "In review". The card states the status as a word, not a chip. */
function statusLabel(status: string): string {
  const words = status.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/**
 * The standard task preview card. Every hover preview of a task in the app
 * renders this, so the same three rows appear in the same order everywhere:
 *
 *   1. meta     — status glyph · task key [· project] .......... last activity
 *   2. title
 *   3. summary  — first lines of the description
 *
 * The meta row splits: identity on the left, recency pinned right. Identity
 * leads because a preview answers "which task is this?", and the title alone
 * does not.
 *
 * Status carries no word of its own — the glyph is the status, exactly as it is
 * on task rows and decision cards. Because that leaves shape and colour as the
 * only visual signal, the glyph is given a `title`, so it renders as
 * `role="img"` with the status as its accessible name. The status stays
 * available to a screen reader without spending a line on it.
 *
 * Three shapes the row must hold, per the design mock:
 *   1. no project  — glyph, key, and the timestamp hard right
 *   2. project     — a "·" and the project tile plus name join the left group
 *   3. truncation  — a long project name ellipsizes; the key and the timestamp
 *                    never do, so the two facts that identify the task survive
 *                    at any width
 */
export function IssueQuicklookCard({
  issue,
  linkTo,
  linkState,
  compact = false,
}: {
  issue: IssueQuicklookIssue;
  linkTo: RouterDom.To;
  linkState?: unknown;
  compact?: boolean;
}) {
  const description = useMemo(() => summarizeIssueDescription(issue.description), [issue.description]);
  const projectName = issue.project?.name;

  return (
    <div className={cn("space-y-2", compact && "space-y-1.5")}>
      <div className="flex items-center gap-1">
        <div className="flex min-w-0 flex-1 items-center gap-1">
          <StatusGlyph status={issue.status} size="md" title={statusLabel(issue.status)} />
          <span className="shrink-0 font-mono text-(length:--text-micro) text-muted-foreground">
            {issue.identifier ?? issue.id.slice(0, 8)}
          </span>
          {projectName ? (
            <>
              <QuicklookSeparator className="shrink-0 text-muted-foreground" />
              <span
                className="flex min-w-0 max-w-(--sz-12rem) flex-1 items-center gap-1 text-(length:--text-micro) text-muted-foreground"
                title={projectName}
                data-testid="quicklook-project"
              >
                <ProjectTile size="xs" />
                <span className="truncate">{projectName}</span>
              </span>
            </>
          ) : null}
        </div>
        <span className="shrink-0 text-(length:--text-micro) text-muted-foreground">
          {timeAgo(new Date(issue.updatedAt))}
        </span>
      </div>

      <RouterDom.Link
        to={linkTo}
        state={linkState ?? withIssueDetailHeaderSeed(null, issue)}
        className="block text-sm font-medium leading-snug hover:underline line-clamp-2"
      >
        {issue.title}
      </RouterDom.Link>

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
  const triggerRef = React.useRef<HTMLAnchorElement | null>(null);
  const contentRef = React.useRef<HTMLDivElement | null>(null);

  // Keep the caller's ref working while we also hold our own handle on the
  // trigger node (needed by the pointer-escape guard below).
  const setTriggerRef = React.useCallback(
    (node: HTMLAnchorElement | null) => {
      triggerRef.current = node;
      if (typeof ref === "function") ref(node);
      else if (ref) ref.current = node;
    },
    [ref],
  );

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

  // Pointer-escape guard.
  //
  // The only close paths are `mouseleave` on the trigger and on the content,
  // and a leave event is not guaranteed: when the layout shifts, the element
  // moves out from under a stationary pointer rather than the pointer moving
  // off the element, and no leave fires. Expanding a decision row does exactly
  // that, stranding an open quicklook on screen until something else happens
  // to open one.
  //
  // Rather than enumerate the ways a leave can be missed, re-check the
  // browser's own hover state on every pointer move and close as soon as the
  // pointer is over neither the trigger nor the card. Keyboard use is exempt:
  // a quicklook opened by focus stays put while focus remains inside it.
  React.useEffect(() => {
    if (!open) return;

    // Slack around each box, so crossing the 4px gap between the trigger and
    // the card does not read as leaving.
    const EDGE_SLACK_PX = 12;
    const nearBox = (element: Element | null, x: number, y: number) => {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      return (
        x >= rect.left - EDGE_SLACK_PX
        && x <= rect.right + EDGE_SLACK_PX
        && y >= rect.top - EDGE_SLACK_PX
        && y <= rect.bottom + EDGE_SLACK_PX
      );
    };

    const stillEngaged = (x: number, y: number) => {
      const trigger = triggerRef.current;
      const content = contentRef.current;
      // Two independent signals, and closing needs both to agree the pointer is
      // gone: `:hover` is authoritative about stacking and overlap, geometry
      // survives the cases where hover state is not updated. Either one holding
      // keeps the card open, so a real pointer resting on it is never dropped.
      if (trigger?.matches(":hover") || content?.matches(":hover")) return true;
      if (nearBox(trigger, x, y) || nearBox(content, x, y)) return true;
      // Opened by keyboard: hold while focus is still inside.
      const active = document.activeElement;
      return trigger === active || (!!content && !!active && content.contains(active));
    };

    const onPointerMove = (event: PointerEvent) => {
      if (!stillEngaged(event.clientX, event.clientY)) close();
    };
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => document.removeEventListener("pointermove", onPointerMove);
  }, [open, close]);

  const prefetchedState = issuePrefetch ? withIssueDetailHeaderSeed(state, issuePrefetch) : state;
  const { data, isLoading } = useQuery({
    ...getIssueDetailQueryOptions(queryClient, issuePathId, { placeholderIssue: issuePrefetch ?? undefined }),
    enabled: open,
    staleTime: ISSUE_DETAIL_STALE_TIME_MS,
  });

  const detailPath = createIssueDetailPath(issuePathId);
  const handlePrefetch = React.useCallback(() => {
    void prefetchIssueDetailForNavigation(queryClient, issuePathId, { issue: issuePrefetch });
  }, [issuePathId, issuePrefetch, queryClient]);
  const link = (
    <RouterDom.Link
      ref={setTriggerRef}
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
        ref={contentRef}
        // Opts into the scale-from-trigger motion defined in index.css.
        data-quicklook
        className={QUICKLOOK_CONTENT_CLASS}
        side={issueQuicklookSide}
        align={issueQuicklookAlign}
        alignOffset={quicklookAlignOffset(issueQuicklookAlign)}
        onMouseEnter={openNow}
        onMouseLeave={close}
        // A preview must not move focus in either direction. Opening already
        // declined to take focus; closing has to decline to hand it back, or
        // Radix focuses the trigger on the way out — and because this link
        // opens the quicklook `onFocus`, that focus immediately reopens the
        // card that was just dismissed. Hovering away then leaves it up
        // permanently: close, refocus, reopen, forever.
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={(event) => event.preventDefault()}
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
