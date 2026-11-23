import { useRoutineListView } from "../hooks/useRoutineListView";
import { routineFilterKeys } from "../lib/routine-list-view";
import { buildRoutineFilterOptions, selectRoutineRows } from "../lib/routine-list-data";
import { RoutineTable } from "../components/RoutineTable";
import { companyProjectsQuery } from "@/lib/company-projects-query";
import { useUpdateIssueMutation } from "@/hooks/useUpdateIssueMutation";
import { startTransition, useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { ChevronRight, Plus, Repeat } from "lucide-react";
import { routinesApi } from "../api/routines";
import { foldersApi } from "../api/folders";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { buildCompanyUserProfileMap } from "../lib/company-members";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { groupBy } from "../lib/groupBy";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { describeError } from "../api/errors";
import { PageTabBar } from "../components/PageTabBar";
import { RoutineTableRow, nextRoutineStatus } from "../components/RoutineList";
import { RoutineCreateDialog } from "../components/routine-page/RoutineCreateDialog";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { RoutinesToolbar, type RoutineGroupBy } from "@/components/RoutinesToolbar";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import type { RoutineListItem } from "@paperclipai/shared";
import type { FolderListItem } from "@paperclipai/shared";
import {
  AllUnfiledBanner,
  BulkBar,
  DeleteFolderDialog,
  FolderChip,
  FolderFormDialog,
  FolderRail,
  FolderSwatch,
  MobileFolderSheet,
  MoveToMenu,
  folderSearchValue,
  normalizeFolderSelection,
  selectedFolderFromList,
  type FolderSelection,
} from "../components/folders/FolderControls";


type RoutinesTab = "routines" | "runs";
type RoutineGroup = {
  key: string;
  label: string | null;
  items: RoutineListItem[];
};

const builtInRoutineGroupKey = "__built_in_routines";


type RoutineFolderGroupMeta = { name: string; position?: number | null };

export function buildRoutineGroups(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
  folderById: Map<string, RoutineFolderGroupMeta>,
): RoutineGroup[] {
  if (groupByValue === "none") {
    return [{ key: "__all", label: null, items: routines }];
  }

  if (groupByValue === "folder") {
    const groups = groupBy(routines, (routine) => routine.folderId ?? "__unfiled");
    return Object.keys(groups)
      .sort((left, right) => {
        if (left === "__unfiled" || right === "__unfiled") {
          if (left === right) return 0;
          return left === "__unfiled" ? 1 : -1;
        }

        const leftFolder = folderById.get(left);
        const rightFolder = folderById.get(right);
        const leftPosition = Number.isFinite(leftFolder?.position) ? leftFolder!.position! : Number.POSITIVE_INFINITY;
        const rightPosition = Number.isFinite(rightFolder?.position) ? rightFolder!.position! : Number.POSITIVE_INFINITY;
        const positionCompare = leftPosition - rightPosition;
        if (positionCompare !== 0) return positionCompare;

        const labelCompare = (leftFolder?.name ?? "Unknown folder").localeCompare(
          rightFolder?.name ?? "Unknown folder",
          undefined,
          { sensitivity: "base" },
        );
        return labelCompare || left.localeCompare(right);
      })
      .map((key) => ({
        key,
        label: key === "__unfiled" ? "Unfiled" : (folderById.get(key)?.name ?? "Unknown folder"),
        items: groups[key]!,
      }));
  }

  if (groupByValue === "project") {
    const groups = groupBy(routines, (routine) => routine.projectId ?? "__no_project");
    return Object.keys(groups)
      .sort((left, right) => {
        const leftLabel = left === "__no_project" ? "No project" : (projectById.get(left)?.name ?? "Unknown project");
        const rightLabel = right === "__no_project" ? "No project" : (projectById.get(right)?.name ?? "Unknown project");
        return leftLabel.localeCompare(rightLabel);
      })
      .map((key) => ({
        key,
        label: key === "__no_project" ? "No project" : (projectById.get(key)?.name ?? "Unknown project"),
        items: groups[key]!,
      }));
  }

  const groups = groupBy(routines, (routine) => routine.assigneeAgentId ?? "__unassigned");
  return Object.keys(groups)
    .sort((left, right) => {
      const leftLabel = left === "__unassigned" ? "Unassigned" : (agentById.get(left)?.name ?? "Unknown agent");
      const rightLabel = right === "__unassigned" ? "Unassigned" : (agentById.get(right)?.name ?? "Unknown agent");
      return leftLabel.localeCompare(rightLabel);
    })
    .map((key) => ({
      key,
      label: key === "__unassigned" ? "Unassigned" : (agentById.get(key)?.name ?? "Unknown agent"),
      items: groups[key]!,
    }));
}

export function isBuiltInRoutine(routine: Pick<RoutineListItem, "originKind">) {
  return routine.originKind === "built_in_agent_bundle";
}

export function buildRoutineSections(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
  folderById: Map<string, { name: string }>,
): RoutineGroup[] {
  const builtInRoutines = routines.filter(isBuiltInRoutine);
  const customRoutines = routines.filter((routine) => !isBuiltInRoutine(routine));
  const customGroups = buildRoutineGroups(customRoutines, groupByValue, projectById, agentById, folderById)
    .filter((group) => group.items.length > 0)
    .map((group) => (
      builtInRoutines.length > 0 && groupByValue === "none" && group.key === "__all"
        ? { ...group, label: "Custom routines" }
        : group
    ));

  if (builtInRoutines.length === 0) return customGroups;

  return [
    ...customGroups,
    {
      key: builtInRoutineGroupKey,
      label: "Built-in routines",
      items: builtInRoutines,
    },
  ];
}


function buildRoutinesTabHref(tab: RoutinesTab) {
  return tab === "runs" ? "/routines?tab=runs" : "/routines";
}

function RoutineSectionHeader({
  label,
  count,
  isOpen,
}: {
  label: string;
  count: number;
  isOpen: boolean;
}) {
  return (
    <div
      className={`flex items-center gap-2 rounded-lg border border-border px-3 py-2${
        isOpen ? " mb-1" : ""
      }`}
    >
      <CollapsibleTrigger className="flex items-center gap-1.5">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
        <span className="text-sm font-semibold uppercase tracking-wide">
          {label}
        </span>
      </CollapsibleTrigger>
      <span className="text-xs text-muted-foreground">
        {count}
      </span>
    </div>
  );
}

export function Routines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToastActions();
  const [folderDialogOpen, setFolderDialogOpen] = useState(false);
  const [folderDialogTarget, setFolderDialogTarget] = useState<FolderListItem | null>(null);
  const [deleteFolderTarget, setDeleteFolderTarget] = useState<FolderListItem | null>(null);
  const [mobileFoldersOpen, setMobileFoldersOpen] = useState(false);
  const [selectMode, setSelectMode] = useState(false);
  const [selectedRoutineIds, setSelectedRoutineIds] = useState<string[]>([]);
  const [moveAfterCreateIds, setMoveAfterCreateIds] = useState<string[]>([]);
  const [runningRoutineId, setRunningRoutineId] = useState<string | null>(null);
  const [statusMutationRoutineId, setStatusMutationRoutineId] = useState<string | null>(null);
  const [runDialogRoutine, setRunDialogRoutine] = useState<RoutineListItem | null>(null);
  const [composerOpen, setComposerOpen] = useState(false);
  const [createFolderId, setCreateFolderId] = useState<string | null>(null);
  const activeTab: RoutinesTab = searchParams.get("tab") === "runs" ? "runs" : "routines";
  const [routineViewState, updateRoutineView] = useRoutineListView(selectedCompanyId);
  const query = routineViewState.query;
  const folderSelection = normalizeFolderSelection(searchParams.get("folder"));

  useEffect(() => {
    setBreadcrumbs([{ label: "Routines" }]);
  }, [setBreadcrumbs]);

  const routinesQuery = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: routines, isLoading } = routinesQuery;
  const routinesView = useQueryView(routinesQuery);
  const { data: routineFolders, isLoading: foldersLoading } = useQuery({
    queryKey: queryKeys.folders.list(selectedCompanyId!, "routine"),
    queryFn: () => foldersApi.list(selectedCompanyId!, "routine"),
    enabled: !!selectedCompanyId && activeTab === "routines",
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    ...companyProjectsQuery(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const companyMembersQuery = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: companyMembers } = companyMembersQuery;
  const companyMembersView = useQueryView(companyMembersQuery);
  const recentRunsQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { originKind: "routine_execution" }),
    enabled: !!selectedCompanyId && activeTab === "runs",
  });
  const { data: routineExecutionIssues, isLoading: recentRunsLoading } = recentRunsQuery;
  const recentRunsView = useQueryView(recentRunsQuery);
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId && activeTab === "runs",
    // Event-sourced via LiveUpdatesProvider (GitHub issue 9627); no interval poll needed.
    refetchInterval: false,
    leaderOnly: true,
  });
  const { data: liveRuns, dataUpdatedAt: liveRunsUpdatedAt } = useQuery({
    queryKey: liveRunsQueryKey,
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: sharedLiveRuns.enabled,
    refetchInterval: sharedLiveRuns.refetchInterval,
  });
  usePublishSharedQueryData(sharedLiveRuns, liveRuns, liveRunsUpdatedAt);


  const createFolder = useMutation({
    mutationFn: (payload: { name: string; color: string | null }) =>
      foldersApi.create(selectedCompanyId!, { kind: "routine", ...payload }),
    onSuccess: async (folder) => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") });
      if (moveAfterCreateIds.length > 0) {
        const ids = moveAfterCreateIds;
        setMoveAfterCreateIds([]);
        try {
          await Promise.all(ids.map((itemId) =>
            foldersApi.moveItem(selectedCompanyId!, { kind: "routine", itemId, folderId: folder.id })
          ));
          await Promise.all([
            queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
            queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
          ]);
        } catch (moveError) {
          pushToast({
            title: "Folder created, move failed",
            body: describeError(moveError, { action: "move the selected routines" }).body,
            tone: "error",
          });
          return;
        }
      } else {
        setFolderSelection(folder.id);
      }
      pushToast({ title: "Folder created", body: folder.name, tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to save folder",
        body: describeError(mutationError, { action: "save the folder" }).body,
        tone: "error",
      });
    },
  });
  const updateFolder = useMutation({
    mutationFn: ({ folderId, payload }: { folderId: string; payload: { name?: string; color?: string | null } }) =>
      foldersApi.update(selectedCompanyId!, folderId, payload),
    onSuccess: async () => {
      setFolderDialogOpen(false);
      setFolderDialogTarget(null);
      await queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Folder save failed",
        body: describeError(mutationError, { action: "update the folder" }).body,
        tone: "error",
      });
    },
  });
  const deleteFolder = useMutation({
    mutationFn: (folderId: string) => foldersApi.delete(selectedCompanyId!, folderId),
    onSuccess: async (_, folderId) => {
      if (folderSelection === folderId) setFolderSelection("all");
      setDeleteFolderTarget(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
      ]);
      pushToast({ title: "Folder deleted", body: "Items moved to Unfiled.", tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: "Folder delete failed",
        body: describeError(mutationError, { action: "delete the folder" }).body,
        tone: "error",
      });
    },
  });
  const moveRoutineToFolder = useMutation({
    mutationFn: ({ itemId, folderId }: { itemId: string; folderId: string | null }) =>
      foldersApi.moveItem(selectedCompanyId!, { kind: "routine", itemId, folderId }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
      ]);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Move failed",
        body: describeError(mutationError, { action: "move the routine" }).body,
        tone: "error",
      });
    },
  });
  const updateIssue = useUpdateIssueMutation({
    companyId: selectedCompanyId,
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"] });
    },
  });

  const updateRoutineStatus = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) => routinesApi.update(id, { status }),
    onMutate: ({ id }) => {
      setStatusMutationRoutineId(id);
    },
    onSuccess: async (_, variables) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(variables.id) }),
      ]);
    },
    onSettled: () => {
      setStatusMutationRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Failed to update routine",
        body: describeError(mutationError, { action: "update the routine" }).body,
        tone: "error",
      });
    },
  });

  const runRoutine = useMutation({
    mutationFn: ({ id, data }: { id: string; data?: RoutineRunDialogSubmitData }) => routinesApi.run(id, {
      ...(data?.variables && Object.keys(data.variables).length > 0 ? { variables: data.variables } : {}),
      ...(data?.assigneeAgentId !== undefined ? { assigneeAgentId: data.assigneeAgentId } : {}),
      ...(data?.projectId !== undefined ? { projectId: data.projectId } : {}),
      ...(data?.executionWorkspaceId !== undefined ? { executionWorkspaceId: data.executionWorkspaceId } : {}),
      ...(data?.executionWorkspacePreference !== undefined
        ? { executionWorkspacePreference: data.executionWorkspacePreference }
        : {}),
      ...(data?.executionWorkspaceSettings !== undefined
        ? { executionWorkspaceSettings: data.executionWorkspaceSettings }
        : {}),
    }),
    onMutate: ({ id }) => {
      setRunningRoutineId(id);
    },
    onSuccess: async (_, { id }) => {
      setRunDialogRoutine(null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.detail(id) }),
      ]);
    },
    onSettled: () => {
      setRunningRoutineId(null);
    },
    onError: (mutationError) => {
      pushToast({
        title: "Routine run failed",
        body: describeError(mutationError, { action: "start the routine run" }).body,
        tone: "error",
      });
    },
  });

  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects],
  );
  const folderById = useMemo(
    () => new Map((routineFolders?.folders ?? []).map((folder) => [folder.id, folder])),
    [routineFolders],
  );
  const liveIssueIds = useMemo(() => collectLiveIssueIds(liveRuns, routineExecutionIssues), [liveRuns, routineExecutionIssues]);
  const userById = useMemo(() => buildCompanyUserProfileMap(companyMembers?.users), [companyMembers]);
  const filterOptions = useMemo(() => buildRoutineFilterOptions({ projects: projects ?? [], agents: agents ?? [], userById, routines: routines ?? [] }), [projects, agents, userById, routines]);
  const { visibleRoutines, sortedRoutines, railFolderResult } = useMemo(
    () => selectRoutineRows(routines ?? [], routineViewState, routineFolders, folderSelection),
    [routines, routineViewState, routineFolders, folderSelection],
  );
  const routineSections = useMemo(
    () => buildRoutineSections(sortedRoutines, routineViewState.groupBy, projectById, agentById, folderById),
    [agentById, folderById, projectById, routineViewState.groupBy, sortedRoutines],
  );
  const recentRunsIssueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        "Recent Runs",
        buildRoutinesTabHref("runs"),
        "issues",
      ),
    [],
  );
  const activeFolder = selectedFolderFromList(routineFolders?.folders ?? [], folderSelection);
  const hasRoutineFolders = (routineFolders?.folders.length ?? 0) > 0;
  const showFolderRail = activeTab === "routines" && routineViewState.groupBy === "folder" && hasRoutineFolders;

  function handleTabChange(tab: string) {
    startTransition(() => navigate(buildRoutinesTabHref(tab === "runs" ? "runs" : "routines")));
  }

  function setFolderSelection(selection: FolderSelection) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      const value = folderSearchValue(selection);
      if (value) params.set("folder", value);
      else params.delete("folder");
      return params;
    });
  }

  function openCreateFolder(moveItemIds: string[] = []) {
    setMoveAfterCreateIds(moveItemIds);
    setFolderDialogTarget(null);
    setFolderDialogOpen(true);
  }

  function openCreateRoutine() {
    setCreateFolderId(folderSelection === "all" || folderSelection === "unfiled" ? null : folderSelection);
    setComposerOpen(true);
  }

  async function moveSelectedRoutines(folderId: string | null) {
    const ids = selectedRoutineIds;
    if (ids.length === 0) return;
    try {
      await Promise.all(ids.map((itemId) => foldersApi.moveItem(selectedCompanyId!, { kind: "routine", itemId, folderId })));
      setSelectedRoutineIds([]);
      setSelectMode(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) }),
        queryClient.invalidateQueries({ queryKey: queryKeys.folders.list(selectedCompanyId!, "routine") }),
      ]);
      pushToast({ title: "Routines moved", body: `${ids.length} routine${ids.length === 1 ? "" : "s"} filed.`, tone: "success" });
    } catch (moveError) {
      pushToast({
        title: "Failed to move routines",
        body: describeError(moveError, { action: "move the selected routines" }).body,
        tone: "error",
      });
    }
  }

  function handleRunNow(routine: RoutineListItem) {
    setRunDialogRoutine(routine);
  }

  function handleToggleEnabled(routine: RoutineListItem, enabled: boolean) {
    if (!enabled && !routine.assigneeAgentId) {
      pushToast({
        title: "Default agent required",
        body: "Set a default agent before enabling routine automation.",
        tone: "warn",
      });
      return;
    }
    updateRoutineStatus.mutate({
      id: routine.id,
      status: nextRoutineStatus(routine.status, !enabled),
    });
  }

  function handleToggleArchived(routine: RoutineListItem) {
    updateRoutineStatus.mutate({
      id: routine.id,
      status: routine.status === "archived" ? "active" : "archived",
    });
  }

  if (!selectedCompanyId) {
    return <EmptyState icon={Repeat} message="Select a company to view routines." />;
  }

  // Keep loaded routines on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || routinesView.kind === "reconnecting") {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div className="space-y-6">
      <h1 className="sr-only">Routines</h1>
      <RoutinesToolbar
        showListControls={activeTab === "routines"}
        query={query} onQueryChange={query => updateRoutineView({ query })}
        sortField={routineViewState.sortField} sortDir={routineViewState.sortDir} groupBy={routineViewState.groupBy}
        onSortChange={(sortField, sortDir) => updateRoutineView({ sortField, sortDir })}
        onGroupChange={groupBy => updateRoutineView({ groupBy, collapsedGroups: [] })}
        onNewFolder={routineViewState.groupBy === "folder" && routineFolders && !hasRoutineFolders ? () => openCreateFolder() : undefined}
        onCreateRoutine={openCreateRoutine}
        filters={routineViewState} filterOptions={filterOptions} onFiltersChange={updateRoutineView}
        columns={routineViewState.columns} onColumnsChange={columns => updateRoutineView({ columns })}
        tasksHref="/issues?view=all&originKind=routine_execution&sortField=created&sortDir=desc"
      />

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <PageTabBar
          align="start"
          value={activeTab}
          onValueChange={handleTabChange}
          items={[
            { value: "routines", label: "Routines" },
            { value: "runs", label: "Recent Runs" },
          ]}
        />
        <TabsContent value="routines" className="space-y-4">
          {routineViewState.groupBy === "folder" ? (
            <div className="md:hidden">
              <FolderChip
                result={railFolderResult}
                selection={folderSelection}
                allLabel="All routines"
                onClick={() => setMobileFoldersOpen(true)}
              />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="runs">
          <IssuesList
            issues={routineExecutionIssues ?? []}
            isLoading={recentRunsLoading || recentRunsView.kind === "reconnecting"}
            error={recentRunsView.kind === "error" ? (recentRunsView.error as Error) : null}
            onRetry={recentRunsView.retry}
            retrying={recentRunsView.isFetching}
            agents={agents}
            projects={projects}
            liveIssueIds={liveIssueIds}
            viewStateKey="paperclip:routine-recent-runs-view"
            issueLinkState={recentRunsIssueLinkState}
            onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
          />
        </TabsContent>
      </Tabs>

      {selectedCompanyId ? (
        <RoutineCreateDialog
          companyId={selectedCompanyId}
          open={composerOpen}
          onOpenChange={setComposerOpen}
          folderId={createFolderId}
        />
      ) : null}

      {routinesView.kind === "error" ? (
        <QueryErrorState
          error={routinesView.error}
          action="load routines"
          onRetry={routinesView.retry}
          retrying={routinesView.isFetching}
        />
      ) : null}

      {activeTab === "routines" && companyMembersView.kind === "error" ? (
        <QueryErrorState error={companyMembersView.error} action="load responsible people" size="inline"
          onRetry={companyMembersView.retry} retrying={companyMembersView.isFetching} />
      ) : null}

      {activeTab === "routines" ? (
        <div className={cn(showFolderRail && "flex gap-4")}>
          {showFolderRail ? (
            <FolderRail
              result={railFolderResult}
              selection={folderSelection}
              allLabel="All routines"
              itemLabelPlural="routines"
              loading={foldersLoading}
              onSelect={setFolderSelection}
              onCreate={() => openCreateFolder()}
              onRename={(folder, name) => updateFolder.mutate({ folderId: folder.id, payload: { name } })}
              onEdit={(folder) => {
                setFolderDialogTarget(folder);
                setFolderDialogOpen(true);
              }}
              onDelete={setDeleteFolderTarget}
            />
          ) : null}
          <div className="min-w-0 flex-1">
          {routineViewState.groupBy === "folder" && hasRoutineFolders ? (
            <div className="mb-3 flex flex-wrap items-center gap-2">
              {folderSelection === "all" ? <FolderIconHeader label="All routines" count={sortedRoutines.length} /> : (
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <FolderSwatch color={activeFolder?.color} />
                  <span className="truncate font-medium">{folderSelection === "unfiled" ? "Unfiled" : activeFolder?.name ?? "Folder"}</span>
                  <span className="text-muted-foreground">{sortedRoutines.length} routine{sortedRoutines.length === 1 ? "" : "s"}</span>
                </div>
              )}
            </div>
          ) : null}
          {routineViewState.groupBy === "folder" && !hasRoutineFolders && !foldersLoading && visibleRoutines.length > 0 ? (
            <AllUnfiledBanner
              storageKey={`paperclip:routines-folder-nudge:${selectedCompanyId ?? "none"}`}
              itemLabelPlural="routines"
              onCreateFolder={() => openCreateFolder()}
            />
          ) : null}
          {showFolderRail ? <Button variant="ghost" size="sm" onClick={() => setSelectMode(current => !current)}>{selectMode ? "Done" : "Select"}</Button> : null}
          {selectMode ? (
            <BulkBar
              selectedCount={selectedRoutineIds.length}
              folders={routineFolders?.folders ?? []}
              onMove={(folderId) => void moveSelectedRoutines(folderId)}
              onCreateAndMove={() => openCreateFolder(selectedRoutineIds)}
              onClear={() => setSelectedRoutineIds([])}
              onDone={() => {
                setSelectMode(false);
                setSelectedRoutineIds([]);
              }}
            />
          ) : null}
          {visibleRoutines.length === 0 && !routineViewState.statuses.length ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message="No active routines. Use New routine to define the first recurring workflow."
              />
            </div>
          ) : sortedRoutines.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={query.trim() ? "No routines match your search." : routineFilterKeys.some(key => routineViewState[key].length) || folderSelection === "all" ? "No routines match this view." : "This folder is empty."}
              />
              {folderSelection !== "all" ? (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" onClick={openCreateRoutine}>
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    New routine in this folder
                  </Button>
                </div>
              ) : null}
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              {routineSections.map((group) => {
                const isOpen = !routineViewState.collapsedGroups.includes(group.key);
                return (
                  <Collapsible
                    key={group.key}
                    open={isOpen}
                    onOpenChange={(open) => {
                      updateRoutineView({
                        collapsedGroups: open
                          ? routineViewState.collapsedGroups.filter((item) => item !== group.key)
                          : [...routineViewState.collapsedGroups, group.key],
                      });
                    }}
                  >
                    {group.label ? (
                      <RoutineSectionHeader
                        label={group.label}
                        count={group.items.length}
                        isOpen={isOpen}
                      />
                    ) : null}
                    <CollapsibleContent>
                      <RoutineTable columns={routineViewState.columns} label={group.label ?? "Routines"} selectMode={selectMode}>
                      {group.items.map((routine) => (
                        <RoutineTableRow
                          key={routine.id}
                          routine={routine}
                          columns={routineViewState.columns}
                          userById={userById}
                          projectById={projectById}
                          agentById={agentById}
                          runningRoutineId={runningRoutineId}
                          statusMutationRoutineId={statusMutationRoutineId}
                          href={`/routines/${routine.id}`}
                          runNowButton
                          divider={false}
                          onRunNow={handleRunNow}
                          onToggleEnabled={handleToggleEnabled}
                          onToggleArchived={handleToggleArchived}
                          selectMode={selectMode}
                          selected={selectedRoutineIds.includes(routine.id)}
                          onSelectChange={(selectedRoutine, selected) => {
                            setSelectedRoutineIds((current) =>
                              selected
                                ? Array.from(new Set([...current, selectedRoutine.id]))
                                : current.filter((id) => id !== selectedRoutine.id)
                            );
                          }}
                          extraMenuItems={
                            <MoveToMenu
                              folders={routineFolders?.folders ?? []}
                              currentFolderId={routine.folderId ?? null}
                              onMove={(folderId) => {
                                const previousFolderId = routine.folderId ?? null;
                                moveRoutineToFolder.mutate({ itemId: routine.id, folderId });
                                pushToast({
                                  title: "Routine moved",
                                  body: folderId
                                    ? `Moved "${routine.title}" to ${routineFolders?.folders.find((folder) => folder.id === folderId)?.name ?? "folder"}.`
                                    : `Moved "${routine.title}" to Unfiled.`,
                                  tone: "success",
                                  action: {
                                    label: "Undo",
                                    onClick: () => moveRoutineToFolder.mutate({ itemId: routine.id, folderId: previousFolderId }),
                                  },
                                });
                              }}
                              onCreateAndMove={() => openCreateFolder([routine.id])}
                            />
                          }
                        />
                      ))}
                      </RoutineTable>
                    </CollapsibleContent>
                  </Collapsible>
                );
              })}
            </div>
          )}
          </div>
        </div>
      ) : null}

      <FolderFormDialog
        open={folderDialogOpen}
        kind="routine"
        folder={folderDialogTarget}
        pending={createFolder.isPending || updateFolder.isPending}
        onOpenChange={setFolderDialogOpen}
        onSubmit={(payload) => {
          if (folderDialogTarget) updateFolder.mutate({ folderId: folderDialogTarget.id, payload });
          else createFolder.mutate(payload);
        }}
      />
      <DeleteFolderDialog
        open={deleteFolderTarget !== null}
        folder={deleteFolderTarget}
        itemLabelPlural="routines"
        pending={deleteFolder.isPending}
        onOpenChange={(open) => {
          if (!open) setDeleteFolderTarget(null);
        }}
        onConfirm={() => {
          if (deleteFolderTarget) deleteFolder.mutate(deleteFolderTarget.id);
        }}
      />
      <MobileFolderSheet
        open={mobileFoldersOpen}
        onOpenChange={setMobileFoldersOpen}
        result={railFolderResult}
        selection={folderSelection}
        allLabel="All routines"
        itemLabelPlural="Routines"
        onSelect={setFolderSelection}
        onCreate={() => openCreateFolder()}
      />

      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(next) => {
          if (!next) setRunDialogRoutine(null);
        }}
        companyId={selectedCompanyId}
        routineName={runDialogRoutine?.title ?? null}
        agents={agents ?? []}
        projects={projects ?? []}
        defaultProjectId={runDialogRoutine?.projectId ?? null}
        defaultAssigneeAgentId={runDialogRoutine?.assigneeAgentId ?? null}
        variables={runDialogRoutine?.variables ?? []}
        isPending={runRoutine.isPending}
        onSubmit={(data) => {
          if (!runDialogRoutine) return;
          runRoutine.mutate({ id: runDialogRoutine.id, data });
        }}
      />
    </div>
  );
}

function FolderIconHeader({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground">{count} routine{count === 1 ? "" : "s"}</span>
    </div>
  );
}
