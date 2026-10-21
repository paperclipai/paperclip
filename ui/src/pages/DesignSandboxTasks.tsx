import { useEffect } from "react";
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ListChecks, SearchX } from "lucide-react";
import { accessApi } from "@/api/access";
import { agentsApi } from "@/api/agents";
import { useAccountIdentity } from "@/api/companies-query";
import { issuesApi } from "@/api/issues";
import { projectsApi } from "@/api/projects";
import { EmptyState } from "@/components/EmptyState";
import { KanbanBoard } from "@/components/KanbanBoard";
import { TaskList, type TaskListItem } from "@/components/TaskList";
import { TaskListToolbar } from "@/components/TaskListToolbar";
import { TruncatedTextMarqueeProvider } from "@/components/TruncatedText";
import { Button } from "@/components/ui/button";
import { useBreadcrumbs } from "@/context/BreadcrumbContext";
import { useCompany } from "@/context/CompanyContext";
import { useDialogActions } from "@/context/DialogContext";
import { useTaskListCollection } from "@/hooks/useTaskListCollection";
import { buildCompanyUserLabelMap } from "@/lib/company-members";
import { queryKeys } from "@/lib/queryKeys";
import { taskListViewStorageKey } from "@/lib/task-list-views";
import type { Issue } from "@paperclipai/shared";

const pageSize = 200;

/** Real API adapter for the Design proposals / Pages / Tasks composition.
 * All visual and collection behavior comes from the reviewed shared subjects. */
export function DesignSandboxTasks() {
  const { selectedCompanyId: companyId } = useCompany();
  const { userId } = useAccountIdentity();
  const { openNewIssue } = useDialogActions();
  const { setBreadcrumbs } = useBreadcrumbs();
  const client = useQueryClient();
  useEffect(() => { setBreadcrumbs([{ label: "Tasks" }]); }, [setBreadcrumbs]);

  const tasks = useInfiniteQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "design-sandbox", userId],
    queryFn: ({ pageParam, signal }) => issuesApi.list(companyId!, {
      limit: pageSize, offset: pageParam, includeAgentCreatedTasks: true,
      includeRoutineExecutions: true, sortField: "id", sortDir: "asc",
    }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last, _pages, offset) => last.length === pageSize ? offset + pageSize : undefined,
    enabled: !!companyId,
  });
  const agents = useQuery({ queryKey: queryKeys.agents.list(companyId!), queryFn: () => agentsApi.list(companyId!), enabled: !!companyId });
  const projects = useQuery({ queryKey: queryKeys.projects.list(companyId!, { includeArchived: true }), queryFn: () => projectsApi.list(companyId!, { includeArchived: true }), enabled: !!companyId });
  const directory = useQuery({ queryKey: queryKeys.access.companyUserDirectory(companyId!), queryFn: () => accessApi.listUserDirectory(companyId!), enabled: !!companyId });
  const labels = useQuery({ queryKey: queryKeys.issues.labels(companyId!), queryFn: () => issuesApi.listLabels(companyId!), enabled: !!companyId });
  // The ordinary organization list does not include viewer read context.
  // Ask the server for the signed-in user's unread set instead of guessing
  // unread state from dates or reusing Storybook fixture flags.
  const unread = useQuery({
    queryKey: [...queryKeys.issues.list(companyId!), "design-sandbox-unread", userId],
    queryFn: async ({ signal }) => {
      const ids = new Set<string>();
      let page: Issue[];
      let offset = 0;
      do {
        page = await issuesApi.list(companyId!, { unreadForUserId: "me", includeAgentCreatedTasks: true,
          includeRoutineExecutions: true, limit: pageSize, offset, sortField: "id", sortDir: "asc" }, { signal });
        for (const issue of page) ids.add(issue.id);
        offset += pageSize;
      } while (page.length === pageSize);
      return ids;
    },
    enabled: !!companyId && !!userId,
  });
  const users = buildCompanyUserLabelMap(directory.data?.users);
  const agentNames = new Map(agents.data?.map(agent => [agent.id, agent.name]));
  const projectById = new Map(projects.data?.map(project => [project.id, project]));
  const items: TaskListItem[] = [...new Map((tasks.data?.pages.flat() ?? []).map(issue => [issue.id, issue])).values()].map(issue => ({
    issue: { ...issue, project: issue.project ?? projectById.get(issue.projectId ?? "") },
    unread: unread.data?.has(issue.id) ?? false,
    createdBy: issue.createdByAgentId ? agentNames.get(issue.createdByAgentId) ?? "Unknown agent" : users.get(issue.createdByUserId ?? "") ?? (issue.createdByUserId === "local-board" ? "Board" : "Unknown user"),
    assignee: issue.assigneeAgentId ? agentNames.get(issue.assigneeAgentId) ?? "Unknown agent" : users.get(issue.assigneeUserId ?? "") ?? (issue.assigneeUserId === "local-board" ? "Board" : null),
  }));
  const collection = useTaskListCollection({ items, companyId, userId,
    viewStorageKey: taskListViewStorageKey("design-integration-sandbox", userId ?? "local-board"),
  });
  const update = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) => issuesApi.update(id, data),
    onSuccess: () => { void client.invalidateQueries({ queryKey: queryKeys.issues.list(companyId!) }); },
  });
  const error = tasks.error ?? agents.error ?? projects.error ?? directory.error ?? labels.error ?? unread.error ?? update.error;
  const empty = collection.companyItems.length === 0
    ? <EmptyState icon={ListChecks} message="No tasks in this organization" action="New Task" onAction={() => openNewIssue()} />
    : <EmptyState icon={SearchX} message="No tasks match this view" action="Clear filters" hideActionIcon onAction={collection.clear} />;

  if (!companyId) return <EmptyState icon={ListChecks} message="Select an organization to view tasks." />;
  return <TruncatedTextMarqueeProvider><div className="task-row-design-preview flex flex-col gap-8" data-testid="design-sandbox-tasks">
    <TaskListToolbar view={collection.view} onViewChange={collection.setView} query={collection.query} onQueryChange={collection.setQuery}
      layout={collection.layout} onLayoutChange={collection.setLayout} allExpanded={collection.allExpanded} onToggleExpanded={collection.toggleExpanded}
      onNewTask={() => openNewIssue()} filters={{ state: collection.filters, onChange: collection.updateFilters, activeFilterCount: collection.activeFilterCount,
        agents: agents.data ?? [], projects: projects.data ?? [], labels: labels.data ?? [], currentUserId: userId, creators: collection.creators }} />
    {error ? <div role="alert" className="flex items-center gap-2 text-sm text-destructive"><span>{error instanceof Error ? error.message : "Could not load tasks"}</span><Button variant="outline" size="sm" onClick={() => { update.reset(); void client.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) }); void agents.refetch(); void projects.refetch(); void directory.refetch(); void labels.refetch(); }}>Retry</Button></div> : null}
    {tasks.isPending ? <p role="status" className="text-sm text-muted-foreground">Loading tasks…</p> : <>
      {collection.narrowed ? <p role="status" className="design-task-results">{collection.matchingItems.length} matching tasks{collection.layout === "list" && collection.visibleItems.length > collection.matchingItems.length ? " · Parent tasks included for context" : ""}</p> : null}
      <div hidden={collection.layout !== "list"} className="design-task-list-panel"><TaskList key={companyId} items={collection.visibleItems} allItems={collection.companyItems} collapsedIds={collection.collapsedIds} onCollapsedIdsChange={collection.setCollapsedIds} emptyState={empty} /></div>
      {collection.layout === "board" ? collection.matchingItems.length ? <KanbanBoard showOverflowFades issues={collection.matchingItems.map(item => item.issue)} agents={agents.data} onUpdateIssue={(id, data) => update.mutate({ id, data })} /> : empty : null}
      {tasks.hasNextPage ? <div className="flex items-center gap-3 text-sm text-muted-foreground"><span>Search, views and filters cover the {items.length} loaded tasks.</span><Button variant="outline" size="sm" disabled={tasks.isFetchingNextPage} onClick={() => void tasks.fetchNextPage()}>{tasks.isFetchingNextPage ? "Loading…" : "Load more tasks"}</Button></div> : null}
    </>}
  </div></TruncatedTextMarqueeProvider>;
}
