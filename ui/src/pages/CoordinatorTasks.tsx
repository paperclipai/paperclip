import { readTaskListSortParams, taskListOrderToIssueSort, type TaskListSort } from "@/lib/task-list";
import { useDeferredValue, useEffect, useRef, useState } from "react";
import { useWarmTaskDetailCode } from "@/hooks/useWarmTaskDetailCode";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, SearchX } from "lucide-react";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { attentionApi } from "@/api/attention";
import { heartbeatsApi } from "@/api/heartbeats";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { TaskList, type TaskListItem } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { Button } from "@/components/ui/button";
import { FlyoutAppearanceProvider } from "@/components/ui/flyout";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useTaskListCollection } from "@/hooks/useTaskListCollection";
import { useIssueRowDetails } from "@/hooks/useIssueRowDetails";
import { useCoordinatorWorkspaceEnabled } from "@/hooks/useCoordinatorWorkspaceEnabled";
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { collectLiveIssueIds } from "@/lib/liveIssueIds";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { coordinatorAttentionTasksQueryKey } from "@/lib/coordinator-attention";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { defaultIssueFilterState, type IssueFilterState } from "@/lib/issue-filters";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useSearchParams } from "@/lib/router";
import { loadTaskListView, saveTaskListView, taskListViews, taskListViewStorageKey, type TaskListView } from "@/lib/task-list-views";
import { normalizeTaskViewKey, ORGANIZATION_SCOPED_PARAMS, taskView } from "@/lib/task-views";
import type { Issue } from "@paperclipai/shared";

const pageSize = 200;

/** Coordinator's existing IA and attention feed, rendered with the production
 * components reviewed in Design proposals / Pages / Tasks. */
export function CoordinatorTasks() {
  const { selectedCompanyId: companyId } = useCompany();
  const { userId, loaded: identitySettled } = useCoordinatorWorkspaceEnabled();
  const { openNewIssue } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const listRef = useRef<HTMLElement>(null);
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [layout, setLayout] = useState<"list" | "board">("list");
  const urlAssignee = JSON.stringify(params.getAll("assignee"));
  const urlStatuses = JSON.stringify(params.getAll("status"));
  const urlLabels = JSON.stringify(params.getAll("label").filter(Boolean));
  const urlView = params.get("view");
  const viewStorageKey = taskListViewStorageKey("coordinator", userId ?? "local-board");
  const [preference, setPreference] = useState(() => ({ key: viewStorageKey, view: loadTaskListView(viewStorageKey, undefined, "inbox") }));
  const savedView = preference.key === viewStorageKey ? preference.view : loadTaskListView(viewStorageKey, undefined, "inbox");
  const explicitView = urlView === "needs_attention" ? "blocked" : taskListViews.find(option => option.value === urlView)?.value;
  const organizationScoped = [...ORGANIZATION_SCOPED_PARAMS, "workspaceId", "status", "label", "sortField", "sortDir"].some(param => params.getAll(param).some(Boolean));
  const view: TaskListView = explicitView ?? (organizationScoped || normalizeTaskViewKey(urlView) ? "all" : savedView);
  useEffect(() => {
    if (!identitySettled) return;
    saveTaskListView(viewStorageKey, view);
    setPreference(current => current.key === viewStorageKey && current.view === view ? current : { key: viewStorageKey, view });
  }, [identitySettled, viewStorageKey, view]);
  useEffect(() => {
    if (!identitySettled || urlView) return;
    setParams(current => {
      const next = new URLSearchParams(current);
      next.set("view", view === "blocked" ? "needs_attention" : view);
      return next;
    }, { replace: true });
  }, [identitySettled, urlView, view, setParams]);
  const sort = readTaskListSortParams(params);
  const includeBlockedBy = sort?.column === "workflow";
  const setSort = (nextSort: TaskListSort | undefined) => setParams(current => {
    const next = new URLSearchParams(current);
    if (nextSort) {
      const sharedSort = taskListOrderToIssueSort(nextSort);
      next.set("sortField", sharedSort.sortField);
      next.set("sortDir", sharedSort.sortDir);
    } else {
      next.delete("sortField");
      next.delete("sortDir");
    }
    return next;
  }, { replace: true });
  const routineTasksOnly = params.get("originKind") === "routine_execution";
  const originKind = routineTasksOnly ? "routine_execution" : undefined;
  const normalizedView = normalizeTaskViewKey(urlView);
  const presetStatuses = normalizedView && taskView(normalizedView).surface === "issues" ? taskView(normalizedView).statuses ?? [] : [];
  const initialStatuses: string[] = params.has("status") ? params.getAll("status") : presetStatuses;
  const previousUrlFilters = useRef({ assignee: urlAssignee, statuses: urlStatuses, labels: urlLabels, view: urlView, routineTasksOnly });
  const needsAttention = view === "blocked";
  const query = params.get("q") ?? "";
  const deferredQuery = useDeferredValue(query.trim());
  const useListSort = layout === "list" && !deferredQuery;
  const serverSortField = useListSort && sort?.column === "created" ? "created" : "updated";
  const serverSortDir = useListSort && (sort?.column === "created" || sort?.column === "lastUpdated") && sort.direction === "ascending" ? "asc" : "desc";
  const participantAgentId = params.get("participantAgentId") ?? undefined;
  const workspaces = params.getAll("workspace").filter(Boolean);
  const workspaceIds = [...new Set(workspaces.length ? workspaces : params.getAll("workspaceId").filter(Boolean))];
  const setQuery = (value: string) => setParams(current => {
    const next = new URLSearchParams(current);
    if (value) next.set("q", value); else next.delete("q");
    return next;
  }, { replace: true });
  const setView = (nextView: TaskListView) => setParams(current => {
    const next = new URLSearchParams(current);
    next.set("view", nextView === "blocked" ? "needs_attention" : nextView);
    return next;
  });
  useEffect(() => { setBreadcrumbs([{ label: "Tasks" }]); }, [setBreadcrumbs]);

  const tasks = useInfiniteQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "coordinator-table", "index", userId, deferredQuery, participantAgentId, workspaceIds, originKind, serverSortField, serverSortDir, includeBlockedBy, view === "unread"],
    queryFn: async ({ pageParam, signal }) => {
      const pages = await Promise.all((workspaceIds.length ? workspaceIds : [undefined]).map(workspaceId => issuesApi.listCompact(companyId!, {
      projection: "index", limit: pageSize, offset: pageParam, includeAgentCreatedTasks: true, includeRoutineExecutions: true,
      sortField: serverSortField, sortDir: serverSortDir,
      includeBlockedBy: includeBlockedBy || undefined, q: deferredQuery || undefined, participantAgentId, workspaceId, originKind,
      unreadForUserId: view === "unread" ? "me" : undefined,
      }, { signal })));
      return { items: pages.flat(), hasNextPage: pages.some(page => page.length === pageSize) };
    },
    initialPageParam: 0,
    getNextPageParam: (last, _pages, offset) => last.hasNextPage ? offset + pageSize : undefined,
    enabled: !!companyId && !needsAttention,
  });
  const attention = useQuery({ queryKey: coordinatorAttentionTasksQueryKey(companyId!),
    queryFn: () => attentionApi.taskIndex(companyId!), enabled: !!companyId && needsAttention });
  // Resolve every pending task in bounded index batches, including tasks outside
  // the first list page. Keep full task enrichment out of the collection read.
  const attentionIds = needsAttention ? attention.data?.taskIds ?? [] : [];
  const attentionBatches = Array.from({ length: Math.ceil(attentionIds.length / 100) }, (_, index) => attentionIds.slice(index * 100, (index + 1) * 100));
  const attentionTasks = useQueries({ queries: attentionBatches.map(ids => ({
    queryKey: [...queryKeys.issues.list(companyId!), "coordinator-attention-index", userId, participantAgentId, deferredQuery, originKind, includeBlockedBy, ids],
    queryFn: async ({ signal }: { signal: AbortSignal }) => {
      const rows = await issuesApi.listCompact(companyId!, {
        ids, projection: "index", limit: 100, q: deferredQuery || undefined, participantAgentId, originKind, includeBlockedBy: includeBlockedBy || undefined,
        includeAgentCreatedTasks: true, includeRoutineExecutions: true,
      }, { signal });
      if (!deferredQuery && !participantAgentId && !originKind && ids.some(id => !rows.some(row => row.id === id))) {
        throw new Error("Some tasks with pending decisions couldn’t load.");
      }
      return rows;
    },
    enabled: !!companyId,
  })) });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!), enabled: !!companyId });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId!, { includeArchived: true }), queryFn: () => projectsApi.list(companyId!, { includeArchived: true }), enabled: !!companyId });
  const directory = useQuery({ queryKey: queryKeys.access.companyUserDirectory(companyId!), queryFn: () => accessApi.listUserDirectory(companyId!), enabled: !!companyId });
  const labels = useQuery({ queryKey: queryKeys.issues.labels(companyId!), queryFn: () => issuesApi.listLabels(companyId!), enabled: !!companyId });
  const sharedLiveRuns = useSharedPollingQuery({ companyId, resourceKey: "live-runs", queryKey: queryKeys.liveRuns(companyId!), enabled: !!companyId, refetchInterval: false, leaderOnly: true });
  const liveRuns = useQuery({ queryKey: queryKeys.liveRuns(companyId!), queryFn: () => heartbeatsApi.liveRunsForCompany(companyId!), enabled: sharedLiveRuns.enabled, refetchInterval: sharedLiveRuns.refetchInterval });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns.data, liveRuns.dataUpdatedAt);
  const users = buildCompanyUserLabelMap(directory.data?.users);
  const agentNames = new Map(agents.data?.map(agent => [agent.id, agent.name]));
  const projectById = new Map(projects.data?.map(project => [project.id, project]));
  const records = (needsAttention ? attentionTasks.flatMap(task => task.data ?? []) : tasks.data?.pages.flatMap(page => page.items) ?? []) as Issue[];
  const unreadIds = new Set(view === "unread" ? records.map(issue => issue.id) : []);
  const parentIds = view === "unread" ? [...new Set(records.flatMap(issue =>
    issue.parentId && !unreadIds.has(issue.parentId) ? [issue.parentId] : []))].sort() : [];
  const parentContext = useQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "coordinator-unread-ancestors", userId, parentIds],
    enabled: !!companyId && parentIds.length > 0,
    queryFn: async ({ signal }) => {
      const parents: Issue[] = [];
      const seen = new Set(records.map(issue => issue.id));
      let ids = parentIds;
      while (ids.length) {
        for (const id of ids) seen.add(id);
        const rows: Issue[] = [];
        for (let offset = 0; offset < ids.length; offset += 100) {
          rows.push(...await issuesApi.listCompact(companyId!, {
            ids: ids.slice(offset, offset + 100), projection: "index", limit: 100,
            includeAgentCreatedTasks: true, includeRoutineExecutions: true,
          }, { signal }) as Issue[]);
        }
        parents.push(...rows);
        ids = [...new Set(rows.flatMap(issue => issue.parentId && !seen.has(issue.parentId) ? [issue.parentId] : []))];
      }
      return parents;
    },
  });
  const recordsWithContext = [...records, ...(view === "unread" ? parentContext.data ?? [] : [])];
  const scopedRecords = needsAttention && workspaceIds.length ? records.filter(issue =>
    workspaceIds.includes(issue.executionWorkspaceId ?? "") || workspaceIds.includes(issue.projectWorkspaceId ?? "")) : recordsWithContext;
  const items: TaskListItem[] = [...new Map(scopedRecords.map(issue => [issue.id, issue])).values()].map(issue => ({
    issue: { ...issue, project: issue.project ?? projectById.get(issue.projectId ?? "") },
    unread: unreadIds.has(issue.id),
    createdBy: issue.createdByAgentId ? agentNames.get(issue.createdByAgentId) ?? "Unknown agent" : users.get(issue.createdByUserId ?? "") ?? "Board",
    assignee: issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) ?? "Unknown agent" : users.get(issue.assigneeUserId ?? "") ?? null,
  }));
  const collection = useTaskListCollection({ items, companyId, userId, query, onQueryChange: setQuery, view: needsAttention ? "all" : view,
    layout, onLayoutChange: setLayout,
    searchMode: "server",
    liveIssueIds: collectLiveIssueIds(liveRuns.data, records),
    viewStorageKey,
    initialFilters: { labels: params.getAll("label").filter(Boolean), assignees: params.getAll("assignee"), statuses: initialStatuses, routineTasksOnly },
  });
  useEffect(() => {
    const previous = previousUrlFilters.current;
    if (previous.assignee === urlAssignee && previous.view === urlView && previous.statuses === urlStatuses && previous.labels === urlLabels && previous.routineTasksOnly === routineTasksOnly) return;
    previousUrlFilters.current = { assignee: urlAssignee, statuses: urlStatuses, labels: urlLabels, view: urlView, routineTasksOnly };
    collection.updateFilters({
      ...(previous.labels !== urlLabels ? { labels: params.getAll("label").filter(Boolean) } : {}),
      ...(previous.routineTasksOnly !== routineTasksOnly ? { routineTasksOnly } : {}),
      ...(previous.assignee !== urlAssignee ? { assignees: params.getAll("assignee") } : {}),
      ...(previous.view !== urlView || previous.statuses !== urlStatuses ? { statuses: initialStatuses } : {}),
    });
  }, [urlAssignee, urlView, urlStatuses, urlLabels, initialStatuses, routineTasksOnly, collection.updateFilters]);
  const updateFilters = (patch: Partial<IssueFilterState>) => {
    collection.updateFilters(patch);
    if (patch.assignees === undefined && patch.statuses === undefined && patch.labels === undefined && patch.routineTasksOnly === undefined) return;
    setParams(current => {
      const next = new URLSearchParams(current);
      if (patch.routineTasksOnly !== undefined) {
        if (patch.routineTasksOnly) next.set("originKind", "routine_execution");
        else next.delete("originKind");
      }
      if (patch.labels !== undefined) {
        next.delete("label");
        for (const id of patch.labels) next.append("label", id);
      }
      if (patch.assignees !== undefined) {
        next.delete("assignee");
        for (const id of patch.assignees) next.append("assignee", id);
      }
      if (patch.statuses !== undefined) {
        next.delete("status");
        for (const status of patch.statuses) next.append("status", status);
        const preset = normalizeTaskViewKey(next.get("view"));
        if (preset && taskView(preset).surface === "issues") next.set("view", "all");
      }
      return next;
    }, { replace: true });
  };
  const clearFilters = () => {
    collection.updateFilters(defaultIssueFilterState);
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const key of ["q", "assignee", "status", "label", "originKind"]) next.delete(key);
      if (next.get("view") !== "needs_attention") next.set("view", "all");
      return next;
    }, { replace: true });
  };
  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.issues.list(companyId!) }); void client.invalidateQueries({ queryKey: queryKeys.attention(companyId!) }); },
  });
  const error = (needsAttention ? attention.error ?? attentionTasks.find(task => task.error)?.error : tasks.error)
    ?? (view === "unread" ? parentContext.error : null)
    ?? agents.error ?? projects.error ?? directory.error ?? labels.error ?? update.error
    ?? (collection.filters.liveOnly ? liveRuns.error : null);
  const pending = (needsAttention ? attention.isPending || attentionTasks.some(task => task.isPending) : tasks.isPending)
    || (view === "unread" && parentIds.length > 0 && parentContext.isPending)
    || (collection.filters.liveOnly && liveRuns.isPending);
  useWarmTaskDetailCode(!pending && !error && items.length > 0);
  const { enrichIssueRow, error: rowDetailsError, retry: retryRowDetails } = useIssueRowDetails(
    companyId, listRef,
    `${collection.visibleItems.map(item => item.issue.id).join(",")}:${[...collection.collapsedIds].join(",")}:${collection.layout}`,
    !pending && !error,
    recordsWithContext,
  );
  const enrichItem = (item: TaskListItem): TaskListItem => ({ ...item, issue: enrichIssueRow(item.issue) });
  const narrowed = query || collection.activeFilterCount || view === "inbox" || view === "unread";
  const empty = <EmptyState icon={narrowed ? SearchX : ListChecks}
    message={narrowed ? "No tasks match this view" : needsAttention ? "No tasks need a decision." : "No tasks in this organization"}
    action={narrowed ? "Clear filters" : needsAttention ? undefined : "New Task"}
    onAction={narrowed ? clearFilters : () => openNewIssue()} />;
  const issueLinkState = createIssueDetailLocationState("Tasks", `${location.pathname}${location.search}`, "issues");
  const retry = () => {
    update.reset();
    void (needsAttention ? attention.refetch() : tasks.refetch());
    for (const task of attentionTasks) void task.refetch();
    if (view === "unread" && parentIds.length) void parentContext.refetch();
    void agents.refetch(); void projects.refetch(); void directory.refetch(); void labels.refetch();
    if (collection.filters.liveOnly) void liveRuns.refetch();
  };

  if (!companyId) return <EmptyState icon={ListChecks} message="Select an organization to view tasks." />;
  return <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><section ref={listRef} className="coordinator-task-list task-row-design-preview flex min-w-0 flex-col gap-8" aria-label="Tasks">
    <TaskListToolbar view={view} onViewChange={setView}
      query={collection.query} onQueryChange={collection.setQuery} layout={collection.layout} onLayoutChange={collection.setLayout}
      allExpanded={collection.allExpanded} onToggleExpanded={collection.toggleExpanded} onNewTask={() => openNewIssue()}
      filters={{ enableRoutineTasksFilter: true, state: collection.filters, onChange: updateFilters, activeFilterCount: collection.activeFilterCount,
        agents: agents.data ?? [], projects: projects.data ?? [], labels: labels.data ?? [], currentUserId: userId, creators: collection.creators }} />
    {error ? <div role="alert" className="flex items-center gap-2 text-sm text-destructive"><span>{error instanceof Error ? error.message : "Could not load tasks"}</span><Button variant="outline" size="sm" onClick={retry}>Retry</Button></div> : null}
    {rowDetailsError ? <div role="status" className="flex items-center gap-2 text-sm text-muted-foreground"><span>Task details couldn’t load.</span><Button variant="ghost" size="sm" onClick={() => void retryRowDetails()}>Retry</Button></div> : null}
    {pending ? <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p> : !error && <>
      <div hidden={collection.layout !== "list"} className="design-task-list-panel">{collection.matchingItems.length ? <TaskList key={companyId}
        items={(needsAttention ? collection.matchingItems : collection.visibleItems).map(enrichItem)} allItems={collection.companyItems.map(enrichItem)}
        collectionKey={JSON.stringify([companyId, userId, needsAttention, deferredQuery, participantAgentId, workspaceIds, collection.view, collection.filters])}
        sort={sort} onSortChange={setSort}
        issueLinkState={issueLinkState} collapsedIds={collection.collapsedIds} onCollapsedIdsChange={collection.setCollapsedIds} /> : empty}</div>
      {collection.layout === "board" ? collection.matchingItems.length
        ? <KanbanBoard showOverflowFades issues={collection.matchingItems.map(item => enrichIssueRow(item.issue))} agents={agents.data} onUpdateIssue={(id, data) => update.mutate({ id, data })} /> : empty : null}
      {!needsAttention && tasks.hasNextPage ? <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><span>{view === "unread" ? unreadIds.size : items.length} tasks loaded. Load more to include them in filters.</span><Button variant="outline" size="sm" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? "Loading…" : "Load more tasks"}</Button></div> : null}
    </>}
  </section></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>;
}
