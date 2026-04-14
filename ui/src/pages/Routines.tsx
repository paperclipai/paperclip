import { startTransition, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate, useSearchParams } from "@/lib/router";
import { Check, ChevronDown, ChevronRight, Layers, MoreHorizontal, Plus, Repeat } from "lucide-react";
import { routinesApi } from "../api/routines";
import { agentsApi } from "../api/agents";
import { projectsApi } from "../api/projects";
import { issuesApi } from "../api/issues";
import { heartbeatsApi } from "../api/heartbeats";
import { useCompany } from "../context/CompanyContext";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useI18n } from "../context/I18nContext";
import { useToast } from "../context/ToastContext";
import { formatDateTime as fmtDateTime, getActiveLocale, translateActive } from "../lib/i18n";
import { queryKeys } from "../lib/queryKeys";
import { groupBy } from "../lib/groupBy";
import { createIssueDetailLocationState } from "../lib/issueDetailBreadcrumb";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { EmptyState } from "../components/EmptyState";
import { IssuesList } from "../components/IssuesList";
import { PageSkeleton } from "../components/PageSkeleton";
import { PageTabBar } from "../components/PageTabBar";
import { AgentIcon } from "../components/AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../components/InlineEntitySelector";
import { MarkdownEditor, type MarkdownEditorRef } from "../components/MarkdownEditor";
import {
  RoutineRunVariablesDialog,
  type RoutineRunDialogSubmitData,
} from "../components/RoutineRunVariablesDialog";
import { RoutineVariablesEditor, RoutineVariablesHint } from "../components/RoutineVariablesEditor";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Dialog, DialogContent } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
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

const concurrencyPolicies = ["coalesce_if_active", "always_enqueue", "skip_if_active"];
const catchUpPolicies = ["skip_missed", "enqueue_missed_with_cap"];
const concurrencyPolicyDescriptions: Record<string, string> = {
  coalesce_if_active: "routines.policy.coalesce_if_active",
  always_enqueue: "routines.policy.always_enqueue",
  skip_if_active: "routines.policy.skip_if_active",
};
const catchUpPolicyDescriptions: Record<string, string> = {
  skip_missed: "routines.policy.skip_missed",
  enqueue_missed_with_cap: "routines.policy.enqueue_missed_with_cap",
};

function autoResizeTextarea(element: HTMLTextAreaElement | null) {
  if (!element) return;
  element.style.height = "auto";
  element.style.height = `${element.scrollHeight}px`;
}

function formatLastRunTimestamp(value: Date | string | null | undefined) {
  if (!value) return translateActive("routines.never");
  return fmtDateTime(getActiveLocale(), value);
}

function nextRoutineStatus(currentStatus: string, enabled: boolean) {
  if (currentStatus === "archived" && enabled) return "active";
  return enabled ? "active" : "paused";
}

type RoutinesTab = "routines" | "runs";
type RoutineGroupBy = "none" | "project" | "assignee";

type RoutineViewState = {
  groupBy: RoutineGroupBy;
  collapsedGroups: string[];
};

type RoutineGroup = {
  key: string;
  label: string | null;
  items: RoutineListItem[];
};

const defaultRoutineViewState: RoutineViewState = {
  groupBy: "none",
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

function formatRoutineRunStatus(value: string | null | undefined) {
  if (!value) return null;
  return value.replaceAll("_", " ");
}

function buildRoutineMutationPayload(input: {
  title: string;
  description: string;
  projectId: string;
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
    assigneeAgentId: input.assigneeAgentId || null,
  };
}

export function buildRoutineGroups(
  routines: RoutineListItem[],
  groupByValue: RoutineGroupBy,
  projectById: Map<string, { name: string }>,
  agentById: Map<string, { name: string }>,
): RoutineGroup[] {
  if (groupByValue === "none") {
    return [{ key: "__all", label: null, items: routines }];
  }

  if (groupByValue === "project") {
    const groups = groupBy(routines, (routine) => routine.projectId ?? "__no_project");
    return Object.keys(groups)
      .sort((left, right) => {
        const leftLabel = left === "__no_project"
          ? translateActive("routines.no_project")
          : (projectById.get(left)?.name ?? translateActive("routines.unknown_project"));
        const rightLabel = right === "__no_project"
          ? translateActive("routines.no_project")
          : (projectById.get(right)?.name ?? translateActive("routines.unknown_project"));
        return leftLabel.localeCompare(rightLabel);
      })
      .map((key) => ({
        key,
        label: key === "__no_project"
          ? translateActive("routines.no_project")
          : (projectById.get(key)?.name ?? translateActive("routines.unknown_project")),
        items: groups[key]!,
      }));
  }

  const groups = groupBy(routines, (routine) => routine.assigneeAgentId ?? "__unassigned");
  return Object.keys(groups)
    .sort((left, right) => {
      const leftLabel = left === "__unassigned"
        ? translateActive("routines.unassigned")
        : (agentById.get(left)?.name ?? translateActive("routines.unknown_agent"));
      const rightLabel = right === "__unassigned"
        ? translateActive("routines.unassigned")
        : (agentById.get(right)?.name ?? translateActive("routines.unknown_agent"));
      return leftLabel.localeCompare(rightLabel);
    })
    .map((key) => ({
      key,
      label: key === "__unassigned"
        ? translateActive("routines.unassigned")
        : (agentById.get(key)?.name ?? translateActive("routines.unknown_agent")),
      items: groups[key]!,
    }));
}

function buildRoutinesTabHref(tab: RoutinesTab) {
  return tab === "runs" ? "/routines?tab=runs" : "/routines";
}

function RoutineListRow({
  routine,
  projectById,
  agentById,
  runningRoutineId,
  statusMutationRoutineId,
  href,
  onRunNow,
  onToggleEnabled,
  onToggleArchived,
  t,
}: {
  routine: RoutineListItem;
  projectById: Map<string, { name: string; color?: string | null }>;
  agentById: Map<string, { name: string; icon?: string | null }>;
  runningRoutineId: string | null;
  statusMutationRoutineId: string | null;
  href: string;
  onRunNow: (routine: RoutineListItem) => void;
  onToggleEnabled: (routine: RoutineListItem, enabled: boolean) => void;
  onToggleArchived: (routine: RoutineListItem) => void;
  t: (key: string, params?: Record<string, string | number>) => string;
}) {
  const enabled = routine.status === "active";
  const isArchived = routine.status === "archived";
  const isStatusPending = statusMutationRoutineId === routine.id;
  const project = routine.projectId ? projectById.get(routine.projectId) ?? null : null;
  const agent = routine.assigneeAgentId ? agentById.get(routine.assigneeAgentId) ?? null : null;
  const isDraft = !isArchived && !routine.assigneeAgentId;

  return (
    <Link
      to={href}
      className="group flex flex-col gap-3 border-b border-border px-3 py-3 transition-colors hover:bg-accent/50 last:border-b-0 sm:flex-row sm:items-center no-underline text-inherit"
    >
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="truncate text-sm font-medium">{routine.title}</span>
          {(isArchived || routine.status === "paused" || isDraft) ? (
            <span className="text-xs text-muted-foreground">
              {isArchived ? t("routines.archived") : isDraft ? t("routines.draft") : t("routines.paused")}
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="flex items-center gap-2">
            <span
              className="h-2.5 w-2.5 shrink-0 rounded-sm"
              style={{ backgroundColor: project?.color ?? "#64748b" }}
            />
            <span>{routine.projectId ? (project?.name ?? t("routines.unknown_project")) : t("routines.no_project")}</span>
          </span>
          <span className="flex items-center gap-2">
            {agent?.icon ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0" /> : null}
            <span>{routine.assigneeAgentId ? (agent?.name ?? t("routines.unknown_agent")) : t("routines.no_default_agent")}</span>
          </span>
          <span>
            {formatLastRunTimestamp(routine.lastRun?.triggeredAt)}
            {routine.lastRun ? ` · ${formatRoutineRunStatus(routine.lastRun.status)}` : ""}
          </span>
        </div>
      </div>

      <div className="flex items-center gap-3" onClick={(event) => { event.preventDefault(); event.stopPropagation(); }}>
        <div className="flex items-center gap-3">
          <ToggleSwitch
            size="lg"
            checked={enabled}
            onCheckedChange={() => onToggleEnabled(routine, enabled)}
            disabled={isStatusPending || isArchived}
            aria-label={enabled
              ? t("routines.disable_named", { name: routine.title })
              : t("routines.enable_named", { name: routine.title })}
          />
          <span className="w-12 text-xs text-muted-foreground">
            {isArchived ? t("routines.archived") : isDraft ? t("routines.draft") : enabled ? t("routines.on") : t("routines.off")}
          </span>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon-sm" aria-label={t("routines.more_actions_named", { name: routine.title })}>
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem asChild>
              <Link to={href}>{t("routines.edit")}</Link>
            </DropdownMenuItem>
            <DropdownMenuItem
              disabled={runningRoutineId === routine.id || isArchived}
              onClick={() => onRunNow(routine)}
            >
              {runningRoutineId === routine.id ? t("routines.running") : t("routines.run_now")}
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onClick={() => onToggleEnabled(routine, enabled)}
              disabled={isStatusPending || isArchived}
            >
              {enabled ? t("routines.pause") : t("routines.enable")}
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() => onToggleArchived(routine)}
              disabled={isStatusPending}
            >
              {routine.status === "archived" ? t("routines.restore") : t("routines.archive")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </Link>
  );
}

export function Routines() {
  const { selectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { pushToast } = useToast();
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const titleInputRef = useRef<HTMLTextAreaElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);
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
    assigneeAgentId: string;
    priority: string;
    concurrencyPolicy: string;
    catchUpPolicy: string;
    variables: RoutineVariable[];
  }>({
    title: "",
    description: "",
    projectId: "",
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

  useEffect(() => {
    setBreadcrumbs([{ label: t("nav.routines") }]);
  }, [setBreadcrumbs, t]);

  useEffect(() => {
    setRoutineViewState(getRoutineViewState(routineViewStateKey));
  }, [routineViewStateKey]);

  const { data: routines, isLoading, error } = useQuery({
    queryKey: queryKeys.routines.list(selectedCompanyId!),
    queryFn: () => routinesApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(selectedCompanyId!),
    queryFn: () => agentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(selectedCompanyId!),
    queryFn: () => projectsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });
  const { data: routineExecutionIssues, isLoading: recentRunsLoading, error: recentRunsError } = useQuery({
    queryKey: [...queryKeys.issues.list(selectedCompanyId!), "routine-executions"],
    queryFn: () => issuesApi.list(selectedCompanyId!, { originKind: "routine_execution" }),
    enabled: !!selectedCompanyId && activeTab === "runs",
  });
  const { data: liveRuns } = useQuery({
    queryKey: queryKeys.liveRuns(selectedCompanyId!),
    queryFn: () => heartbeatsApi.liveRunsForCompany(selectedCompanyId!),
    enabled: !!selectedCompanyId && activeTab === "runs",
    refetchInterval: 5000,
  });

  useEffect(() => {
    autoResizeTextarea(titleInputRef.current);
  }, [draft.title, composerOpen]);

  const createRoutine = useMutation({
    mutationFn: () =>
      routinesApi.create(selectedCompanyId!, buildRoutineMutationPayload(draft)),
    onSuccess: async (routine) => {
      setDraft({
        title: "",
        description: "",
        projectId: "",
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
        title: t("routines.created_title"),
        body: routine.assigneeAgentId
          ? t("routines.created_body_live")
          : t("routines.created_body_draft"),
        tone: "success",
      });
      navigate(`/routines/${routine.id}?tab=triggers`);
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
        title: t("routines.update_failed_title"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.update_failed_body"),
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
        title: t("routines.run_failed_title"),
        body: mutationError instanceof Error ? mutationError.message : t("routines.run_failed_body"),
        tone: "error",
      });
    },
  });

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [composerOpen]);
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
      (projects ?? []).map((project) => ({
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
  const liveIssueIds = useMemo(() => {
    const ids = new Set<string>();
    for (const run of liveRuns ?? []) {
      if (run.issueId) ids.add(run.issueId);
    }
    return ids;
  }, [liveRuns]);
  const routineGroups = useMemo(
    () => buildRoutineGroups(routines ?? [], routineViewState.groupBy, projectById, agentById),
    [agentById, projectById, routineViewState.groupBy, routines],
  );
  const recentRunsIssueLinkState = useMemo(
    () =>
      createIssueDetailLocationState(
        t("routines.recent_runs"),
        buildRoutinesTabHref("runs"),
        "issues",
      ),
    [t],
  );
  const currentAssignee = draft.assigneeAgentId ? agentById.get(draft.assigneeAgentId) ?? null : null;
  const currentProject = draft.projectId ? projectById.get(draft.projectId) ?? null : null;

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

  function handleRunNow(routine: RoutineListItem) {
    setRunDialogRoutine(routine);
  }

  function handleToggleEnabled(routine: RoutineListItem, enabled: boolean) {
    if (!enabled && !routine.assigneeAgentId) {
      pushToast({
        title: t("routines.default_agent_required_title"),
        body: t("routines.default_agent_required_body"),
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
    return <EmptyState icon={Repeat} message={t("routines.select_company")} />;
  }

  if (isLoading) {
    return <PageSkeleton variant="issues-list" />;
  }

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-1">
          <h1 className="text-2xl font-semibold tracking-tight">
            {t("nav.routines")}
          </h1>
          <p className="text-sm text-muted-foreground">
            {t("routines.subtitle")}
          </p>
        </div>
        <Button onClick={() => setComposerOpen(true)}>
          <Plus className="mr-2 h-4 w-4" />
          {t("routines.create")}
        </Button>
      </div>

      <Tabs value={activeTab} onValueChange={handleTabChange}>
        <PageTabBar
          align="start"
          value={activeTab}
          onValueChange={handleTabChange}
          items={[
            { value: "routines", label: t("nav.routines") },
            { value: "runs", label: t("routines.recent_runs") },
          ]}
        />
        <TabsContent value="routines" className="space-y-4">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-muted-foreground">
              {t("routines.count", { count: (routines ?? []).length })}
            </p>
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="ghost" size="sm" className="text-xs">
                  <Layers className="h-3.5 w-3.5 sm:h-3 sm:w-3 sm:mr-1" />
                  <span className="hidden sm:inline">{t("issues.group")}</span>
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="w-44 p-0">
                <div className="p-2 space-y-0.5">
                  {([
                    ["project", t("entity.project")],
                    ["assignee", t("entity.agent")],
                    ["none", t("issues.none")],
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
          </div>
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
          className="flex max-h-[calc(100dvh-2rem)] max-w-3xl flex-col gap-0 overflow-hidden p-0"
        >
          <div className="shrink-0 flex flex-wrap items-center justify-between gap-3 border-b border-border/60 px-5 py-3">
            <div>
              <p className="text-xs font-medium uppercase tracking-[0.2em] text-muted-foreground">{t("routines.new_routine")}</p>
              <p className="text-sm text-muted-foreground">
                {t("routines.new_routine_body")}
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
              {t("common.cancel")}
            </Button>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            <div className="px-5 pt-5 pb-3">
              <textarea
                ref={titleInputRef}
                className="w-full resize-none overflow-hidden bg-transparent text-xl font-semibold outline-none placeholder:text-muted-foreground/50"
                placeholder={t("routines.title_placeholder")}
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
                  <span>{t("routines.for")}</span>
                  <InlineEntitySelector
                    ref={assigneeSelectorRef}
                    value={draft.assigneeAgentId}
                    options={assigneeOptions}
                    placeholder={t("issues.assignee")}
                    noneLabel={t("routines.no_assignee")}
                    searchPlaceholder={t("issues.search_assignees")}
                    emptyMessage={t("routines.no_assignees_found")}
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
                        <span className="text-muted-foreground">{t("issues.assignee")}</span>
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
                  <span>{t("routines.in")}</span>
                  <InlineEntitySelector
                    ref={projectSelectorRef}
                    value={draft.projectId}
                    options={projectOptions}
                    placeholder={t("entity.project")}
                    noneLabel={t("routines.no_project")}
                    searchPlaceholder={t("routines.search_projects")}
                    emptyMessage={t("routines.no_projects_found")}
                    onChange={(projectId) => setDraft((current) => ({ ...current, projectId }))}
                    onConfirm={() => descriptionEditorRef.current?.focus()}
                    renderTriggerValue={(option) =>
                      option && currentProject ? (
                        <>
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: currentProject.color ?? "#64748b" }}
                          />
                          <span className="truncate">{option.label}</span>
                        </>
                      ) : (
                        <span className="text-muted-foreground">{t("entity.project")}</span>
                      )
                    }
                    renderOption={(option) => {
                      if (!option.id) return <span className="truncate">{option.label}</span>;
                      const project = projectById.get(option.id);
                      return (
                        <>
                          <span
                            className="h-3.5 w-3.5 shrink-0 rounded-sm"
                            style={{ backgroundColor: project?.color ?? "#64748b" }}
                          />
                          <span className="truncate">{option.label}</span>
                        </>
                      );
                    }}
                  />
                </div>
              </div>
            </div>

            <div className="border-t border-border/60 px-5 py-4">
              <MarkdownEditor
                ref={descriptionEditorRef}
                value={draft.description}
                onChange={(description) => setDraft((current) => ({ ...current, description }))}
                placeholder={t("routines.instructions_placeholder")}
                bordered={false}
                contentClassName="min-h-[160px] text-sm text-muted-foreground"
                onSubmit={() => {
                  if (!createRoutine.isPending && draft.title.trim()) {
                    createRoutine.mutate();
                  }
                }}
              />
              <div className="mt-3 space-y-3">
                <RoutineVariablesHint />
                <RoutineVariablesEditor
                  title={draft.title}
                  description={draft.description}
                  value={draft.variables}
                  onChange={(variables) => setDraft((current) => ({ ...current, variables }))}
                />
              </div>
            </div>

            <div className="border-t border-border/60 px-5 py-3">
              <Collapsible open={advancedOpen} onOpenChange={setAdvancedOpen}>
                <CollapsibleTrigger className="flex w-full items-center justify-between text-left">
                  <div>
                    <p className="text-sm font-medium">{t("routines.advanced_settings")}</p>
                    <p className="text-sm text-muted-foreground">{t("routines.advanced_settings_body")}</p>
                  </div>
                  {advancedOpen ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
                </CollapsibleTrigger>
                <CollapsibleContent className="pt-3">
                  <div className="grid gap-4 md:grid-cols-2">
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t("routines.concurrency")}</p>
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
                      <p className="text-xs text-muted-foreground">{t(concurrencyPolicyDescriptions[draft.concurrencyPolicy])}</p>
                    </div>
                    <div className="space-y-2">
                      <p className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{t("routines.catch_up")}</p>
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
                      <p className="text-xs text-muted-foreground">{t(catchUpPolicyDescriptions[draft.catchUpPolicy])}</p>
                    </div>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            </div>
          </div>

          <div className="shrink-0 flex flex-col gap-3 border-t border-border/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
            <div className="text-sm text-muted-foreground">
              {t("routines.footer_hint")}
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
                {createRoutine.isPending ? t("routines.creating") : t("routines.create")}
              </Button>
              {createRoutine.isError ? (
                <p className="text-sm text-destructive">
                  {createRoutine.error instanceof Error ? createRoutine.error.message : t("routines.create_failed")}
                </p>
              ) : null}
            </div>
          </div>
        </DialogContent>
      </Dialog>

      {error ? (
        <Card>
          <CardContent className="pt-6 text-sm text-destructive">
            {error instanceof Error ? error.message : t("routines.load_failed")}
          </CardContent>
        </Card>
      ) : null}

      {activeTab === "routines" ? (
        <div>
          {(routines ?? []).length === 0 ? (
            <div className="py-12">
              <EmptyState
                icon={Repeat}
                message={t("routines.empty")}
              />
            </div>
          ) : (
            <div className="rounded-lg border border-border">
              {routineGroups.map((group) => (
                <Collapsible
                  key={group.key}
                  open={!routineViewState.collapsedGroups.includes(group.key)}
                  onOpenChange={(open) => {
                    updateRoutineView({
                      collapsedGroups: open
                        ? routineViewState.collapsedGroups.filter((item) => item !== group.key)
                        : [...routineViewState.collapsedGroups, group.key],
                    });
                  }}
                >
                  {group.label ? (
                    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
                      <CollapsibleTrigger className="flex items-center gap-1.5">
                        <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground transition-transform [[data-state=open]>&]:rotate-90" />
                        <span className="text-sm font-semibold uppercase tracking-wide">
                          {group.label}
                        </span>
                      </CollapsibleTrigger>
                      <span className="text-xs text-muted-foreground">
                        {group.items.length}
                      </span>
                    </div>
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
                        onRunNow={handleRunNow}
                        onToggleEnabled={handleToggleEnabled}
                        onToggleArchived={handleToggleArchived}
                        t={t}
                      />
                    ))}
                  </CollapsibleContent>
                </Collapsible>
              ))}
            </div>
          )}
        </div>
      ) : null}

      <RoutineRunVariablesDialog
        open={runDialogRoutine !== null}
        onOpenChange={(next) => {
          if (!next) setRunDialogRoutine(null);
        }}
        companyId={selectedCompanyId}
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
