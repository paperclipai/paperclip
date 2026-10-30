import { useDeferredValue, useEffect, useRef } from "react";
import { useInfiniteQuery, useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, SearchX } from "lucide-react";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { attentionApi } from "@/api/attention";
import { heartbeatsApi } from "@/api/heartbeats";
import { useAccountIdentity } from "@/api/companies-query";
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
import { usePublishSharedQueryData, useSharedPollingQuery } from "@/hooks/useSharedPolling";
import { collectLiveIssueIds } from "@/lib/liveIssueIds";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { coordinatorAttentionQueryKey, pendingDecisionTaskIds } from "@/lib/coordinator-attention";
import { createIssueDetailLocationState } from "@/lib/issueDetailBreadcrumb";
import { defaultIssueFilterState, type IssueFilterState } from "@/lib/issue-filters";
import { queryKeys } from "@/lib/queryKeys";
import { useLocation, useSearchParams } from "@/lib/router";
import { taskListViewStorageKey } from "@/lib/task-list-views";
import { normalizeTaskViewKey, taskView } from "@/lib/task-views";

const pageSize = 200;
const views = [{ value: "all", label: "All tasks" }, { value: "blocked", label: "Needs attention" }] as const;

/** Coordinator's existing IA and attention feed, rendered with the production
 * components reviewed in Design proposals / Pages / Tasks. */
export function CoordinatorTasks() {
  const { selectedCompanyId: companyId } = useCompany();
  const { userId } = useAccountIdentity();
  const { openNewIssue } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const urlAssignee = JSON.stringify(params.getAll("assignee"));
  const urlStatuses = JSON.stringify(params.getAll("status"));
  const urlView = params.get("view");
  const normalizedView = normalizeTaskViewKey(urlView);
  const presetStatuses = normalizedView && taskView(normalizedView).surface === "issues" ? taskView(normalizedView).statuses ?? [] : [];
  const initialStatuses: string[] = params.has("status") ? params.getAll("status") : presetStatuses;
  const previousUrlFilters = useRef({ assignee: urlAssignee, statuses: urlStatuses, view: urlView });
  const needsAttention = params.get("view") === "needs_attention";
  const query = params.get("q") ?? "";
  const deferredQuery = useDeferredValue(query.trim());
  const participantAgentId = params.get("participantAgentId") ?? undefined;
  const workspaces = params.getAll("workspace").filter(Boolean);
  const workspaceIds = [...new Set(workspaces.length ? workspaces : params.getAll("workspaceId").filter(Boolean))];
  const setQuery = (value: string) => setParams(current => {
    const next = new URLSearchParams(current);
    if (value) next.set("q", value); else next.delete("q");
    return next;
  }, { replace: true });
  const setView = (attention: boolean) => setParams(current => {
    const next = new URLSearchParams(current);
    next.set("view", attention ? "needs_attention" : "all");
    return next;
  });
  useEffect(() => { setBreadcrumbs([{ label: "Tasks" }]); }, [setBreadcrumbs]);

  const tasks = useInfiniteQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "coordinator-table", userId, deferredQuery, participantAgentId, workspaceIds],
    queryFn: async ({ pageParam, signal }) => {
      const pages = await Promise.all((workspaceIds.length ? workspaceIds : [undefined]).map(workspaceId => issuesApi.list(companyId!, {
      limit: pageSize, offset: pageParam, includeAgentCreatedTasks: true, includeRoutineExecutions: true,
      sortField: "updated", sortDir: "desc", q: deferredQuery || undefined, participantAgentId, workspaceId,
      }, { signal })));
      return { items: pages.flat(), hasNextPage: pages.some(page => page.length === pageSize) };
    },
    initialPageParam: 0,
    getNextPageParam: (last, _pages, offset) => last.hasNextPage ? offset + pageSize : undefined,
    enabled: !!companyId && !needsAttention,
  });
  const attention = useQuery({ queryKey: coordinatorAttentionQueryKey(companyId!),
    queryFn: () => attentionApi.list(companyId!, { all: true }), enabled: !!companyId && needsAttention });
  // Hydrate every pending task, including those outside the first list page.
  // Do not substitute blocked/in-review status for an actual pending decision.
  const attentionIds = needsAttention ? [...pendingDecisionTaskIds(attention.data?.items ?? [])] : [];
  const attentionTasks = useQueries({ queries: attentionIds.map(id => ({
    queryKey: participantAgentId ? [...queryKeys.issues.list(companyId!), "coordinator-attention-participant", userId, participantAgentId, id] : queryKeys.issues.detail(id),
    queryFn: async ({ signal }: { signal: AbortSignal }) => participantAgentId
      ? (await issuesApi.list(companyId!, { ids: [id], participantAgentId, includeAgentCreatedTasks: true, includeRoutineExecutions: true }, { signal }))[0] ?? null
      : issuesApi.get(id, { signal }),
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
  const records = needsAttention ? attentionTasks.flatMap(task => task.data ? [task.data] : []) : tasks.data?.pages.flatMap(page => page.items) ?? [];
  const scopedRecords = needsAttention && workspaceIds.length ? records.filter(issue =>
    workspaceIds.includes(issue.executionWorkspaceId ?? "") || workspaceIds.includes(issue.projectWorkspaceId ?? "")) : records;
  const items: TaskListItem[] = [...new Map(scopedRecords.map(issue => [issue.id, issue])).values()].map(issue => ({
    issue: { ...issue, project: issue.project ?? projectById.get(issue.projectId ?? "") },
    createdBy: issue.createdByAgentId ? agentNames.get(issue.createdByAgentId) ?? "Unknown agent" : users.get(issue.createdByUserId ?? "") ?? "Board",
    assignee: issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) ?? "Unknown agent" : users.get(issue.assigneeUserId ?? "") ?? null,
  }));
  const collection = useTaskListCollection({ items, companyId, userId, query, onQueryChange: setQuery, view: "all",
    searchMode: needsAttention ? "local" : "server",
    liveIssueIds: collectLiveIssueIds(liveRuns.data, records),
    viewStorageKey: taskListViewStorageKey("coordinator", userId ?? "local-board"),
    initialFilters: { assignees: params.getAll("assignee"), statuses: initialStatuses },
  });
  useEffect(() => {
    const previous = previousUrlFilters.current;
    if (previous.assignee === urlAssignee && previous.view === urlView && previous.statuses === urlStatuses) return;
    previousUrlFilters.current = { assignee: urlAssignee, statuses: urlStatuses, view: urlView };
    collection.updateFilters({
      ...(previous.assignee !== urlAssignee ? { assignees: params.getAll("assignee") } : {}),
      ...(previous.view !== urlView || previous.statuses !== urlStatuses ? { statuses: initialStatuses } : {}),
    });
  }, [urlAssignee, urlView, urlStatuses, initialStatuses, collection.updateFilters]);
  const updateFilters = (patch: Partial<IssueFilterState>) => {
    collection.updateFilters(patch);
    if (patch.assignees === undefined && patch.statuses === undefined) return;
    setParams(current => {
      const next = new URLSearchParams(current);
      if (patch.assignees !== undefined) {
        next.delete("assignee");
        for (const id of patch.assignees) next.append("assignee", id);
      }
      if (patch.statuses !== undefined) {
        next.delete("status");
        for (const status of patch.statuses) next.append("status", status);
        // A changed status selection replaces the legacy preset, while the
        // independent Needs attention surface remains selected.
        if (next.get("view") !== "needs_attention") next.set("view", "all");
      }
      return next;
    }, { replace: true });
  };
  const clearFilters = () => {
    collection.updateFilters(defaultIssueFilterState);
    setParams(current => {
      const next = new URLSearchParams(current);
      for (const key of ["q", "assignee", "status"]) next.delete(key);
      if (next.get("view") !== "needs_attention") next.set("view", "all");
      return next;
    }, { replace: true });
  };
  const update = useMutation({ mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.issues.list(companyId!) }); void client.invalidateQueries({ queryKey: coordinatorAttentionQueryKey(companyId!) }); },
  });
  const error = (needsAttention ? attention.error ?? attentionTasks.find(task => task.error)?.error : tasks.error)
    ?? agents.error ?? projects.error ?? directory.error ?? labels.error ?? update.error
    ?? (collection.filters.liveOnly ? liveRuns.error : null);
  const pending = (needsAttention ? attention.isPending || attentionTasks.some(task => task.isPending) : tasks.isPending)
    || (collection.filters.liveOnly && liveRuns.isPending);
  const empty = <EmptyState icon={query || collection.activeFilterCount ? SearchX : ListChecks}
    message={query || collection.activeFilterCount ? "No tasks match this view" : needsAttention ? "No tasks need a decision." : "No tasks in this organization"}
    action={query || collection.activeFilterCount ? "Clear filters" : needsAttention ? undefined : "New Task"}
    onAction={query || collection.activeFilterCount ? clearFilters : () => openNewIssue()} />;
  const issueLinkState = createIssueDetailLocationState("Tasks", `${location.pathname}${location.search}`, "issues");
  const retry = () => {
    update.reset();
    void (needsAttention ? attention.refetch() : tasks.refetch());
    for (const task of attentionTasks) void task.refetch();
    void agents.refetch(); void projects.refetch(); void directory.refetch(); void labels.refetch();
    if (collection.filters.liveOnly) void liveRuns.refetch();
  };

  if (!companyId) return <EmptyState icon={ListChecks} message="Select an organization to view tasks." />;
  return <FlyoutAppearanceProvider><TruncatedTextMarqueeProvider><section className="coordinator-task-list task-row-design-preview flex min-w-0 flex-col gap-8" aria-label="Tasks">
    <TaskListToolbar view={needsAttention ? "blocked" : "all"} viewOptions={views} onViewChange={view => setView(view === "blocked")}
      query={collection.query} onQueryChange={collection.setQuery} layout={collection.layout} onLayoutChange={collection.setLayout}
      allExpanded={collection.allExpanded} onToggleExpanded={collection.toggleExpanded} onNewTask={() => openNewIssue()}
      filters={{ state: collection.filters, onChange: updateFilters, activeFilterCount: collection.activeFilterCount,
        agents: agents.data ?? [], projects: projects.data ?? [], labels: labels.data ?? [], currentUserId: userId, creators: collection.creators }} />
    {error ? <div role="alert" className="flex items-center gap-2 text-sm text-destructive"><span>{error instanceof Error ? error.message : "Could not load tasks"}</span><Button variant="outline" size="sm" onClick={retry}>Retry</Button></div> : null}
    {pending ? <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p> : !error && <>
      <div hidden={collection.layout !== "list"} className="design-task-list-panel">{collection.matchingItems.length ? <TaskList key={companyId}
        items={needsAttention ? collection.matchingItems : collection.visibleItems} allItems={collection.companyItems}
        issueLinkState={issueLinkState} collapsedIds={collection.collapsedIds} onCollapsedIdsChange={collection.setCollapsedIds} /> : empty}</div>
      {collection.layout === "board" ? collection.matchingItems.length
        ? <KanbanBoard showOverflowFades issues={collection.matchingItems.map(item => item.issue)} agents={agents.data} onUpdateIssue={(id, data) => update.mutate({ id, data })} /> : empty : null}
      {!needsAttention && tasks.hasNextPage ? <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground"><span>{items.length} tasks loaded. Load more to include them in filters.</span><Button variant="outline" size="sm" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? "Loading…" : "Load more tasks"}</Button></div> : null}
    </>}
  </section></TruncatedTextMarqueeProvider></FlyoutAppearanceProvider>;
}
