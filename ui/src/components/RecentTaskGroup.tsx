import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useInfiniteQuery, useQueryClient } from "@tanstack/react-query";
import { readRecentSubtasks } from "@/lib/recent-subtask-requests";
import { ChevronRight } from "lucide-react";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";
import { cn } from "@/lib/utils";
import type { RecentTaskEntry } from "@/lib/recent-tasks";
import { RecentTaskNavItem } from "./RecentTaskNavItem";
import { StatusIcon } from "./StatusIcon";
import { taskStatusIconProps } from "@/lib/task-status-presentation";
import { QueryErrorState, useQueryView } from "./QueryView";

export const RECENT_SUBTASK_PAGE_SIZE = 10;

/** Shared by the standard mixed Recents and Classic Recent Tasks. */
type RecentTaskGroupProps = {
  task: RecentTaskEntry;
  userId: string | null | undefined;
  selectedChild?: RecentTaskEntry;
  children: ReactNode;
  className?: string;
  rail?: boolean;
  renderChild?: (task: RecentTaskEntry) => ReactNode;
  /** Invalid cyclic ancestry remains reachable as plain task rows. */
  flattened?: boolean;
};

export function RecentTaskGroup(props: RecentTaskGroupProps) {
  if (!props.task.subtaskCount || props.rail || props.flattened) return <>{props.children}</>;
  return <ExpandableRecentTaskGroup {...props} />;
}

function ExpandableRecentTaskGroup({ task, userId, selectedChild, children, className, rail = false, renderChild }: RecentTaskGroupProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAllLoaded, setShowAllLoaded] = useState(false);
  const anchor = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(typeof IntersectionObserver === "undefined");
  const contentId = useId();
  const queryClient = useQueryClient();
  const queryKey = [...queryKeys.issues.list(task.companyId), "recent-subtasks", userId ?? "__local_board__", task.id];
  const count = task.subtaskCount ?? 0;
  useEffect(() => { if (selectedChild) setExpanded(true); }, [selectedChild?.id]);
  // Large recent histories must not start one child request per offscreen parent.
  useEffect(() => {
    if (!anchor.current || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(([entry]) => {
      setVisible(Boolean(entry?.isIntersecting));
    });
    observer.observe(anchor.current);
    return () => observer.disconnect();
  }, [count, rail]);
  const enabled = count > 0 && expanded && visible && !rail;
  const query = useInfiniteQuery({
    queryKey,
    queryFn: ({ pageParam, signal }) => readRecentSubtasks(signal, () => issuesApi.listCompact(task.companyId, {
      parentId: task.id, projection: "rows", limit: RECENT_SUBTASK_PAGE_SIZE,
      sortField: "id", sortDir: "asc", afterId: pageParam, includeRoutineExecutions: true, includeReadState: true,
    }, { signal, cache: "no-store", fresh: true })),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage) => lastPage.length === RECENT_SUBTASK_PAGE_SIZE ? lastPage.at(-1)?.id : undefined,
    enabled,
    staleTime: 30_000,
  });
  useEffect(() => {
    if (!enabled) void queryClient.cancelQueries({ queryKey, exact: true });
    // Scope and eligibility own cancellation; queryKey is rebuilt each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [queryClient, task.companyId, task.id, userId, enabled]);
  const preview = () => {
    setShowAllLoaded(false);
    // Cancel first so an in-flight next page cannot restore discarded pages.
    void queryClient.cancelQueries({ queryKey, exact: true }).then(() => {
      queryClient.setQueryData<typeof query.data>(queryKey, data => data ? {
        pages: data.pages.slice(0, 1), pageParams: data.pageParams.slice(0, 1),
      } : data);
    });
  };
  const view = useQueryView(query);
  // Always filter by scope/parent, including cache data after an account switch.
  const pages = query.data?.pages ?? [];
  const loaded = [...new Map(pages.flat().filter(child => child.companyId === task.companyId && child.parentId === task.id)
    .map(child => [child.id, child])).values()];
  let displayed = showAllLoaded ? loaded : loaded.slice(0, RECENT_SUBTASK_PAGE_SIZE);
  const pinned = selectedChild && !displayed.some(child => child.id === selectedChild.id) ? selectedChild : undefined;
  // A selected child beyond the first page replaces the last preview row.
  if (pinned && !showAllLoaded) displayed = displayed.slice(0, RECENT_SUBTASK_PAGE_SIZE - 1);
  const hiddenUnread = Math.max(0, (task.unreadSubtaskCount ?? 0) - displayed.filter(child => child.isUnreadForMe).length - (pinned?.isUnreadForMe ? 1 : 0));
  const remaining = Math.max(0, count - displayed.length - (pinned ? 1 : 0));
  const controlClass = "mx-2 rounded-md px-2 py-1 text-left text-xs text-muted-foreground hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring";
  const childRow = (child: RecentTaskEntry) => renderChild ? renderChild(child)
    : <RecentTaskNavItem task={child} label={child.title} className={className} iconNode={<StatusIcon {...taskStatusIconProps(child)} />} />;

  if (!count || rail) return <>{children}</>;
  return <div ref={anchor} className="min-w-0">
    <div className="relative">
      <div className="pl-5">{children}</div>
      <button type="button" aria-label={`${expanded ? "Collapse" : "Expand"} subtasks of ${task.title}`} aria-expanded={expanded} aria-controls={expanded ? contentId : undefined}
        onClick={() => { if (expanded) preview(); setExpanded(value => !value); }}
        className="absolute left-0 top-1 flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronRight aria-hidden="true" className={cn("size-3.5 transition-transform motion-reduce:transition-none", expanded && "rotate-90")} />
      </button>
    </div>
    {!expanded ? <button type="button" className={cn(controlClass, "ml-7")} onClick={() => setExpanded(true)}>
      {count} subtasks{task.unreadSubtaskCount ? ` · ${task.unreadSubtaskCount} unread` : ""}
    </button> : <div id={contentId} className="ml-5 min-w-0 border-l border-border pl-1" role="group" aria-label={`Subtasks of ${task.title}`}>
      {(view.kind === "loading" || view.kind === "reconnecting") && <p role="status" className="px-3 py-1 text-xs text-muted-foreground">Loading subtasks…</p>}
      {displayed.map(child => <div key={child.id}>{childRow({ ...child, recordedAt: 0 })}</div>)}
      {pinned && childRow(pinned)}
      {view.kind === "error" ? <QueryErrorState size="inline" action="load subtasks" error={view.error} retrying={view.isFetching}
        className="px-3 py-1 text-xs" onRetry={() => { if (query.isFetchNextPageError) void query.fetchNextPage(); else view.retry(); }} />
        : view.data && loaded.length === 0 ? <p className="px-3 py-1 text-xs text-muted-foreground">No subtasks available.</p> : null}
      {remaining > 0 && loaded.length > 0 && (loaded.length > displayed.length || query.hasNextPage) && view.kind !== "error" && <button type="button" disabled={query.isFetching} className={controlClass}
        onClick={() => { setShowAllLoaded(true); if (loaded.length <= displayed.length + (pinned ? 1 : 0) && query.hasNextPage) void query.fetchNextPage(); }}>
        {query.isFetching ? "Loading…" : `Show more (${remaining})`}{hiddenUnread > 0 ? ` · ${hiddenUnread} unread` : ""}
      </button>}
      {showAllLoaded && displayed.length > RECENT_SUBTASK_PAGE_SIZE && <button type="button" className={controlClass} onClick={preview}>Show less</button>}
    </div>}
  </div>;
}
