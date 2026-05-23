import * as React from "react";
import { useMemo, useState } from "react";
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
  const [open, setOpen] = useState(false);
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
        setOpen(true);
        onFocus?.(event);
      }}
      onBlur={(event) => {
        // Let clicks inside the portaled quicklook content finish before closing.
        setTimeout(() => setOpen(false), 0);
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
        setOpen(false);
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
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        asChild
        onMouseEnter={() => {
          handlePrefetch();
          setOpen(true);
        }}
        onMouseLeave={() => setOpen(false)}
      >
        {link}
      </PopoverTrigger>
      <PopoverContent
        className="w-72 p-3"
        side={issueQuicklookSide}
        align={issueQuicklookAlign}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
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
              <p className="text-xs text-muted-foreground">Unable to load issue preview.</p>
            ) : null}
          </div>
        )}
      </PopoverContent>
    </Popover>
  );
});
