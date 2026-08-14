import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { ArrowUpDown, Check, ChevronDown, ChevronRight, Layers, Plus, Repeat } from "lucide-react";
import { routinesApi } from "../api/routines";
import { foldersApi } from "../api/folders";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { accessApi } from "../api/access";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useToastActions } from "../context/ToastContext";
import { buildMarkdownMentionOptions } from "../lib/company-members";
import { cn } from "../lib/utils";
import { queryKeys } from "../lib/queryKeys";
import { groupBy } from "../lib/groupBy";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { collectLiveIssueIds } from "../lib/liveIssueIds";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "../components/MarkdownEditor";
import { RoutineListRow, nextRoutineStatus } from "../components/RoutineList";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Tabs, TabsContent } from "@/components/ui/tabs";
import type { RoutineListItem, RoutineVariable } from "@paperclipai/shared";
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
import { t, useTranslation } from "@/i18n";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: t("routines.concurrencyCoalesce"),
  always_enqueue: t("routines.concurrencyAlwaysEnqueue"),
  skip_if_active: t("routines.concurrencySkipIfActive"),
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: t("routines.catchUpSkipMissed"),
  enqueue_missed_with_cap: t("routines.catchUpEnqueueMissed"),
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

type RoutinesTab = "routines" | "runs";
type RoutineGroupBy = "folder" | "none" | "project" | "assignee";
type RoutineSortField = "updated" | "created" | "title" | "lastRun";
type RoutineSortDir = "asc" | "desc";

type RoutineViewState = {
  sortField: RoutineSortField;
  sortDir: RoutineSortDir;
  groupBy: RoutineGroupBy;
  collapsedGroups: string[];
};

type RoutineGroup = {
  key: string;
  label: string | null;
  items: RoutineListItem[];
};

const builtInRoutineGroupKey = "__built_in_routines";

const defaultRoutineViewState: RoutineViewState = {
  sortField: "title",
  sortDir: "asc",
  groupBy: "folder",
  collapsedGroups: [],
};

function getRoutineViewState(key: string): RoutineViewState {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return { ...defaultRoutineViewState, ...JSON.parse(raw) };
  } catch {
    // Ignore malformed local state and fall back to defaults.
  }
  return { ...defaultRoutineViewState };
}

function saveRoutineViewState(key: string, state: RoutineViewState) {
  localStorage.setItem(key, JSON.stringify(state));
}

function timestampValue(value: Date | string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function compareNullableText(left: string | null | undefined, right: string | null | undefined) {
  return (left ?? "").localeCompare(right ?? "", undefined, { sensitivity: "base" });
}

type RoutineFolderGroupMeta = { name: string; position?: number | null };

function buildRoutineMutationPayload(input: {
  title: string;
  description: string;
  projectId: string;
  folderId: string | null;
  assigneeAgentId: string;
  priority: string;
  concurrencyPolicy: string;
  catchUpPolicy: string;
  variables: RoutineVariable[];
}) {
  return {
    ...input,
    description: input.description.trim() || null,
    projectId: input.projectId || null,
    folderId: input.folderId || null,
    assigneeAgentId: input.assigneeAgentId || null,
  };
}

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

        const labelCompare = (leftFolder?.name ?? t("routines.unknownFolder")).localeCompare(
          rightFolder?.name ?? t("routines.unknownFolder"),
          undefined,
          { sensitivity: "base" },
        );
        return labelCompare || left.localeCompare(right);
      })
      .map((key) => ({
        key,
        label: key === "__unfiled" ? t("routines.unfiled") : (folderById.get(key)?.name ?? t("routines.unknownFolder")),
        items: groups[key]!,
      }));
  }

  if (groupByValue === "project") {
    const groups = groupBy(routines, (routine) => routine.projectId ?? "__no_project");
    return Object.keys(groups)
      .sort((left, right) => {
        const leftLabel = left === "__no_project" ? t("routines.noProject") : (projectById.get(left)?.name ?? t("routines.unknownProject"));
        const rightLabel = right === "__no_project" ? t("routines.noProject") : (projectById.get(right)?.name ?? t("routines.unknownProject"));
        return leftLabel.localeCompare(rightLabel);
      })
      .map((key) => ({
        key,
        label: key === "__no_project" ? t("routines.noProject") : (projectById.get(key)?.name ?? t("routines.unknownProject")),
        items: groups[key]!,
      }));
  }

  const groups = groupBy(routines, (routine) => routine.assigneeAgentId ?? "__unassigned");
  return Object.keys(groups)
    .sort((left, right) => {
      const leftLabel = left === "__unassigned" ? t("routines.unassigned") : (agentById.get(left)?.name ?? t("routines.unknownAgent"));
      const rightLabel = right === "__unassigned" ? t("routines.unassigned") : (agentById.get(right)?.name ?? t("routines.unknownAgent"));
      return leftLabel.localeCompare(rightLabel);
    })
    .map((key) => ({
      key,
      label: key === "__unassigned" ? t("routines.unassigned") : (agentById.get(key)?.name ?? t("routines.unknownAgent")),
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
        ? { ...group, label: t("routines.customRoutines") }
        : group
    ));

  if (builtInRoutines.length === 0) return customGroups;

  return [
    ...customGroups,
    {
      key: builtInRoutineGroupKey,
      label: t("routines.builtInRoutines"),
      items: builtInRoutines,
    },
  ];
}

export function sortRoutines(
  routines: RoutineListItem[],
  sortField: RoutineSortField,
  sortDir: RoutineSortDir,
): RoutineListItem[] {
  const direction = sortDir === "asc" ? 1 : -1;
  return [...routines].sort((left, right) => {
    let result = 0;

    if (sortField === "title") {
      result = compareNullableText(left.title, right.title);
    } else if (sortField === "created") {
      result = timestampValue(left.createdAt) - timestampValue(right.createdAt);
    } else if (sortField === "lastRun") {
      result = timestampValue(left.lastRun?.triggeredAt ?? left.lastTriggeredAt) -
        timestampValue(right.lastRun?.triggeredAt ?? right.lastTriggeredAt);
    } else {
      result = timestampValue(left.updatedAt) - timestampValue(right.updatedAt);
    }

    if (result !== 0) return result * direction;
    return compareNullableText(left.title, right.title);
  });
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
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const { pushToast } = useToastActions();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
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
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const activeTab: RoutinesTab = searchParams.get("tab") === "runs" ? "runs" : "routines";
  const [draft, setDraft] = useState<{
    title: string;
    description: string;
    projectId: string;
    folderId: string | null;
    assigneeAgentId: string;
    priority: string;
    concurrencyPolicy: string;
    catchUpPolicy: string;
    variables: RoutineVariable[];
  }>({
    title: "",
    description: "",
    projectId: "",
    folderId: null,
    assigneeAgentId: "",
    priority: "medium",
    concurrencyPolicy: "coalesce_if_active",
    catchUpPolicy: "skip_missed",
    variables: [],
  });
  const routineViewStateKey = selectedCompanyId
    ? `paperclip:routines-view:${selectedCompanyId}`
    : "paperclip:routines-view";
  const [routineViewState, setRoutineViewState] = useState<RoutineViewState>(() => getRoutineViewState(routineViewStateKey));
  const folderSelection = normalizeFolderSelection(searchParams.get("folder"));

  useEffect(() => {
    setBreadcrumbs([{ label: t("routines.routines") }]);
  }, [setBreadcrumbs]);

  useEffect(() => {
    setRoutineViewState(getRoutineViewState(routineViewStateKey));
  }, [routineViewStateKey]);

  const { data: routines, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
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
    queryKey: queryKeys.projects.list(selectedCompanyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(selectedCompanyId!, { includeArchived: true }),
    enabled: !!selectedCompanyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(selectedCompanyId!),
    queryFn: () => accessApi.listUserDirectory(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: routineExecutionIssues, isLoading: recentRunsLoading, error: recentRunsError } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { originKind: "routine_execution" }),
    enabled: !!selectedCompanyId && activeTab === "runs",
  });
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

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: (projects ?? []).filter((project) => !project.archivedAt),
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, projects]);

  const createRoutine = useMutation({
    mutationFn: () =>
      routinesApi.create(selectedCompanyId!, buildRoutineMutationPayload(draft)),
    onSuccess: async (routine) => {
      setDraft({
        title: "",
        description: "",
        projectId: "",
        folderId: null,
        assigneeAgentId: "",
        priority: "medium",
        concurrencyPolicy: "coalesce_if_active",
        catchUpPolicy: "skip_missed",
        variables: [],
      });
      setComposerOpen(false);
      setAdvancedOpen(false);
      await queryClient.invalidateQueries({ queryKey: queryKeys.routines.list(selectedCompanyId!) });
      pushToast({
        title: t("routines.routineCreated"),
        body: routine.assigneeAgentId
          ? t("routines.routineCreatedWithAgent")
          : t("routines.routineCreatedDraft"),
        tone: "success",
      });
      navigate(`/routines/${routine.id}?tab=triggers`);
    },
  });
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
            title: t("routines.folderCreatedMoveFailed"),
            body: moveError instanceof Error ? moveError.message : t("routines.moveRoutinesFailedBody"),
            tone: "error",
          });
          return;
        }
      } else {
        setFolderSelection(folder.id);
      }
      pushToast({ title: t("routines.folderCreated"), body: folder.name, tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: t("routines.folderSaveFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.folderSaveFailedBody"),
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
        title: t("routines.folderSaveFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.folderUpdateFailedBody"),
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
      pushToast({ title: t("routines.folderDeleted"), body: t("routines.itemsMovedToUnfiled"), tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: t("routines.folderDeleteFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.folderDeleteFailedBody"),
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
        title: t("routines.moveFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.moveRoutineFailedBody"),
        tone: "error",
      });
    },
  });
  const updateIssue = useMutation({
    mutationFn: ({ id, data }: { id: string; data: Record<string, unknown> }) =>
      issuesApi.update(id, data),
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
        title: t("routines.routineUpdateFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.routineUpdateFailedBody"),
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
        title: t("routines.runFailed"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.runFailedBody"),
        tone: "error",
      });
    },
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [composerOpen]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [composerOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () =>
      sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: agent.id,
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    [agents, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).filter((project) => !project.archivedAt).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects],
  );
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
  const visibleRoutines = useMemo(
    () => (routines ?? []).filter((routine) => routine.status !== "archived"),
    [routines],
  );
  const folderFilteredRoutines = useMemo(() => {
    if (routineViewState.groupBy !== "folder") return visibleRoutines;
    if (folderSelection === "all") return visibleRoutines;
    if (folderSelection === "unfiled") return visibleRoutines.filter((routine) => !routine.folderId);
    return visibleRoutines.filter((routine) => routine.folderId === folderSelection);
  }, [folderSelection, routineViewState.groupBy, visibleRoutines]);
  // Rail counts reflect the page's visible scope (archived hidden), not raw DB
  // counts (ux-spec §5.3).
  const railFolderResult = useMemo(() => {
    if (!routineFolders) return routineFolders;
    const counts = new Map<string, number>();
    let unfiled = 0;
    for (const routine of visibleRoutines) {
      if (routine.folderId) counts.set(routine.folderId, (counts.get(routine.folderId) ?? 0) + 1);
      else unfiled += 1;
    }
    return {
      ...routineFolders,
      allCount: visibleRoutines.length,
      unfiledCount: unfiled,
      folders: routineFolders.folders.map((folder) => ({
        ...folder,
        itemCount: counts.get(folder.id) ?? 0,
      })),
    };
  }, [routineFolders, visibleRoutines]);
  const sortedRoutines = useMemo(
    () => sortRoutines(folderFilteredRoutines, routineViewState.sortField, routineViewState.sortDir),
    [folderFilteredRoutines, routineViewState.sortDir, routineViewState.sortField],
  );
  const routineSections = useMemo(
    () => buildRoutineSections(sortedRoutines, routineViewState.groupBy, projectById, agentById, folderById),
    [agentById, folderById, projectById, routineViewState.groupBy, sortedRoutines],
  );
  const recentRunsIssueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        t("routines.recentRuns"),
        buildRoutinesTabHref("runs"),
        "issues",
      ),
    [],
  );
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;
  const activeFolder = selectedFolderFromList(routineFolders?.folders ?? [], folderSelection);
  const hasRoutineFolders = (routineFolders?.folders.length ?? 0) > 0;
  const showFolderRail = activeTab === "routines" && routineViewState.groupBy === "folder" && hasRoutineFolders;

  function updateRoutineView(patch: Partial<RoutineViewState>) {
    setRoutineViewState((current) => {
      const next = { ...current, ...patch };
      saveRoutineViewState(routineViewStateKey, next);
      return next;
    });
  }

  function handleTabChange(tab: string) {
    const nextTab = tab === "runs" ? "runs" : "routines";
    startTransition(() => {
      navigate(buildRoutinesTabHref(nextTab));
    });
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
    setDraft((current) => ({
      ...current,
      folderId: folderSelection === "all" || folderSelection === "unfiled" ? null : folderSelection,
    }));
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
      pushToast({ title: t("routines.routinesMoved"), body: `${ids.length} ${ids.length === 1 ? t("routines.routineOne") : t("routines.routineMany")} filed.`, tone: "success" });
    } catch (moveError) {
      pushToast({
        title: t("routines.moveRoutinesFailed"),
        body: moveError instanceof Error ? moveError.message : t("routines.moveRoutinesFailedBody"),
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
        title: t("routines.defaultAgentRequired"),
        body: t("routines.defaultAgentRequiredBody"),
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
    return <EmptyState icon={Repeat} message={t("routines.selectCompany")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("routines.routines")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("routines.description")}
          </p>
        </div>
        <Button onClick={openCreateRoutine}>
          <Plus className="mr-2 h-4 w-4" />
          {t("routines.createRoutine")}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <PageTabBar
          align="start"
          value={activeTab}
          onValueChange={handleTabChange}
          items={[
            { value: "routines", label: t("routines.routines") },
            { value: "runs", label: t("routines.recentRuns") },
          ]}
        />
        <TabsContent value="routines" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {visibleRoutines.length === 1
                ? t("routines.routineCountOne", { count: visibleRoutines.length })
                : t("routines.routineCountMany", { count: visibleRoutines.length })}
            </p>
            <div className="flex items-center gap-1">
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs" title={t("routines.sort")}>
                    <ArrowUpDown className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                    <span className="hidden sm:inline">{t("routines.sort")}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-0">
                  <div className="p-2 space-y-0.5">
                    {([
                      ["updated", t("routines.sortUpdated")],
                      ["created", t("routines.sortCreated")],
                      ["lastRun", t("routines.sortLastRun")],
                      ["title", t("routines.sortTitle")],
                    ] as const).map(([field, label]) => (
                      <button
                        key={field}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                          routineViewState.sortField === field
                            ? "bg-accent/50 text-foreground"
                            : "text-muted-foreground hover:bg-accent/50"
                        }`}
                        onClick={() => {
                          updateRoutineView(
                            routineViewState.sortField === field
                              ? { sortDir: routineViewState.sortDir === "asc" ? "desc" : "asc" }
                              : { sortField: field, sortDir: field === "title" ? "asc" : "desc" },
                          );
                        }}
                      >
                        <span>{label}</span>
                        {routineViewState.sortField === field ? (
                          <span className="text-xs text-muted-foreground">
                            {routineViewState.sortDir === "asc" ? t("routines.asc") : t("routines.desc")}
                          </span>
                        ) : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              <Popover>
                <PopoverTrigger asChild>
                  <Button variant="ghost" size="sm" className="text-xs" title={t("routines.group")}>
                    <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                    <span className="hidden sm:inline">{t("routines.group")}</span>
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="w-44 p-0">
                  <div className="p-2 space-y-0.5">
                    {([
                      ["folder", t("routines.groupFolder")],
                      ["project", t("routines.groupProject")],
                      ["assignee", t("routines.groupAgent")],
                      ["none", t("routines.groupNone")],
                    ] as const).map(([value, label]) => (
                      <button
                        key={value}
                        className={`flex w-full items-center justify-between rounded-sm px-2 py-1.5 text-sm ${
                          routineViewState.groupBy === value
                            ? "bg-accent/50 text-foreground"
                            : "text-muted-foreground hover:bg-accent/50"
                        }`}
                        onClick={() => updateRoutineView({ groupBy: value, collapsedGroups: [] })}
                      >
                        <span>{label}</span>
                        {routineViewState.groupBy === value ? <Check className="h-3.5 w-3.5" /> : null}
                      </button>
                    ))}
                  </div>
                </PopoverContent>
              </Popover>
              {routineViewState.groupBy === "folder" && !hasRoutineFolders ? (
                <Button variant="outline" size="sm" onClick={() => openCreateFolder()}>
                  <Plus className="mr-2 h-3.5 w-3.5" />
                  {t("routines.newFolder")}
                </Button>
              ) : null}
              {showFolderRail ? (
                <Button variant="ghost" size="sm" className="text-xs" onClick={() => setSelectMode((current) => !current)}>
                  {selectMode ? t("routines.done") : t("routines.select")}
                </Button>
              ) : null}
            </div>
          </div>
          {routineViewState.groupBy === "folder" ? (
            <div className="md:hidden">
              <FolderChip
                result={railFolderResult}
                selection={folderSelection}
                allLabel={t("routines.allRoutines")}
                onClick={() => setMobileFoldersOpen(true)}
              />
            </div>
          ) : null}
        </TabsContent>
        <TabsContent value="runs">
          <IssuesList
            issues={routineExecutionIssues ?? []}
            isLoading={recentRunsLoading}
            error={recentRunsError as Error | null}
            agents={agents}
            projects={projects}
            liveIssueIds={liveIssueIds}
            viewStateKey="paperclip:routine-recent-runs-view"
            issueLinkState={recentRunsIssueLinkState}
            onUpdateIssue={(id, data) => updateIssue.mutate({ id, data })}
          />
        </TabsContent>
      </Tabs>

      <Dialog
        open={composerOpen}
        onOpenChange={(open) => {
          if (!createRoutine.isPending) {
            setComposerOpen(open);
          }
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="flex max-h-(--sz-calc-18) max-w-3xl flex-col gap-0 overflow-hidden p-0"
        >
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("routines.newRoutine")}</p>
              <p className="text-sm text-muted-foreground">
                {t("routines.newRoutineHint")}
              </p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setComposerOpen(false);
                setAdvancedOpen(false);
              }}
              disabled={createRoutine.isPending}
            >
              {t("routines.cancel")}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 pt-5 pb-3">
              <textarea
                ref={titleInputRef}
                className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/50"
                placeholder={t("routines.routineTitle")}
                rows={1}
                value={draft.title}
                onChange={(event) => {
                  setDraft((current) => ({ ...current, title: event.target.value }));
                  autoResizeTextarea(event.target);
                }}
                onKeyDown={(event) => {
                  if (event.key === "Enter" && !event.metaKey && !event.ctrlKey && !event.nativeEvent.isComposing) {
                    event.preventDefault();
                    descriptionEditorRef.current?.focus();
                    return;
                  }
                  if (event.key === "Tab" && !event.shiftKey) {
                    event.preventDefault();
                    if (draft.assigneeAgentId) {
                      if (draft.projectId) {
                        descriptionEditorRef.current?.focus();
                      } else {
                        projectSelectorRef.current?.focus();
                      }
                    } else {
                      assigneeSelectorRef.current?.focus();
                    }
                  }
                }}
                autoFocus
              />
            </div>

            <div className="px-5 pb-3">
              <div className="overflow-x-auto overscroll-x-contain">
                <div className="inline-flex min-w-full flex-wrap items-center gap-2 text-sm text-muted-foreground sm:min-w-max sm:flex-nowrap">
                  <span>{t("routines.forLabel")}</span>
                  <InlineEntitySelector
                    ref={assigneeSelectorRef}
                    value={draft.assigneeAgentId}
                    options={assigneeOptions}
                    recentOptionIds={recentAssigneeIds}
                    placeholder={t("routines.responsible")}
                    noneLabel={t("routines.noResponsible")}
                    searchPlaceholder={t("routines.searchResponsible")}
                    emptyMessage={t("routines.noResponsibleFound")}
                    onChange={(assigneeAgentId) => {
                      if (assigneeAgentId) trackRecentAssignee(assigneeAgentId);
                      setDraft((current) => ({ ...current, assigneeAgentId }));
                    }}
                    onConfirm={() => {
                      if (draft.projectId) {
                        descriptionEditorRef.current?.focus();
                      } else {
                        projectSelectorRef.current?.focus();
                      }
                    }}
                    renderTriggerValue={(option) =>
                      option ? (
                        currentAssignee ? (
                          <>
                            <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate">{option.label}</span>
                          </>
                        ) : (
                          <span className="truncate">{option.label}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">{t("routines.responsible")}</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const assignee = agentById.get(option.id);
                      return (
                        <>
                          {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                  <span>{t("routines.inLabel")}</span>
                  <InlineEntitySelector
                    ref={projectSelectorRef}
                    value={draft.projectId}
                    options={projectOptions}
                    recentOptionIds={recentProjectIds}
                    placeholder={t("routines.project")}
                    noneLabel={t("routines.noProject")}
                    searchPlaceholder={t("routines.searchProjects")}
                    emptyMessage={t("routines.noProjects")}
                    onChange={(projectId) => {
                      if (projectId) trackRecentProject(projectId);
                      setDraft((current) => ({ ...current, projectId }));
                    }}
                    onConfirm={() => descriptionEditorRef.current?.focus()}
                    renderTriggerValue={(option) =>
                      option && currentProject ? (
                        <>
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: currentProject.color ?? "var(--project-none)" }}
                          />
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t("routines.project")}</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const project = projectById.get(option.id);
                      return (
                        <>
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: project?.color ?? "var(--project-none)" }}
                          />
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                  <span>{t("routines.filedIn")}</span>
                  <Select
                    value={draft.folderId ?? "__unfiled"}
                    onValueChange={(value) => setDraft((current) => ({
                      ...current,
                      folderId: value === "__unfiled" ? null : value,
                    }))}
                  >
                    <SelectTrigger className="h-8 w-auto min-w-32 border-0 bg-muted/50 px-2 shadow-none">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="__unfiled">{t("routines.unfiled")}</SelectItem>
                      {(routineFolders?.folders ?? []).map((folder) => (
                        <SelectItem key={folder.id} value={folder.id}>
                          {folder.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
            </div>

            <div className="border-t border-border/60 px-5 py-4">
              <MarkdownEditor
                ref={descriptionEditorRef}
                value={draft.description}
                onChange={(description) => setDraft((current) => ({ ...current, description }))}
                placeholder={t("routines.addInstructions")}
                bordered={false}
                contentClassName="min-h-(--sz-160px) text-sm text-muted-foreground"
                mentions={mentionOptions}
                onSubmit={() => {
                  if (!createRoutine.isPending && draft.title.trim() && draft.projectId && draft.assigneeAgentId) {
                    createRoutine.mutate();
                  }
                }}
              />
            </div>

            <div className="border-t border-border/60 px-5 py-3">
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                  <div>
                    <p className="text-sm font-medium">{t("routines.advancedDelivery")}</p>
                    <p className="text-sm text-muted-foreground">{t("routines.policyControlsSecondary")}</p>
                  </div>
                  {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("routines.concurrency")}</p>
                      <Select
                        value={draft.concurrencyPolicy}
                        onValueChange={(concurrencyPolicy) => setDraft((current) => ({ ...current, concurrencyPolicy }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {concurrencyPolicies.map((value) => (
                            <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("routines.catchUp")}</p>
                      <Select
                        value={draft.catchUpPolicy}
                        onValueChange={(catchUpPolicy) => setDraft((current) => ({ ...current, catchUpPolicy }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {catchUpPolicies.map((value) => (
                            <SelectItem key={value} value={value}>{value.replaceAll("_", " ")}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{catchUpPolicyDescriptions[draft.catchUpPolicy]}</p>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>

          <div className="shrink-0 flex flex-col gap-3 border-t border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {t("routines.afterCreation")}
            </div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                onClick={() => createRoutine.mutate()}
                disabled={
                  createRoutine.isPending ||
                  !draft.title.trim()
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                {createRoutine.isPending ? t("routines.creating") : t("routines.createRoutine")}
              </Button>
              {createRoutine.isError ? (
                <p className="text-sm text-destructive">
                  {createRoutine.error instanceof Error ? createRoutine.error.message : t("routines.createFailed")}
                </p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : t("routines.loadFailed")}
          </CardContent>
        </Card>
      ) : null}

      {activeTab === "routines" ? (
        <div className={cn(showFolderRail && "flex gap-4")}>
          {showFolderRail ? (
            <FolderRail
              result={railFolderResult}
              selection={folderSelection}
              allLabel={t("routines.allRoutines")}
              itemLabelPlural={t("routines.itemPlural")}
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
              {folderSelection === "all" ? <FolderIconHeader label={t("routines.allRoutines")} count={sortedRoutines.length} /> : (
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <FolderSwatch color={activeFolder?.color} />
                  <span className="truncate font-medium">{folderSelection === "unfiled" ? t("routines.unfiled") : activeFolder?.name ?? t("routines.folder")}</span>
                  <span className="text-muted-foreground">
                    {sortedRoutines.length === 1
                      ? t("routines.routineCountOne", { count: sortedRoutines.length })
                      : t("routines.routineCountMany", { count: sortedRoutines.length })}
                  </span>
                </div>
              )}
            </div>
          ) : null}
          {routineViewState.groupBy === "folder" && !hasRoutineFolders && !foldersLoading && visibleRoutines.length > 0 ? (
            <AllUnfiledBanner
              storageKey={`paperclip:routines-folder-nudge:${selectedCompanyId ?? "none"}`}
              itemLabelPlural={t("routines.itemPlural")}
              onCreateFolder={() => openCreateFolder()}
            />
          ) : null}
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
          {visibleRoutines.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={t("routines.noActiveRoutines")}
              />
            </div>
          ) : sortedRoutines.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={folderSelection === "all" ? t("routines.noMatchView") : t("routines.folderEmpty")}
              />
              {folderSelection !== "all" ? (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" onClick={openCreateRoutine}>
                    <Plus className="mr-2 h-3.5 w-3.5" />
                    {t("routines.newRoutineInFolder")}
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
                      {group.items.map((routine) => (
                        <RoutineListRow
                          key={routine.id}
                          routine={routine}
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
                                  title: t("routines.routineMoved"),
                                  body: folderId
                                    ? t("routines.movedToFolder", {
                                        title: routine.title,
                                        folder: routineFolders?.folders.find((folder) => folder.id === folderId)?.name ?? t("routines.folder"),
                                      })
                                    : t("routines.movedToUnfiled", { title: routine.title }),
                                  tone: "success",
                                  action: {
                                    label: t("routines.undo"),
                                    onClick: () => moveRoutineToFolder.mutate({ itemId: routine.id, folderId: previousFolderId }),
                                  },
                                });
                              }}
                              onCreateAndMove={() => openCreateFolder([routine.id])}
                            />
                          }
                        />
                      ))}
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
        itemLabelPlural={t("routines.itemPlural")}
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
        allLabel={t("routines.allRoutines")}
        itemLabelPlural={t("routines.itemPlural")}
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
  const { t } = useTranslation();
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground">
        {count === 1
          ? t("routines.routineCountOne", { count })
          : t("routines.routineCountMany", { count })}
      </span>
    </div>
  );
}
