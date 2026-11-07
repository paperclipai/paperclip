import { useTranslation, t } from "@/i18n";
import { AgentAvatar } from "@/components/AgentAvatar";
import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, Navigate, useNavigate, useSearchParams } from "@/lib/router";
import { ChevronDown, ChevronRight, Plus, Repeat } from "lucide-react";
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
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { QueryErrorState, useQueryView } from "../components/QueryView";
import { describeError } from "../api/errors";
import { PageTabBar } from "../components/PageTabBar";
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
import { RoutinesToolbar, type RoutineGroupBy, type RoutineSortField, type RoutineSortDir } from "@/components/RoutinesToolbar";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { auditSectionHref } from "./audit/audit-navigation";
import { routineDetailHref } from "../components/RoutineContextualSidebar";
import { usePublishSharedQueryData, useSharedPollingQuery } from "../hooks/useSharedPolling";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import type { RoutineListItem, RoutineVariable } from "@paperclipai/shared";
import type { FolderListItem } from "@paperclipai/shared";
import { Tabs } from "@/components/ui/tabs";
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
import { useUpdateIssueMutation } from "../hooks/useUpdateIssueMutation";

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  get coalesce_if_active() { return t("work:copy.ifARunIsAlreadyActiveKeepJustOne_9975f7"); },
  get always_enqueue() { return t("work:copy.queueEveryTriggerOccurrenceEvenIfTheRoutineIs_033757"); },
  get skip_if_active() { return t("work:copy.dropNewTriggerOccurrencesWhileARunIsStill_eb088f"); },
};
const catchUpPolicyDescriptions: Record<string, string> = {
  get skip_missed() { return t("work:copy.ignoreWindowsThatWereMissedWhileTheSchedulerOr_77dc55"); },
  get enqueue_missed_with_cap() { return t("work:copy.catchUpMissedScheduleWindowsAfterRecoverySubHourly_5137b6"); },
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

type RoutinesTab = "routines" | "runs";

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

        const labelCompare = (leftFolder?.name ?? t("work:copy.unknownFolder_292238")).localeCompare(
          rightFolder?.name ?? t("work:copy.unknownFolder_292238"),
          undefined,
          { sensitivity: "base" },
        );
        return labelCompare || left.localeCompare(right);
      })
      .map((key) => ({
        key,
        label: key === "__unfiled" ? t("work:copy.unfiled_d64dc9") : (folderById.get(key)?.name ?? t("work:copy.unknownFolder_292238")),
        items: groups[key]!,
      }));
  }

  if (groupByValue === "project") {
    const groups = groupBy(routines, (routine) => routine.projectId ?? "__no_project");
    return Object.keys(groups)
      .sort((left, right) => {
        const leftLabel = left === "__no_project" ? t("work:copy.noProject_f34c2b") : (projectById.get(left)?.name ?? t("work:copy.unknownProject_ed51cf"));
        const rightLabel = right === "__no_project" ? t("work:copy.noProject_f34c2b") : (projectById.get(right)?.name ?? t("work:copy.unknownProject_ed51cf"));
        return leftLabel.localeCompare(rightLabel);
      })
      .map((key) => ({
        key,
        label: key === "__no_project" ? t("work:copy.noProject_f34c2b") : (projectById.get(key)?.name ?? t("work:copy.unknownProject_ed51cf")),
        items: groups[key]!,
      }));
  }

  const groups = groupBy(routines, (routine) => routine.assigneeAgentId ?? "__unassigned");
  return Object.keys(groups)
    .sort((left, right) => {
      const leftLabel = left === "__unassigned" ? t("work:copy.unassigned_14d33b") : (agentById.get(left)?.name ?? t("work:copy.unknownAgent_342b4a"));
      const rightLabel = right === "__unassigned" ? t("work:copy.unassigned_14d33b") : (agentById.get(right)?.name ?? t("work:copy.unknownAgent_342b4a"));
      return leftLabel.localeCompare(rightLabel);
    })
    .map((key) => ({
      key,
      label: key === "__unassigned" ? t("work:copy.unassigned_14d33b") : (agentById.get(key)?.name ?? t("work:copy.unknownAgent_342b4a")),
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
        ? { ...group, label: t("work:copy.customRoutines_9454c5") }
        : group
    ));

  if (builtInRoutines.length === 0) return customGroups;

  return [
    ...customGroups,
    {
      key: builtInRoutineGroupKey,
      label: t("work:copy.builtInRoutines_f81d47"),
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

function RoutineSectionHeader({
  label,
  count,
  isOpen: _isOpen,
}: {
  label: string;
  count: number;
  isOpen: boolean;
}) {
  const { t } = useTranslation("work");
  return (
    <div className="flex items-center gap-2 px-2 py-1.5">
      <CollapsibleTrigger className="flex items-center gap-1.5">
        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
        <span data-routine-section-label className="text-sm font-medium">
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
  const { t } = useTranslation("work");
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
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const legacyRunsRequested = searchParams.get("tab") === "runs";
  const activeTab: RoutinesTab = !streamlinedUiEnabled && legacyRunsRequested ? "runs" : "routines";
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
  const [query, setQuery] = useState("");
  const [routineViewState, setRoutineViewState] = useState<RoutineViewState>(() => getRoutineViewState(routineViewStateKey));
  const folderSelection = normalizeFolderSelection(searchParams.get("folder"));

  useEffect(() => {
    setBreadcrumbs([{ label: t("work:copy.routines_61b7bb") }]);
  }, [setBreadcrumbs, t]);

  useEffect(() => {
    setRoutineViewState(getRoutineViewState(routineViewStateKey));
  }, [routineViewStateKey]);

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
    enabled: !!selectedCompanyId,
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
  const recentRunsQuery = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { originKind: "routine_execution" }),
    enabled: !!selectedCompanyId && !streamlinedUiEnabled && activeTab === "runs",
  });
  const { data: routineExecutionIssues, isLoading: recentRunsLoading } = recentRunsQuery;
  const recentRunsView = useQueryView(recentRunsQuery);
  const liveRunsQueryKey = queryKeys.liveRuns(selectedCompanyId!);
  const sharedLiveRuns = useSharedPollingQuery({
    companyId: selectedCompanyId,
    resourceKey: "live-runs",
    queryKey: liveRunsQueryKey,
    enabled: !!selectedCompanyId && !streamlinedUiEnabled && activeTab === "runs",
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
  }, [agents, companyMembers?.users, projects, t]);

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
        title: t("work:copy.routineCreated_73aa78"),
        body: routine.assigneeAgentId
          ? t("work:copy.addTheFirstTriggerToTurnItIntoA_0dd3f8")
          : t("work:copy.draftSavedAddADefaultAgentBeforeEnablingAutomation_ed85f3"),
        tone: "success",
      });
      navigate(routineDetailHref(routine.id, "triggers"));
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
            title: t("work:copy.folderCreatedMoveFailed_cc9449"),
            body: describeError(moveError, { action: t("work:copy.moveTheSelectedRoutines_6c40e3") }).body,
            tone: "error",
          });
          return;
        }
      } else {
        setFolderSelection(folder.id);
      }
      pushToast({ title: t("work:copy.folderCreated_b1dfe0"), body: folder.name, tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: t("work:copy.failedToSaveFolder_64879e"),
        body: describeError(mutationError, { action: t("work:copy.saveTheFolder_e4162e") }).body,
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
        title: t("work:copy.folderSaveFailed_b0b2fe"),
        body: describeError(mutationError, { action: t("work:copy.updateTheFolder_433cb8") }).body,
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
      pushToast({ title: t("work:copy.folderDeleted_796dc5"), body: t("work:copy.itemsMovedToUnfiled_ec2297"), tone: "success" });
    },
    onError: (mutationError) => {
      pushToast({
        title: t("work:copy.folderDeleteFailed_cdb83b"),
        body: describeError(mutationError, { action: t("work:copy.deleteTheFolder_54010d") }).body,
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
        title: t("work:copy.moveFailed_55185d"),
        body: describeError(mutationError, { action: t("work:copy.moveTheRoutine_bce497") }).body,
        tone: "error",
      });
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
        title: t("work:copy.failedToUpdateRoutine_658553"),
        body: describeError(mutationError, { action: t("work:copy.updateTheRoutine_b91df2") }).body,
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
        title: t("work:copy.routineRunFailed_296c7c"),
        body: describeError(mutationError, { action: t("work:copy.startTheRoutineRun_b7d489") }).body,
        tone: "error",
      });
    },
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [composerOpen, t]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [composerOpen, t]);
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
    [agents, recentAssigneeIds, t],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      (projects ?? []).filter((project) => !project.archivedAt).map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [projects, t],
  );
  const agentById = useMemo(
    () => new Map((agents ?? []).map((agent) => [agent.id, agent])),
    [agents, t],
  );
  const projectById = useMemo(
    () => new Map((projects ?? []).map((project) => [project.id, project])),
    [projects, t],
  );
  const folderById = useMemo(
    () => new Map((routineFolders?.folders ?? []).map((folder) => [folder.id, folder])),
    [routineFolders, t],
  );
  const visibleRoutines = useMemo(
    () => (routines ?? []).filter((routine) => routine.status !== "archived"),
    [routines, t],
  );
  const liveIssueIds = useMemo(
    () => collectLiveIssueIds(liveRuns, routineExecutionIssues),
    [liveRuns, routineExecutionIssues, t],
  );
  const recentRunsIssueLinkState = useMemo(
    () => createIssueDetailLocationState(t("work:copy.recentRuns_53972e"), "/routines?tab=runs", "issues"),
    [t],
  );
  const updateIssue = useUpdateIssueMutation({
    companyId: selectedCompanyId,
    invalidateKeys: selectedCompanyId ? [[...queryKeys.issues.list(selectedCompanyId), "routine-executions"]] : [],
  });

  function handleLegacyTabChange(tab: string) {
    const nextTab: RoutinesTab = tab === "runs" ? "runs" : "routines";
    startTransition(() => {
      navigate(nextTab === "runs" ? "/routines?tab=runs" : "/routines");
    });
  }
  const folderFilteredRoutines = useMemo(() => {
    if (routineViewState.groupBy !== "folder") return visibleRoutines;
    if (folderSelection === "all") return visibleRoutines;
    if (folderSelection === "unfiled") return visibleRoutines.filter((routine) => !routine.folderId);
    return visibleRoutines.filter((routine) => routine.folderId === folderSelection);
  }, [folderSelection, routineViewState.groupBy, visibleRoutines, t]);
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
  }, [routineFolders, visibleRoutines, t]);
  const sortedRoutines = useMemo(
    () => {
      const terms = query.toLowerCase().trim().split(/\s+/).filter(Boolean);
      const matches = folderFilteredRoutines.filter(routine => {
        const text = `${routine.title} ${routine.description ?? ""}`.toLowerCase();
        return terms.every(term => text.includes(term));
      });
      return sortRoutines(matches, routineViewState.sortField, routineViewState.sortDir);
    },
    [folderFilteredRoutines, query, routineViewState.sortDir, routineViewState.sortField, t],
  );
  const routineSections = useMemo(
    () => buildRoutineSections(sortedRoutines, routineViewState.groupBy, projectById, agentById, folderById),
    [agentById, folderById, projectById, routineViewState.groupBy, sortedRoutines, t],
  );
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;
  const activeFolder = selectedFolderFromList(routineFolders?.folders ?? [], folderSelection);
  const hasRoutineFolders = (routineFolders?.folders.length ?? 0) > 0;
  const showFolderRail = routineViewState.groupBy === "folder" && hasRoutineFolders;

  function updateRoutineView(patch: Partial<RoutineViewState>) {
    setRoutineViewState((current) => {
      const next = { ...current, ...patch };
      saveRoutineViewState(routineViewStateKey, next);
      return next;
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
      pushToast({ title: t("work:copy.routinesMoved_b282d6"), body: t("work:messages.routinesFiled", { count: ids.length }), tone: "success" });
    } catch (moveError) {
      pushToast({
        title: t("work:copy.failedToMoveRoutines_cd16ae"),
        body: describeError(moveError, { action: t("work:copy.moveTheSelectedRoutines_6c40e3") }).body,
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
        title: t("work:copy.defaultAgentRequired_2761f3"),
        body: t("work:copy.setADefaultAgentBeforeEnablingRoutineAutomation_1885fd"),
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
    return <EmptyState icon={Repeat} message={t("work:copy.selectAnOrganizationToViewRoutines_7b360f")} />;
  }

  if (streamlinedUiEnabled && legacyRunsRequested) {
    return <Navigate to={auditSectionHref("runs", {})} replace />;
  }

  // Keep loaded routines on screen through a failed refetch; only a real
  // failure, or an outage before the first load, replaces the page.
  if (isLoading || routinesView.kind === "reconnecting") {
    return <PageSkeleton variant="issues-list" />;
  }

  if (!streamlinedUiEnabled && activeTab === "runs") {
    return (
      <div className="space-y-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">{t("work:copy.routines_61b7bb")}</h1>
            <p className="text-sm text-muted-foreground">{t("work:copy.recurringWorkDefinitionsThatMaterializeIntoAuditableExecutionTasks_2b8bf1")}</p>
          </div>
          <Button onClick={openCreateRoutine}>
            <Plus className="mr-2 h-4 w-4" />{t("work:copy.createRoutine_f0fe07")}</Button>
        </div>
        <Tabs value={activeTab} onValueChange={handleLegacyTabChange}>
          <PageTabBar
            align="start"
            value={activeTab}
            onValueChange={handleLegacyTabChange}
            items={[
              { value: "routines", label: t("work:copy.routines_61b7bb") },
              { value: "runs", label: t("work:copy.recentRuns_53972e") },
            ]}
          />
        </Tabs>
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
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <RoutinesToolbar
        query={query} onQueryChange={setQuery}
        sortField={routineViewState.sortField} sortDir={routineViewState.sortDir} groupBy={routineViewState.groupBy}
        onSortChange={(sortField, sortDir) => updateRoutineView({ sortField, sortDir })}
        onGroupChange={groupBy => updateRoutineView({ groupBy, collapsedGroups: [] })}
        onNewFolder={routineViewState.groupBy === "folder" && !hasRoutineFolders ? () => openCreateFolder() : undefined}
        onCreateRoutine={openCreateRoutine}
        tasksHref="/issues?view=all&originKind=routine_execution&sortField=created&sortDir=desc"
        selectMode={selectMode} onToggleSelect={showFolderRail ? () => setSelectMode(current => !current) : undefined}
      />

      {!streamlinedUiEnabled ? (
        <Tabs value={activeTab} onValueChange={handleLegacyTabChange}>
          <PageTabBar
            align="start"
            value={activeTab}
            onValueChange={handleLegacyTabChange}
            items={[
              { value: "routines", label: t("work:copy.routines_61b7bb") },
              { value: "runs", label: t("work:copy.recentRuns_53972e") },
            ]}
          />
        </Tabs>
      ) : null}

      <div className="flex flex-col gap-4">
        {routineViewState.groupBy === "folder" ? (
          <div className="md:hidden">
            <FolderChip
              result={railFolderResult}
              selection={folderSelection}
              allLabel={t("work:copy.allRoutines_4a8c78")}
              onClick={() => setMobileFoldersOpen(true)}
            />
          </div>
        ) : null}
      </div>

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
              <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("work:copy.newRoutine_d5e520")}</p>
              <p className="text-sm text-muted-foreground">{t("work:copy.defineTheRecurringWorkFirstDefaultProjectAndAgent_5e3613")}</p>
            </div>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setComposerOpen(false);
                setAdvancedOpen(false);
              }}
              disabled={createRoutine.isPending}
            >{t("work:copy.cancel_19766e")}</Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 pt-5 pb-3">
              <textarea
                ref={titleInputRef}
                className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/50"
                placeholder={t("work:copy.routineTitle_26d0f8")}
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
                  <span>{t("work:copy.for_ca15eb")}</span>
                  <InlineEntitySelector
                    ref={assigneeSelectorRef}
                    value={draft.assigneeAgentId}
                    options={assigneeOptions}
                    recentOptionIds={recentAssigneeIds}
                    placeholder={t("work:copy.responsible_bc110a")}
                    noneLabel={t("work:copy.noResponsible_15abde")}
                    searchPlaceholder={t("work:copy.searchResponsible_9cb8d7")}
                    emptyMessage={t("work:copy.noResponsibleFound_045a8f")}
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
                            <AgentAvatar agent={currentAssignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                            <span className="truncate">{option.label}</span>
                          </>
                        ) : (
                          <span className="truncate">{option.label}</span>
                        )
                      ) : (
                        <span className="text-muted-foreground">{t("work:copy.responsible_bc110a")}</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const assignee = agentById.get(option.id);
                      return (
                        <>
                          {assignee ? <AgentAvatar agent={assignee} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null}
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                  <span>{t("work:copy.in_582967")}</span>
                  <InlineEntitySelector
                    ref={projectSelectorRef}
                    value={draft.projectId}
                    options={projectOptions}
                    recentOptionIds={recentProjectIds}
                    placeholder={t("work:copy.project_985959")}
                    noneLabel={t("work:copy.noProject_f34c2b")}
                    searchPlaceholder={t("work:copy.searchProjects_c59dd5")}
                    emptyMessage={t("work:copy.noProjectsFound_26e923")}
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
                        <span className="text-muted-foreground">{t("work:copy.project_985959")}</span>
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
                  <span>{t("work:copy.filedIn_8effe1")}</span>
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
                      <SelectItem value="__unfiled">{t("work:copy.unfiled_d64dc9")}</SelectItem>
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
                placeholder={t("work:copy.addInstructions_d49e19")}
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
                    <p className="text-sm font-medium">{t("work:copy.advancedDeliverySettings_6fbfb2")}</p>
                    <p className="text-sm text-muted-foreground">{t("work:copy.keepPolicyControlsSecondaryToTheWorkDefinition_264481")}</p>
                  </div>
                  {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("work:copy.concurrency_870849")}</p>
                      <Select
                        value={draft.concurrencyPolicy}
                        onValueChange={(concurrencyPolicy) => setDraft((current) => ({ ...current, concurrencyPolicy }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {concurrencyPolicies.map((value) => (
                            <SelectItem key={value} value={value}>{t(`work:policies.${value}`)}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                      <p className="text-xs text-muted-foreground">{concurrencyPolicyDescriptions[draft.concurrencyPolicy]}</p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-(--tracking-caps) text-muted-foreground">{t("work:copy.catchUp_1c2d0f")}</p>
                      <Select
                        value={draft.catchUpPolicy}
                        onValueChange={(catchUpPolicy) => setDraft((current) => ({ ...current, catchUpPolicy }))}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {catchUpPolicies.map((value) => (
                            <SelectItem key={value} value={value}>{t(`work:policies.${value}`)}</SelectItem>
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
            <div className="text-sm text-muted-foreground">{t("work:copy.afterCreationPaperclipTakesYouStraightToTriggerSetup_1ff03d")}</div>
            <div className="flex flex-col gap-2 sm:items-end">
              <Button
                onClick={() => createRoutine.mutate()}
                disabled={
                  createRoutine.isPending ||
                  !draft.title.trim()
                }
              >
                <Plus className="mr-2 h-4 w-4" />
                {createRoutine.isPending ? t("work:copy.creating_def709") : t("work:copy.createRoutine_f0fe07")}
              </Button>
              {createRoutine.isError ? ( // query-error-ok: mutation result, not a query
                <p role="alert" className="text-sm text-destructive">
                  {describeError(createRoutine.error, { action: t("work:copy.createTheRoutine_061ef3") }).body}
                </p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {routinesView.kind === "error" ? (
        <QueryErrorState
          error={routinesView.error}
          action={t("work:copy.loadRoutines_3b1ef2")}
          onRetry={routinesView.retry}
          retrying={routinesView.isFetching}
        />
      ) : null}

      <div className={cn(showFolderRail && "flex gap-4")}>
          {showFolderRail ? (
            <FolderRail
              result={railFolderResult}
              selection={folderSelection}
              allLabel={t("work:copy.allRoutines_4a8c78")}
              itemLabelPlural={t("work:copy.routines_2a9035")}
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
              {folderSelection === "all" ? <FolderIconHeader label={t("work:copy.allRoutines_4a8c78")} count={sortedRoutines.length} /> : (
                <div className="flex min-w-0 items-center gap-2 text-sm">
                  <FolderSwatch color={activeFolder?.color} />
                  <span className="truncate font-medium">{folderSelection === "unfiled" ? t("work:copy.unfiled_d64dc9") : activeFolder?.name ?? t("work:copy.folder_74ccd4")}</span>
                  <span className="text-muted-foreground">{t("work:counts.routines", { count: sortedRoutines.length })}</span>
                </div>
              )}
            </div>
          ) : null}
          {routineViewState.groupBy === "folder" && !hasRoutineFolders && !foldersLoading && visibleRoutines.length > 0 ? (
            <AllUnfiledBanner
              storageKey={`paperclip:routines-folder-nudge:${selectedCompanyId ?? "none"}`}
              itemLabelPlural={t("work:copy.routines_2a9035")}
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
                message={t("work:copy.noActiveRoutinesUseCreateRoutineToDefineThe_7ba430")}
              />
            </div>
          ) : sortedRoutines.length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={query.trim() ? t("work:copy.noRoutinesMatchYourSearch_d841e9") : folderSelection === "all" ? t("work:copy.noRoutinesMatchThisView_7bf937") : t("work:copy.thisFolderIsEmpty_bd88d7")}
              />
              {folderSelection !== "all" ? (
                <div className="mt-3 flex justify-center">
                  <Button size="sm" onClick={openCreateRoutine}>
                    <Plus className="mr-2 h-3.5 w-3.5" />{t("work:copy.newRoutineInThisFolder_086c8a")}</Button>
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
                                  title: t("work:copy.routineMoved_071030"),
                                  body: folderId
                                    ? t("work:copy.movedTo_c66b8a", { value1: routine.title, value2: routineFolders?.folders.find((folder) => folder.id === folderId)?.name ?? "folder" })
                                    : t("work:copy.movedToUnfiled_de48bf", { value1: routine.title }),
                                  tone: "success",
                                  action: {
                                    label: t("work:copy.undo_a8283a"),
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
        itemLabelPlural={t("work:copy.routines_2a9035")}
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
        allLabel={t("work:copy.allRoutines_4a8c78")}
        itemLabelPlural={t("work:copy.routines_61b7bb")}
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
  const { t } = useTranslation("work");
  return (
    <div className="flex min-w-0 items-center gap-2 text-sm">
      <Repeat className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="truncate font-medium">{label}</span>
      <span className="text-muted-foreground">{t("work:counts.routines", { count: count })}</span>
    </div>
  );
}
