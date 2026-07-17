import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { pickTextColorForPillBg } from "@/lib/color-contrast";
import { issueStatusText } from "@/lib/status-colors";
import { Link } from "@/lib/router";
import { deriveOriginatingActor, type Issue, type IssueLabel } from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../../api/access";
import { agentsApi } from "../../api/agents";
import { authApi } from "../../api/auth";
import { executionWorkspacesApi } from "../../api/execution-workspaces";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { issuesApi } from "../../api/issues";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { queryKeys } from "../../lib/queryKeys";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserProfileMap, isAgentTaskTarget } from "../../lib/company-members";
import { ISSUE_OVERRIDE_ADAPTER_TYPES, type IssueModelLane } from "../../lib/issue-assignee-overrides";
import { useProjectOrder } from "../../hooks/useProjectOrder";
import {
  getRecentAssigneeIds,
  sortAgentsByRecency,
  trackRecentAssignee,
  trackRecentAssigneeUser,
} from "../../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../../lib/recent-projects";
import { orderItemsBySelectedAndRecent } from "../../lib/recent-selections";
import { formatAssigneeUserLabel, formatUserLabel } from "../../lib/assignees";
import { buildExecutionPolicy, stageParticipantValues } from "../../lib/issue-execution-policy";
import { formatMonitorOffset } from "../../lib/issue-monitor";
import { extractProviderIdWithFallback } from "../../lib/model-utils";
import { formatRetryReason } from "../../lib/runRetryState";
import { useRetryNowMutation } from "../../hooks/useRetryNowMutation";
import { RetryErrorBand } from "../IssueScheduledRetryCard";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";
import { Identity } from "../Identity";
import { IssueReferencePill } from "../IssueReferencePill";
import { formatDate, formatDateTime, cn, projectUrl } from "../../lib/utils";
import type { IssueExternalObjectGroup } from "../../hooks/useIssueExternalObjects";
import { timeAgo } from "../../lib/timeAgo";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { User, ArrowUpRight, Plus, GitBranch, FolderOpen, HardDrive, Check, Clock, RotateCcw, Loader2, CheckCircle2 } from "lucide-react";
import { AgentIcon } from "../AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "../InlineEntitySelector";
import {
  AssigneeRunningBanner,
  InterruptAssignConfirm,
  type HandoffChipResolvers,
} from "../interrupt-handoff/InterruptHandoffViews";
import { describeReassignInterrupt } from "../../lib/interrupt-handoff";
import {
  buildWorkspaceRuntimeControlSections,
  WorkspaceRuntimeQuickControls,
  type WorkspaceRuntimeControlRequest,
} from "../WorkspaceRuntimeControls";
import { ExternalObjectRows } from "./external-object-rows";
import {
  asRecord,
  compactRecord,
  defaultExecutionWorkspaceModeForProject,
  defaultProjectWorkspaceIdForProject,
  isMainIssueWorkspace,
  overrideLane,
  sortAdapterModels,
  thinkingEffortKeyFor,
  thinkingEffortOptionsFor,
  thinkingEffortValueFor,
  toDateTimeLocalValue,
} from "./helpers";
import { PropertyPicker } from "./property-picker";
import { PropertyChip, PropertyRow, PropertySection } from "./primitives";
import { ExpandRelationListButton, RemovableIssueReferencePill } from "./relation-controls";

function TruncatedCopyable({ value, icon: Icon }: { value: string; icon: ComponentType<{ className?: string }> }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }, [value]);

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1" title={value}>
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <button
        type="button"
        className="text-sm font-mono min-w-0 truncate text-left cursor-pointer hover:text-foreground transition-colors"
        onClick={handleCopy}
        title={value}
        aria-label={`Copy ${value} to clipboard`}
      >
        {value}
      </button>
      {copied && (
        <span className={cn("inline-flex items-center gap-1 text-xs shrink-0", issueStatusText.done)} role="status">
          <Check className="h-3 w-3 shrink-0" />
          Copied
        </span>
      )}
    </div>
  );
}

interface IssuePropertiesProps {
  issue: Issue;
  childIssues?: Issue[];
  onAddSubIssue?: () => void;
  onUpdate: (data: Record<string, unknown>) => void;
  inline?: boolean;
  /** Whether an agent run is currently in flight on this issue, so the assignee
   * picker can warn that reassigning will interrupt it. */
  hasActiveRun?: boolean;
  externalObjects?: IssueExternalObjectGroup[];
  externalObjectsLoading?: boolean;
  externalObjectsError?: boolean;
  onRetryExternalObjects?: () => void;
}

const ISSUE_BLOCKER_SEARCH_LIMIT = 50;
const ISSUE_PROPERTY_RELATION_PREVIEW_COUNT = 5;

export function IssueProperties({
  issue,
  childIssues = [],
  onAddSubIssue,
  onUpdate,
  inline,
  hasActiveRun = false,
  externalObjects,
  externalObjectsLoading,
  externalObjectsError,
  onRetryExternalObjects,
}: IssuePropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const companyId = issue.companyId ?? selectedCompanyId;
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  const taskWatchdogsEnabled = experimentalSettings?.enableTaskWatchdogs === true;
  const [assigneeOpen, setAssigneeOpen] = useState(false);
  const [assigneeSearch, setAssigneeSearch] = useState("");
  /** When a run is live, a selection is staged here until the operator confirms
   * the interrupt rather than applying it immediately. */
  const [pendingAssignee, setPendingAssignee] = useState<{
    assigneeAgentId: string | null;
    assigneeUserId: string | null;
    label: string;
    track?: () => void;
  } | null>(null);
  const [projectOpen, setProjectOpen] = useState(false);
  const [projectSearch, setProjectSearch] = useState("");
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [blockedByExpanded, setBlockedByExpanded] = useState(false);
  const [blockingExpanded, setBlockingExpanded] = useState(false);
  const [subTasksExpanded, setSubTasksExpanded] = useState(false);
  const [relatedTasksExpanded, setRelatedTasksExpanded] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [approversOpen, setApproversOpen] = useState(false);
  const [approverSearch, setApproverSearch] = useState("");
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [scheduledRetryOpen, setScheduledRetryOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [monitorAtInput, setMonitorAtInput] = useState(() => toDateTimeLocalValue(issue.executionPolicy?.monitor?.nextCheckAt));
  const [monitorNotesInput, setMonitorNotesInput] = useState(issue.executionPolicy?.monitor?.notes ?? "");
  const [monitorServiceInput, setMonitorServiceInput] = useState(issue.executionPolicy?.monitor?.serviceName ?? "");
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);
  const [runtimeActionErrorMessage, setRuntimeActionErrorMessage] = useState<string | null>(null);
  const [watchdogOpen, setWatchdogOpen] = useState(false);
  const [watchdogAgentInput, setWatchdogAgentInput] = useState(issue.watchdog?.watchdogAgentId ?? "");
  const [watchdogInstructionsInput, setWatchdogInstructionsInput] = useState(issue.watchdog?.instructions ?? "");
  const normalizedBlockedBySearch = blockedBySearch.trim();

  useEffect(() => {
    setBlockedByExpanded(false);
    setBlockingExpanded(false);
    setSubTasksExpanded(false);
    setRelatedTasksExpanded(false);
  }, [issue.id]);

  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(companyId!),
    queryFn: () => agentsApi.list(companyId!),
    enabled: !!companyId,
  });
  const { data: companyMembers } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(companyId!),
    queryFn: () => accessApi.listUserDirectory(companyId!),
    enabled: !!companyId,
  });
  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(companyId!),
    queryFn: () => projectsApi.list(companyId!),
    enabled: !!companyId,
  });
  const activeProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archivedAt || p.id === issue.projectId),
    [projects, issue.projectId],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId,
    userId: currentUserId,
  });

  const { data: labels } = useQuery({
    queryKey: queryKeys.issues.labels(companyId!),
    queryFn: () => issuesApi.listLabels(companyId!),
    enabled: !!companyId,
  });

  const { data: allIssues, isFetching: isFetchingIssuePickerIssues } = useQuery({
    queryKey: queryKeys.issues.list(companyId!),
    queryFn: () => issuesApi.list(companyId!),
    enabled: !!companyId && (parentOpen || (blockedByOpen && normalizedBlockedBySearch.length === 0)),
  });

  const { data: searchedBlockedByIssues, isFetching: isFetchingSearchedBlockedByIssues } = useQuery({
    queryKey: companyId
      ? queryKeys.issues.search(companyId, normalizedBlockedBySearch, undefined, ISSUE_BLOCKER_SEARCH_LIMIT)
      : ["issues", "blocker-search", normalizedBlockedBySearch, ISSUE_BLOCKER_SEARCH_LIMIT],
    queryFn: () => issuesApi.list(companyId!, {
      q: normalizedBlockedBySearch,
      limit: ISSUE_BLOCKER_SEARCH_LIMIT,
    }),
    enabled: !!companyId && blockedByOpen && normalizedBlockedBySearch.length > 0,
  });

  const createLabel = useMutation({
    mutationFn: (data: { name: string; color: string }) => issuesApi.createLabel(companyId!, data),
    onSuccess: async (created) => {
      queryClient.setQueryData<IssueLabel[] | undefined>(
        queryKeys.issues.labels(companyId!),
        (current) => {
          if (!current) return [created];
          if (current.some((label) => label.id === created.id)) return current;
          return [...current, created];
        },
      );
      onUpdate({ labelIds: [...(issue.labelIds ?? []), created.id] });
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.labels(companyId!) });
      setNewLabelName("");
    },
  });

  const toggleLabel = (labelId: string) => {
    const ids = issue.labelIds ?? [];
    const next = ids.includes(labelId)
      ? ids.filter((id) => id !== labelId)
      : [...ids, labelId];
    onUpdate({ labelIds: next });
  };

  const agentName = (id: string | null) => {
    if (!id || !agents) return null;
    const agent = agents.find((a) => a.id === id);
    return agent?.name ?? id.slice(0, 8);
  };

  const projectName = (id: string | null) => {
    if (!id) return id?.slice(0, 8) ?? "None";
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const currentProject = issue.projectId
    ? orderedProjects.find((project) => project.id === issue.projectId) ?? null
    : null;
  const issueProject = issue.project ?? currentProject;
  const issueUsesMainWorkspace = useMemo(
    () => isMainIssueWorkspace({ issue, project: issueProject }),
    [issue, issueProject],
  );
  const showWorkspaceDetailLink = Boolean(issue.executionWorkspaceId) && !issueUsesMainWorkspace;
  const workspaceRuntimeConfig = issueUsesMainWorkspace
    ? null
    : issue.currentExecutionWorkspace?.config?.workspaceRuntime ?? null;
  const workspaceRuntimeServices = issue.currentExecutionWorkspace?.runtimeServices ?? [];
  const workspaceCanRunCommands = Boolean(issue.currentExecutionWorkspace?.cwd);
  const workspaceCanStartServices = Boolean(workspaceRuntimeConfig) && workspaceCanRunCommands;
  const workspaceRuntimeSections = useMemo(() => buildWorkspaceRuntimeControlSections({
    runtimeConfig: workspaceRuntimeConfig,
    runtimeServices: workspaceRuntimeServices,
    canStartServices: workspaceCanStartServices,
    canRunJobs: workspaceCanRunCommands,
  }), [workspaceCanRunCommands, workspaceCanStartServices, workspaceRuntimeConfig, workspaceRuntimeServices]);
  const hasWorkspaceRuntimeControls = !issueUsesMainWorkspace && (
    workspaceRuntimeSections.services.length > 0
    || workspaceRuntimeSections.otherServices.length > 0
  );
  const controlWorkspaceRuntime = useMutation({
    mutationFn: (request: WorkspaceRuntimeControlRequest) => {
      const workspaceId = issue.currentExecutionWorkspace?.id ?? issue.executionWorkspaceId;
      if (!workspaceId) throw new Error("This task is not attached to a workspace.");
      return executionWorkspacesApi.controlRuntimeCommands(workspaceId, request.action, request);
    },
    onSuccess: (result, request) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(result.workspace.id), result.workspace);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.overview(result.workspace.companyId) });
      void queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(result.workspace.id) });
      if (companyId) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(companyId) });
      }
      setRuntimeActionErrorMessage(null);
      setRuntimeActionMessage(
        request.action === "run"
          ? "Workspace job completed."
          : request.action === "stop"
            ? "Workspace service stopped."
            : request.action === "restart"
              ? "Workspace service restarted."
              : "Workspace service started.",
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setRuntimeActionErrorMessage(error instanceof Error ? error.message : "Failed to control workspace commands.");
    },
  });
  const pendingWorkspaceRuntimeAction = controlWorkspaceRuntime.isPending ? controlWorkspaceRuntime.variables ?? null : null;
  const referencedIssueIdentifiers = issue.referencedIssueIdentifiers ?? [];
  const relatedTasks = useMemo(() => {
    const excluded = new Set<string>();
    const addExcluded = (candidate: { id: string; identifier?: string | null }) => {
      excluded.add(candidate.id);
      if (candidate.identifier) excluded.add(candidate.identifier);
    };

    for (const blocker of issue.blockedBy ?? []) addExcluded(blocker);
    for (const blocked of issue.blocks ?? []) addExcluded(blocked);
    for (const child of childIssues) addExcluded(child);

    const referencedIssues = issue.relatedWork?.outbound.map((item) => item.issue) ?? [];
    if (referencedIssues.length > 0) {
      return referencedIssues.filter((referenced) => {
        const label = referenced.identifier ?? referenced.id;
        return !excluded.has(referenced.id) && !excluded.has(label);
      });
    }

    return referencedIssueIdentifiers
      .filter((identifier) => !excluded.has(identifier))
      .map((identifier) => ({ id: identifier, identifier, title: identifier }));
  }, [childIssues, issue.blockedBy, issue.blocks, issue.relatedWork?.outbound, referencedIssueIdentifiers]);
  const projectLink = (id: string | null) => {
    if (!id) return null;
    const project = projects?.find((p) => p.id === id) ?? null;
    return project ? projectUrl(project) : `/projects/${id}`;
  };

  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [assigneeOpen]);
  const sortedAgents = useMemo(
    () => sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentAssigneeIds),
    [agents, recentAssigneeIds],
  );
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [projectOpen]);
  const userLabelMap = useMemo(
    () => buildCompanyUserLabelMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const userProfileMap = useMemo(
    () => buildCompanyUserProfileMap(companyMembers?.users),
    [companyMembers?.users],
  );
  const otherUserOptions = useMemo(
    () => buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId, issue.createdByUserId] }),
    [companyMembers?.users, currentUserId, issue.createdByUserId],
  );

  const assignee = issue.assigneeAgentId
    ? agents?.find((a) => a.id === issue.assigneeAgentId)
    : null;
  const assigneeAdapterType = assignee?.adapterType ?? null;
  const assigneeAdapterOverrides = issue.assigneeAdapterOverrides ?? null;
  const showAssigneeAdapterOptions = assigneeAdapterOverrides !== null;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType),
  );
  const assigneeSupportsCheapLane = Boolean(
    supportsAssigneeOverrides
      && (assigneeAdapterType === "claude_local"
        || assigneeAdapterType === "codex_local"
        || assigneeAdapterType === "opencode_local"),
  );
  const assigneeOverrideLane = overrideLane(assigneeAdapterOverrides);
  const assigneeOverrideAdapterConfig = asRecord(assigneeAdapterOverrides?.adapterConfig);
  const assigneeOverrideModel =
    typeof assigneeOverrideAdapterConfig.model === "string" ? assigneeOverrideAdapterConfig.model : "";
  const assigneeOverrideThinkingEffort = thinkingEffortValueFor(
    assigneeAdapterType,
    assigneeOverrideAdapterConfig,
  );
  const assigneeOverrideChrome = assigneeAdapterType === "claude_local"
    && assigneeOverrideAdapterConfig.chrome === true;
  const { data: assigneeAdapterModels } = useQuery({
    queryKey:
      companyId && assigneeAdapterType
        ? queryKeys.agents.adapterModels(companyId, assigneeAdapterType)
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(companyId!, assigneeAdapterType!),
    enabled: Boolean(companyId) && showAssigneeAdapterOptions && supportsAssigneeOverrides,
  });
  const { data: assigneeCheapProfiles } = useQuery({
    queryKey: companyId && assigneeAdapterType
      ? queryKeys.agents.adapterModelProfiles(companyId, assigneeAdapterType)
      : ["agents", "none", "adapter-model-profiles", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModelProfiles(companyId!, assigneeAdapterType!),
    enabled: Boolean(companyId) && showAssigneeAdapterOptions && assigneeSupportsCheapLane,
  });
  const assigneeCheapProfile = useMemo(
    () => (assigneeCheapProfiles ?? []).find((profile) => profile.key === "cheap") ?? null,
    [assigneeCheapProfiles],
  );
  const modelOverrideOptions = useMemo<InlineEntityOption[]>(() => {
    const models = sortAdapterModels(assigneeAdapterModels ?? []);
    const options = models.map((model) => ({
      id: model.id,
      label: model.label,
      searchText: `${model.id} ${extractProviderIdWithFallback(model.id)}`,
    }));
    if (assigneeOverrideModel && !options.some((option) => option.id === assigneeOverrideModel)) {
      options.unshift({
        id: assigneeOverrideModel,
        label: assigneeOverrideModel,
        searchText: assigneeOverrideModel,
      });
    }
    return options;
  }, [assigneeAdapterModels, assigneeOverrideModel]);
  const updateAssigneeAdapterOverrides = (next: Issue["assigneeAdapterOverrides"]) => {
    onUpdate({ assigneeAdapterOverrides: next });
  };
  const buildAssigneeOverrideWithConfig = (adapterConfig: Record<string, unknown>) => {
    const nextConfig = compactRecord(adapterConfig);
    const next = compactRecord({
      useProjectWorkspace: assigneeAdapterOverrides?.useProjectWorkspace,
      ...(Object.keys(nextConfig).length > 0 ? { adapterConfig: nextConfig } : {}),
    });
    return Object.keys(next).length > 0 ? next : null;
  };
  const updateAssigneeOverrideConfig = (patch: Record<string, unknown>) => {
    updateAssigneeAdapterOverrides(
      buildAssigneeOverrideWithConfig({
        ...assigneeOverrideAdapterConfig,
        ...patch,
      }),
    );
  };
  const updateAssigneeOverrideThinkingEffort = (nextValue: string) => {
    const nextConfig = { ...assigneeOverrideAdapterConfig };
    delete nextConfig.modelReasoningEffort;
    delete nextConfig.reasoningEffort;
    delete nextConfig.effort;
    delete nextConfig.variant;
    if (nextValue) {
      nextConfig[thinkingEffortKeyFor(assigneeAdapterType)] = nextValue;
    }
    updateAssigneeAdapterOverrides(buildAssigneeOverrideWithConfig(nextConfig));
  };
  const setAssigneeOverrideLane = (lane: IssueModelLane) => {
    if (lane === "primary") {
      updateAssigneeAdapterOverrides(null);
      return;
    }
    if (lane === "cheap") {
      updateAssigneeAdapterOverrides(
        compactRecord({
          useProjectWorkspace: assigneeAdapterOverrides?.useProjectWorkspace,
          modelProfile: "cheap",
        }),
      );
      return;
    }
    updateAssigneeAdapterOverrides(buildAssigneeOverrideWithConfig(assigneeOverrideAdapterConfig) ?? { adapterConfig: {} });
  };
  const assigneeOptionsTrigger = (() => {
    if (assigneeOverrideLane === "cheap") {
      return <span className="text-sm">Cheap model</span>;
    }
    if (assigneeOverrideLane === "custom") {
      const details = [
        assigneeOverrideModel,
        assigneeOverrideThinkingEffort,
        assigneeOverrideChrome ? "Chrome" : "",
      ].filter(Boolean);
      return (
        <span className="min-w-0 truncate text-sm" title={details.length > 0 ? `Custom · ${details.join(" · ")}` : "Custom adapter options"}>
          Custom{details.length > 0 ? ` · ${details.join(" · ")}` : " adapter options"}
        </span>
      );
    }
    return <span className="text-sm text-muted-foreground">Primary model</span>;
  })();
  const assigneeOptionsContent = supportsAssigneeOverrides ? (
    <div className="w-full space-y-3 p-2">
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">Model lane</div>
        <div className="flex w-full overflow-hidden rounded-md border border-border" role="radiogroup" aria-label="Model lane">
          {(["primary", ...(assigneeSupportsCheapLane ? (["cheap"] as const) : ([] as const)), "custom"] as const).map((lane) => (
            <button
              key={lane}
              type="button"
              role="radio"
              aria-checked={assigneeOverrideLane === lane}
              className={cn(
                "flex-1 px-2 py-1 text-xs capitalize transition-colors hover:bg-accent/40",
                assigneeOverrideLane === lane && "bg-accent text-foreground",
              )}
              onClick={() => setAssigneeOverrideLane(lane)}
            >
              {lane === "primary" ? "Primary" : lane === "cheap" ? "Cheap" : "Custom"}
            </button>
          ))}
        </div>
        {assigneeOverrideLane === "cheap" ? (
          <p className="text-xs text-muted-foreground">
            Sends <code>modelProfile: "cheap"</code>{" "}
            {assigneeCheapProfile?.adapterConfig && typeof (assigneeCheapProfile.adapterConfig as Record<string, unknown>).model === "string"
              ? <>· adapter default <code>{String((assigneeCheapProfile.adapterConfig as Record<string, unknown>).model)}</code></>
              : assigneeCheapProfile
                ? <>· uses the agent&apos;s configured cheap profile</>
                : <>· falls back to the primary model if no cheap profile is configured</>}
          </p>
        ) : null}
      </div>
      {assigneeOverrideLane === "custom" ? (
        <>
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">Model</div>
            <InlineEntitySelector
              value={assigneeOverrideModel}
              options={modelOverrideOptions}
              placeholder="Default model"
              disablePortal
              noneLabel="Default model"
              searchPlaceholder="Search models..."
              emptyMessage="No models found."
              onChange={(model) => updateAssigneeOverrideConfig({ model: model || undefined })}
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">Thinking effort</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {thinkingEffortOptionsFor(assigneeAdapterType).map((option) => (
                <button
                  key={option.value || "default"}
                  className={cn(
                    "px-2 py-1 rounded-md text-xs border border-border hover:bg-accent/50 transition-colors",
                    assigneeOverrideThinkingEffort === option.value && "bg-accent",
                  )}
                  onClick={() => updateAssigneeOverrideThinkingEffort(option.value)}
                >
                  {option.label}
                </button>
              ))}
            </div>
          </div>
          {assigneeAdapterType === "claude_local" ? (
            <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
              <div className="text-xs text-muted-foreground">Enable Chrome (--chrome)</div>
              <ToggleSwitch
                checked={assigneeOverrideChrome}
                onCheckedChange={(next) => updateAssigneeOverrideConfig({ chrome: next ? true : undefined })}
              />
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  ) : (
    <div className="w-full space-y-2 p-2">
      <p className="text-xs text-muted-foreground">
        {assignee
          ? "This assignee's adapter does not expose editable task overrides."
          : "Select a compatible assignee agent to edit these overrides."}
      </p>
      <button
        type="button"
        className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        onClick={() => updateAssigneeAdapterOverrides(null)}
      >
        Clear adapter options
      </button>
    </div>
  );
  const reviewerValues = stageParticipantValues(issue.executionPolicy, "review");
  const approverValues = stageParticipantValues(issue.executionPolicy, "approval");
  const userLabel = (userId: string | null | undefined) => formatAssigneeUserLabel(userId, currentUserId, userLabelMap);
  const actualUserLabel = (userId: string | null | undefined) => formatUserLabel(userId, userLabelMap);
  const assigneeUserLabel = userLabel(issue.assigneeUserId);
  const creatorUserLabel = actualUserLabel(issue.createdByUserId);
  const originatingActor = deriveOriginatingActor(issue);
  const originatingUserProfile =
    originatingActor?.kind === "user" ? userProfileMap.get(originatingActor.id) : null;
  const originatingViaAgentName =
    originatingActor?.kind === "user" && originatingActor.viaAgentId
      ? agentName(originatingActor.viaAgentId) ?? originatingActor.viaAgentId.slice(0, 8)
      : null;
  const selectedAssigneeValue = issue.assigneeAgentId
    ? `agent:${issue.assigneeAgentId}`
    : issue.assigneeUserId
      ? `user:${issue.assigneeUserId}`
      : "";

  // --- Interrupt-handoff clarity for the assignee picker (design surface 2) ---
  const handoffResolvers: HandoffChipResolvers = useMemo(
    () => ({
      agentMap: new Map((agents ?? []).map((agent) => [agent.id, { name: agent.name, icon: agent.icon }])),
      resolveUserLabel: (id) => userLabel(id),
    }),
    // userLabel closes over userLabelMap + currentUserId, both reflected here.
    [agents, userLabelMap, currentUserId],
  );
  const reassignInterruptCopy = useMemo(
    () => describeReassignInterrupt({ runningAgentName: assignee?.name ?? null }),
    [assignee?.name],
  );
  const closeAssigneePicker = () => {
    setAssigneeOpen(false);
    setAssigneeSearch("");
    setPendingAssignee(null);
  };
  const applyAssignee = (next: { assigneeAgentId: string | null; assigneeUserId: string | null }, track?: () => void) => {
    track?.();
    onUpdate(next);
    closeAssigneePicker();
  };
  /** Apply a selection immediately, or stage it for confirmation while a run is live. */
  const selectAssignee = (
    next: { assigneeAgentId: string | null; assigneeUserId: string | null },
    label: string,
    track?: () => void,
  ) => {
    const nextValue = next.assigneeAgentId
      ? `agent:${next.assigneeAgentId}`
      : next.assigneeUserId
        ? `user:${next.assigneeUserId}`
        : "";
    if (nextValue === selectedAssigneeValue) {
      closeAssigneePicker();
      return;
    }
    if (hasActiveRun) {
      setPendingAssignee({ ...next, label, track });
      return;
    }
    applyAssignee(next, track);
  };
  const updateExecutionPolicy = (nextReviewers: string[], nextApprovers: string[]) => {
    onUpdate({
      executionPolicy: buildExecutionPolicy({
        existingPolicy: issue.executionPolicy ?? null,
        reviewerValues: nextReviewers,
        approverValues: nextApprovers,
      }),
    });
  };
  const toggleExecutionParticipant = (stageType: "review" | "approval", value: string) => {
    const currentValues = stageType === "review" ? reviewerValues : approverValues;
    const nextValues = currentValues.includes(value)
      ? currentValues.filter((candidate) => candidate !== value)
      : [...currentValues, value];
    updateExecutionPolicy(
      stageType === "review" ? nextValues : reviewerValues,
      stageType === "approval" ? nextValues : approverValues,
    );
  };
  const executionParticipantLabel = (value: string) => {
    if (value.startsWith("agent:")) {
      return agentName(value.slice("agent:".length)) ?? value.slice("agent:".length, "agent:".length + 8);
    }
    if (value.startsWith("user:")) {
      return userLabel(value.slice("user:".length)) ?? "User";
    }
    return value;
  };
  const reviewerLabel = reviewerValues.map((value) => executionParticipantLabel(value)).join(", ");
  const approverLabel = approverValues.map((value) => executionParticipantLabel(value)).join(", ");
  const reviewerTrigger = reviewerValues.length > 0
    ? <span className="text-sm truncate min-w-0" title={reviewerLabel}>{reviewerLabel}</span>
    : <span className="text-sm text-muted-foreground">None</span>;
  const approverTrigger = approverValues.length > 0
    ? <span className="text-sm truncate min-w-0" title={approverLabel}>{approverLabel}</span>
    : <span className="text-sm text-muted-foreground">None</span>;
  const nextRunnableExecutionStage = (() => {
    if (issue.executionState?.status === "changes_requested" && issue.executionState.currentStageType) {
      return issue.executionState.currentStageType;
    }
    if (issue.executionState) return null;
    if (reviewerValues.length > 0) return "review";
    if (approverValues.length > 0) return "approval";
    return null;
  })();
  const runExecutionButton = (stageType: "review" | "approval") => (
    <PropertyRow label="">
      <button
        type="button"
        className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        onClick={() => onUpdate({ status: "in_review" })}
      >
        {stageType === "review" ? "Run review now" : "Run approval now"}
      </button>
    </PropertyRow>
  );
  const currentExecutionLabel = (() => {
    if (!issue.executionState?.currentStageType) return null;
    const stageLabel = issue.executionState.currentStageType === "review" ? "Review" : "Approval";
    const participant = issue.executionState.currentParticipant;
    const participantLabel = participant
      ? (participant.type === "agent"
        ? agentName(participant.agentId ?? null)
        : userLabel(participant.userId ?? null))
      : null;
    if (issue.executionState.status === "changes_requested") {
      return `${stageLabel} requested changes${participantLabel ? ` by ${participantLabel}` : ""}`;
    }
    return `${stageLabel} pending${participantLabel ? ` with ${participantLabel}` : ""}`;
  })();
  useEffect(() => {
    setMonitorAtInput(toDateTimeLocalValue(issue.executionPolicy?.monitor?.nextCheckAt));
    setMonitorNotesInput(issue.executionPolicy?.monitor?.notes ?? "");
    setMonitorServiceInput(issue.executionPolicy?.monitor?.serviceName ?? "");
  }, [
    issue.executionPolicy?.monitor?.nextCheckAt,
    issue.executionPolicy?.monitor?.notes,
    issue.executionPolicy?.monitor?.serviceName,
  ]);
  // Re-sync watchdog editor inputs when the persisted watchdog changes (and reset on close).
  useEffect(() => {
    if (watchdogOpen) return;
    setWatchdogAgentInput(issue.watchdog?.watchdogAgentId ?? "");
    setWatchdogInstructionsInput(issue.watchdog?.instructions ?? "");
  }, [issue.watchdog?.watchdogAgentId, issue.watchdog?.instructions, watchdogOpen]);

  const watchdogAgentOptions = useMemo<InlineEntityOption[]>(
    () =>
      (agents ?? [])
        .filter(isAgentTaskTarget)
        .map((agent) => ({
          id: agent.id,
          label: agent.name,
          searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
        })),
    [agents],
  );
  const upsertWatchdog = useMutation({
    mutationFn: (data: { agentId: string; instructions: string | null }) =>
      issuesApi.upsertWatchdog(issue.id, data),
    onSuccess: (watchdog) => {
      queryClient.setQueryData<Issue>(queryKeys.issues.detail(issue.id), (current) =>
        current ? { ...current, watchdog } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      setWatchdogOpen(false);
    },
  });
  const deleteWatchdog = useMutation({
    mutationFn: () => issuesApi.deleteWatchdog(issue.id),
    onSuccess: () => {
      queryClient.setQueryData<Issue>(queryKeys.issues.detail(issue.id), (current) =>
        current ? { ...current, watchdog: null } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      setWatchdogOpen(false);
    },
  });
  const saveWatchdog = () => {
    if (!watchdogAgentInput) return;
    upsertWatchdog.mutate({
      agentId: watchdogAgentInput,
      instructions: watchdogInstructionsInput.trim() || null,
    });
  };
  const removeWatchdog = () => {
    if (issue.watchdog) {
      deleteWatchdog.mutate();
    } else {
      setWatchdogOpen(false);
    }
    setWatchdogAgentInput("");
    setWatchdogInstructionsInput("");
  };
  const watchdogMutationError =
    upsertWatchdog.error instanceof Error
      ? upsertWatchdog.error.message
      : deleteWatchdog.error instanceof Error
        ? deleteWatchdog.error.message
        : null;
  const watchdogIssueRef = (childIssues ?? []).find(
    (child) => child.id === issue.watchdog?.watchdogIssueId,
  );
  const watchdogTrigger = issue.watchdog ? (
    <span className="inline-flex min-w-0 max-w-full items-center gap-1.5 text-sm" title={issue.watchdog.instructions?.trim() || undefined}>
      {(() => {
        const agent = (agents ?? []).find((candidate) => candidate.id === issue.watchdog?.watchdogAgentId);
        return agent ? <AgentIcon icon={agent.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null;
      })()}
      <span className="shrink-0 max-w-40 truncate">{agentName(issue.watchdog.watchdogAgentId)}</span>
      {issue.watchdog.instructions?.trim() ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          · {issue.watchdog.instructions.trim()}
        </span>
      ) : null}
      {issue.watchdog.status === "disabled" ? (
        <span className="shrink-0 text-xs text-muted-foreground">(disabled)</span>
      ) : null}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const watchdogContent = (
    <div className="space-y-3 p-2">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-foreground">Watchdog agent</div>
        <InlineEntitySelector
          value={watchdogAgentInput}
          options={watchdogAgentOptions}
          placeholder="Select agent"
          noneLabel="No watchdog agent"
          searchPlaceholder="Search agents..."
          emptyMessage="No agents found."
          onChange={setWatchdogAgentInput}
          renderTriggerValue={(option) => {
            if (!option) return <span className="text-muted-foreground">Select agent</span>;
            const agent = (agents ?? []).find((candidate) => candidate.id === option.id);
            return (
              <>
                {agent ? <AgentIcon icon={agent.icon} className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
                <span className="truncate">{option.label}</span>
              </>
            );
          }}
          renderOption={(option) => {
            const agent = (agents ?? []).find((candidate) => candidate.id === option.id);
            return (
              <>
                {agent ? <AgentIcon icon={agent.icon} className="h-3 w-3 shrink-0 text-muted-foreground" /> : null}
                <span className="truncate">{option.label}</span>
              </>
            );
          }}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-foreground">
          Instructions <span className="font-normal text-muted-foreground">(optional)</span>
        </div>
        <Textarea
          value={watchdogInstructionsInput}
          onChange={(event) => setWatchdogInstructionsInput(event.target.value)}
          placeholder="What should the watchdog watch for and how should it keep work moving?"
          rows={4}
          className="text-xs"
        />
      </div>
      {watchdogIssueRef ? (
        <div className="text-xs text-muted-foreground">
          Watchdog task:{" "}
          <Link to={`/issues/${watchdogIssueRef.id}`} className="text-primary hover:underline">
            {watchdogIssueRef.identifier ?? "View task"}
          </Link>
        </div>
      ) : null}
      {watchdogMutationError ? (
        <div className="rounded border border-destructive/40 bg-destructive/10 px-2 py-1 text-xs text-destructive">
          {watchdogMutationError}
        </div>
      ) : null}
      <div className="flex items-center justify-between">
        <button
          type="button"
          className="text-xs text-muted-foreground hover:text-destructive transition-colors disabled:opacity-50"
          disabled={deleteWatchdog.isPending || (!issue.watchdog && !watchdogAgentInput)}
          onClick={removeWatchdog}
        >
          {deleteWatchdog.isPending ? "Removing…" : "Remove"}
        </button>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={!watchdogAgentInput || upsertWatchdog.isPending}
          onClick={saveWatchdog}
        >
          {upsertWatchdog.isPending ? "Saving…" : issue.watchdog ? "Update" : "Set watchdog"}
        </Button>
      </div>
    </div>
  );

  const updateMonitor = (nextMonitor: Issue["executionPolicy"] extends infer T
    ? T extends { monitor?: infer M | null } | null | undefined
      ? M | null
      : never
    : never) => {
    const basePolicy = buildExecutionPolicy({
      existingPolicy: issue.executionPolicy ?? null,
      reviewerValues,
      approverValues,
    });
    if (!basePolicy && !nextMonitor) {
      onUpdate({ executionPolicy: null });
      return;
    }
    onUpdate({
      executionPolicy: {
        mode: basePolicy?.mode ?? issue.executionPolicy?.mode ?? "normal",
        commentRequired: true,
        stages: basePolicy?.stages ?? [],
        ...(nextMonitor ? { monitor: nextMonitor } : {}),
      },
    });
  };
  const saveMonitor = () => {
    if (!monitorAtInput) return;
    const nextCheckAt = new Date(monitorAtInput);
    if (Number.isNaN(nextCheckAt.getTime())) return;
    const serviceName = monitorServiceInput.trim() || null;
    updateMonitor({
      nextCheckAt: nextCheckAt.toISOString(),
      notes: monitorNotesInput.trim() || null,
      scheduledBy: "board",
      kind: serviceName ? "external_service" : null,
      serviceName,
      externalRef: null,
    });
    setMonitorOpen(false);
  };
  const clearMonitor = () => {
    updateMonitor(null);
    setMonitorOpen(false);
  };
  const currentMonitorLabel = (() => {
    if (issue.executionPolicy?.monitor?.nextCheckAt) {
      return `Next check ${formatDate(new Date(issue.executionPolicy.monitor.nextCheckAt))}`;
    }
    if (issue.executionState?.monitor?.status === "cleared") {
      return "Cleared";
    }
    if (issue.monitorLastTriggeredAt) {
      return `Last triggered ${timeAgo(issue.monitorLastTriggeredAt)}`;
    }
    return "None";
  })();
  const monitorNextCheckAt = issue.executionPolicy?.monitor?.nextCheckAt ?? null;
  const monitorTrigger = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      {monitorNextCheckAt ? (
        <Clock className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
      <span
        className={cn(
          "min-w-0 truncate text-sm",
          monitorNextCheckAt ? "text-foreground" : "text-muted-foreground",
        )}
        title={monitorNextCheckAt ? currentMonitorLabel : undefined}
      >
        {monitorNextCheckAt ? `Next check ${formatMonitorOffset(monitorNextCheckAt)}` : currentMonitorLabel}
      </span>
      {monitorNextCheckAt ? (
        <span className="shrink-0 text-xs text-muted-foreground" title={currentMonitorLabel}>
          {formatDate(new Date(monitorNextCheckAt))}
        </span>
      ) : null}
    </span>
  );
  const monitorAttemptBadge = issue.monitorAttemptCount && issue.monitorAttemptCount > 0 ? (
    <span className="text-xs text-muted-foreground">
      Attempt {issue.monitorAttemptCount}
    </span>
  ) : null;

  const scheduledRetry = issue.scheduledRetry ?? null;
  const retryNow = useRetryNowMutation(issue.id);
  const showScheduledRetryRow = scheduledRetry && scheduledRetry.status === "scheduled_retry";
  const scheduledRetryDueAtIso = scheduledRetry?.scheduledRetryAt
    ? new Date(scheduledRetry.scheduledRetryAt).toISOString()
    : null;
  const scheduledRetryRelative = scheduledRetryDueAtIso
    ? formatMonitorOffset(scheduledRetryDueAtIso)
    : null;
  const scheduledRetryAbsolute = scheduledRetry?.scheduledRetryAt
    ? formatDateTime(scheduledRetry.scheduledRetryAt)
    : null;
  const scheduledRetryShortDate = scheduledRetry?.scheduledRetryAt
    ? formatDate(new Date(scheduledRetry.scheduledRetryAt))
    : null;
  const scheduledRetryReasonLabel = formatRetryReason(scheduledRetry?.scheduledRetryReason);
  const scheduledRetryAttempt =
    typeof scheduledRetry?.scheduledRetryAttempt === "number"
    && Number.isFinite(scheduledRetry.scheduledRetryAttempt)
    && scheduledRetry.scheduledRetryAttempt > 0
      ? scheduledRetry.scheduledRetryAttempt
      : null;
  const scheduledRetryIsContinuation =
    scheduledRetry?.scheduledRetryReason === "max_turns_continuation";
  const scheduledRetryRelativeLabel = (() => {
    if (!scheduledRetryRelative) return "Pending schedule";
    const action = scheduledRetryIsContinuation ? "Continuation" : "Retry";
    if (scheduledRetryRelative === "now") return `${action} due now`;
    return `${action} ${scheduledRetryRelative}`;
  })();
  const scheduledRetryRetryNowSuccess = retryNow.isSuccess
    && (retryNow.data?.outcome === "promoted" || retryNow.data?.outcome === "already_promoted");
  const scheduledRetryAttemptBadge = scheduledRetryAttempt !== null ? (
    <span className="whitespace-nowrap shrink-0 text-xs text-muted-foreground">Attempt {scheduledRetryAttempt}</span>
  ) : null;
  const scheduledRetryTrigger = (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <RotateCcw className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span
        className="min-w-0 truncate text-sm text-foreground"
        title={scheduledRetryAbsolute ?? undefined}
      >
        {scheduledRetryRelativeLabel}
      </span>
      {scheduledRetryShortDate ? (
        <span className="shrink-0 text-xs text-muted-foreground" title={scheduledRetryAbsolute ?? undefined}>
          {scheduledRetryShortDate}
        </span>
      ) : null}
    </span>
  );
  const scheduledRetryContent = scheduledRetry ? (
    <div className="flex w-full flex-col gap-2 p-2 text-xs">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-foreground">
          {scheduledRetryIsContinuation ? "Scheduled continuation" : "Scheduled retry"}
        </span>
        {scheduledRetryAttempt !== null ? (
          <span className="text-xs text-muted-foreground">
            Attempt {scheduledRetryAttempt}
          </span>
        ) : null}
      </div>
      <dl className="grid grid-cols-[6rem_1fr] gap-y-1">
        {scheduledRetryReasonLabel ? (
          <>
            <dt className="text-muted-foreground">Reason</dt>
            <dd className="text-foreground">{scheduledRetryReasonLabel}</dd>
          </>
        ) : null}
        {scheduledRetryAbsolute ? (
          <>
            <dt className="text-muted-foreground">Next attempt</dt>
            <dd className="text-foreground">
              {scheduledRetryAbsolute}
              {scheduledRetryRelative ? (
                <span className="ml-1 text-muted-foreground">· {scheduledRetryRelative}</span>
              ) : null}
            </dd>
          </>
        ) : null}
        {scheduledRetry.retryOfRunId ? (
          <>
            <dt className="text-muted-foreground">Replaces run</dt>
            <dd className="text-foreground">
              <Link
                to={`/agents/${scheduledRetry.agentId}/runs/${scheduledRetry.retryOfRunId}`}
                className="font-mono text-foreground hover:underline"
              >
                {scheduledRetry.retryOfRunId.slice(0, 8)}
              </Link>
            </dd>
          </>
        ) : null}
        {scheduledRetry.agentName ? (
          <>
            <dt className="text-muted-foreground">Agent</dt>
            <dd className="text-foreground">
              <Link
                to={`/agents/${scheduledRetry.agentId}`}
                className="text-foreground hover:underline"
              >
                {scheduledRetry.agentName}
              </Link>
            </dd>
          </>
        ) : null}
        {scheduledRetry.error ? (
          <>
            <dt className="text-muted-foreground">Last error</dt>
            <dd className="text-foreground break-words">{scheduledRetry.error}</dd>
          </>
        ) : null}
      </dl>
      <RetryErrorBand
        error={retryNow.lastError}
        onRetry={() => {
          retryNow.reset();
          retryNow.mutate();
        }}
      />
      <Separator className="my-1" />
      <div className="flex items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="default"
          onClick={() => retryNow.mutate()}
          disabled={retryNow.isPending || scheduledRetryRetryNowSuccess}
          data-testid="issue-scheduled-retry-properties-retry-now"
        >
          {retryNow.isPending ? (
            <span className="inline-flex items-center gap-1.5">
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Retrying…
            </span>
          ) : scheduledRetryRetryNowSuccess ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {retryNow.data?.outcome === "already_promoted" ? "Already promoted" : "Promoted"}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
              Retry now
            </span>
          )}
        </Button>
        <span className="text-right text-xs text-muted-foreground">
          {retryNow.isPending
            ? "Promoting scheduled retry"
            : scheduledRetryRetryNowSuccess
              ? retryNow.data?.outcome === "already_promoted"
                ? "Already promoted — run starting"
                : "Promoted — run starting"
              : scheduledRetryIsContinuation
                ? "Pulls continuation forward immediately"
                : "Pulls retry forward immediately"}
        </span>
      </div>
    </div>
  ) : null;
  const monitorContent = (
    <div className="flex w-full flex-col gap-2">
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          type="datetime-local"
          className="rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          value={monitorAtInput}
          onChange={(e) => setMonitorAtInput(e.target.value)}
        />
        <input
          type="text"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          placeholder="What should the agent re-check?"
          value={monitorNotesInput}
          onChange={(e) => setMonitorNotesInput(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          type="text"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          placeholder="External service"
          value={monitorServiceInput}
          onChange={(e) => setMonitorServiceInput(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
            disabled={!monitorAtInput}
            onClick={saveMonitor}
          >
            Schedule
          </button>
          {issue.executionPolicy?.monitor ? (
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              onClick={clearMonitor}
            >
              Clear
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );

  const selectedIssueLabels = useMemo(() => {
    const selectedIds = issue.labelIds ?? [];
    if (selectedIds.length === 0) return issue.labels ?? [];

    const labelById = new Map<string, IssueLabel>();
    for (const label of labels ?? []) labelById.set(label.id, label);
    for (const label of issue.labels ?? []) labelById.set(label.id, label);

    return selectedIds
      .map((id) => labelById.get(id))
      .filter((label): label is IssueLabel => Boolean(label));
  }, [issue.labelIds, issue.labels, labels]);

  const labelsTrigger = selectedIssueLabels.length > 0 ? (
    <div className="flex items-center gap-1 flex-wrap">
      {selectedIssueLabels.slice(0, 3).map((label) => (
        <PropertyChip
          key={label.id}
          style={{
            borderColor: label.color,
            backgroundColor: `${label.color}22`,
            color: pickTextColorForPillBg(label.color, 0.13),
          }}
        >
          {label.name}
        </PropertyChip>
      ))}
      {selectedIssueLabels.length > 3 && (
        <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">
          +{selectedIssueLabels.length - 3} more
        </span>
      )}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const labelsExtra = (issue.labelIds ?? []).length > 0 ? (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={() => setLabelsOpen(true)}
      aria-label="Add label"
      title="Add label"
    >
      <Plus className="h-3 w-3" />
      Add label
    </button>
  ) : undefined;

  const labelsContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search labels..."
        value={labelSearch}
        onChange={(e) => setLabelSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-44 overflow-y-auto overscroll-contain space-y-0.5">
        {(labels ?? [])
          .filter((label) => {
            if (!labelSearch.trim()) return true;
            return label.name.toLowerCase().includes(labelSearch.toLowerCase());
          })
          .map((label) => {
            const selected = (issue.labelIds ?? []).includes(label.id);
            return (
              <button
                key={label.id}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
                  selected && "bg-accent"
                )}
                onClick={() => toggleLabel(label.id)}
              >
                <span className="h-2.5 w-2.5 rounded-full shrink-0" style={{ backgroundColor: label.color }} />
                <span className="truncate flex-1">{label.name}</span>
                {selected && <Check className="h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
              </button>
            );
          })}
      </div>
      <div className="mt-2 border-t border-border pt-2 space-y-1">
        <div className="flex items-center gap-1">
          <input
            className="h-7 w-7 p-0 rounded bg-transparent"
            type="color"
            value={newLabelColor}
            onChange={(e) => setNewLabelColor(e.target.value)}
          />
          <input
            className="flex-1 px-2 py-1.5 text-xs bg-transparent outline-none rounded placeholder:text-muted-foreground/50"
            placeholder="New label"
            value={newLabelName}
            onChange={(e) => setNewLabelName(e.target.value)}
          />
        </div>
        <button
          className="flex items-center justify-center gap-1.5 w-full px-2 py-1.5 text-xs rounded border border-border hover:bg-accent/50 disabled:opacity-50"
          disabled={!newLabelName.trim() || createLabel.isPending}
          onClick={() =>
            createLabel.mutate({
              name: newLabelName.trim(),
              color: newLabelColor,
            })
          }
        >
          <Plus className="h-3 w-3" />
          {createLabel.isPending ? "Creating…" : "Create label"}
        </button>
      </div>
    </>
  );

  const assigneeTrigger = assignee ? (
    <Identity name={assignee.name} size="sm" shape="square" />
  ) : assigneeUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm" title={assigneeUserLabel}>{assigneeUserLabel}</span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">Unassigned</span>
  );

  // Grouped picker options (design surface 2): a board-users section and an
  // agents section, plus the "No assignee" reset. Agents stay recency-sorted
  // within their group via `sortedAgents`.
  const userAssigneeOptions = [
    ...(currentUserId
      ? [{
          kind: "user" as const,
          value: `user:${currentUserId}`,
          userId: currentUserId,
          label: "Assign to me",
          searchText: userLabel(currentUserId) ?? "",
        }]
      : []),
    ...(issue.createdByUserId && issue.createdByUserId !== currentUserId
      ? [{
          kind: "user" as const,
          value: `user:${issue.createdByUserId}`,
          userId: issue.createdByUserId,
          label: creatorUserLabel ? `Assign to ${creatorUserLabel}` : "Assign to requester",
          searchText: creatorUserLabel ?? "requester",
        }]
      : []),
    ...otherUserOptions.map((option) => ({
      kind: "user" as const,
      value: option.id,
      userId: option.id.slice("user:".length),
      label: option.label,
      searchText: option.searchText ?? "",
    })),
  ];
  const agentAssigneeOptions = sortedAgents.map((agent) => ({
    kind: "agent" as const,
    value: `agent:${agent.id}`,
    agent,
    label: agent.name,
    searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
  }));

  const matchesAssigneeSearch = (label: string, searchText: string) => {
    if (!assigneeSearch.trim()) return true;
    return `${label} ${searchText}`.toLowerCase().includes(assigneeSearch.toLowerCase());
  };

  type AssigneeOptionLike =
    | { kind: "none"; value: string; label: string; searchText: string }
    | { kind: "user"; value: string; userId: string; label: string; searchText: string }
    | { kind: "agent"; value: string; agent: (typeof agentAssigneeOptions)[number]["agent"]; label: string; searchText: string };

  const renderAssigneeOption = (option: AssigneeOptionLike) => (
    <button
      key={option.value || "__none__"}
      className={cn(
        "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-left",
        option.value === selectedAssigneeValue && "bg-accent",
      )}
      onClick={() => {
        if (option.kind === "agent") {
          selectAssignee({ assigneeAgentId: option.agent.id, assigneeUserId: null }, option.label, () =>
            trackRecentAssignee(option.agent.id),
          );
        } else if (option.kind === "user") {
          selectAssignee({ assigneeAgentId: null, assigneeUserId: option.userId }, option.label, () =>
            trackRecentAssigneeUser(option.userId),
          );
        } else {
          selectAssignee({ assigneeAgentId: null, assigneeUserId: null }, option.label);
        }
      }}
    >
      {option.kind === "agent" ? (
        <AgentIcon icon={option.agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
      ) : option.kind === "user" ? (
        <User className="h-3 w-3 shrink-0 text-muted-foreground" />
      ) : null}
      <span className="min-w-0 flex-1 truncate">{option.label}</span>
      {option.value === selectedAssigneeValue ? (
        <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />
      ) : null}
    </button>
  );

  const visibleUserOptions = userAssigneeOptions.filter((option) =>
    matchesAssigneeSearch(option.label, option.searchText),
  );
  const visibleAgentOptions = agentAssigneeOptions.filter((option) =>
    matchesAssigneeSearch(option.label, option.searchText),
  );
  const showNoAssigneeOption = matchesAssigneeSearch("No assignee", "");
  const sectionHeader = (text: string) => (
    <div className="px-2 pb-0.5 pt-1.5 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
      {text}
    </div>
  );

  const assigneeContent = pendingAssignee ? (
    <div className="space-y-2 p-1">
      <InterruptAssignConfirm
        copy={reassignInterruptCopy}
        to={{ agentId: pendingAssignee.assigneeAgentId, userId: pendingAssignee.assigneeUserId }}
        resolvers={handoffResolvers}
        onConfirm={() =>
          applyAssignee(
            { assigneeAgentId: pendingAssignee.assigneeAgentId, assigneeUserId: pendingAssignee.assigneeUserId },
            pendingAssignee.track,
          )
        }
        onCancel={() => setPendingAssignee(null)}
      />
    </div>
  ) : (
    <>
      {hasActiveRun ? (
        <div className="px-1 pt-1">
          <AssigneeRunningBanner copy={reassignInterruptCopy} />
        </div>
      ) : null}
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search assignees..."
        value={assigneeSearch}
        onChange={(e) => setAssigneeSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-56 overflow-y-auto overscroll-contain">
        {showNoAssigneeOption
          ? renderAssigneeOption({ kind: "none", value: "", label: "No assignee", searchText: "" })
          : null}
        {visibleAgentOptions.length > 0 ? (
          <>
            {sectionHeader("Agents")}
            {visibleAgentOptions.map((option) => renderAssigneeOption(option))}
          </>
        ) : null}
        {visibleUserOptions.length > 0 ? (
          <>
            {sectionHeader("Board users")}
            {visibleUserOptions.map((option) => renderAssigneeOption(option))}
          </>
        ) : null}
        {!showNoAssigneeOption && visibleAgentOptions.length === 0 && visibleUserOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No matches.</div>
        ) : null}
      </div>
    </>
  );

  const executionParticipantsContent = (
    stageType: "review" | "approval",
    values: string[],
    search: string,
    setSearch: (value: string) => void,
    onClear: () => void,
  ) => (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder={`Search ${stageType === "review" ? "reviewers" : "approvers"}...`}
        value={search}
        onChange={(e) => setSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            values.length === 0 && "bg-accent",
          )}
          onClick={onClear}
        >
          No {stageType === "review" ? "reviewers" : "approvers"}
        </button>
        {currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${currentUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${currentUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            Assign to me
          </button>
        )}
        {issue.createdByUserId && issue.createdByUserId !== currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${issue.createdByUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${issue.createdByUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />
            {creatorUserLabel ? creatorUserLabel : "Requester"}
          </button>
        )}
        {otherUserOptions
          .filter((option) => {
            if (!search.trim()) return true;
            return `${option.label} ${option.searchText ?? ""}`.toLowerCase().includes(search.toLowerCase());
          })
          .map((option) => (
            <button
              key={`${stageType}:${option.id}`}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                values.includes(option.id) && "bg-accent",
              )}
              onClick={() => toggleExecutionParticipant(stageType, option.id)}
            >
              <User className="h-3 w-3 shrink-0 text-muted-foreground" />
              {option.label}
            </button>
          ))}
        {sortedAgents
          .filter((agent) => {
            if (!search.trim()) return true;
            return agent.name.toLowerCase().includes(search.toLowerCase());
          })
          .map((agent) => {
            const encoded = `agent:${agent.id}`;
            return (
              <button
                key={`${stageType}:${agent.id}`}
                className={cn(
                  "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                  values.includes(encoded) && "bg-accent",
                )}
                onClick={() => toggleExecutionParticipant(stageType, encoded)}
              >
                <AgentIcon icon={agent.icon} className="shrink-0 h-3 w-3 text-muted-foreground" />
                {agent.name}
              </button>
            );
          })}
      </div>
    </>
  );

  const projectTrigger = issue.projectId ? (
    <>
      <span
        className="shrink-0 h-3 w-3 rounded-sm"
        style={{ backgroundColor: orderedProjects.find((p) => p.id === issue.projectId)?.color ?? "#6366f1" }}
      />
      <span className="text-sm truncate min-w-0" title={projectName(issue.projectId)}>{projectName(issue.projectId)}</span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const projectPickerOptions = orderItemsBySelectedAndRecent(
    [
      { id: "", kind: "none" as const, name: "No project", color: null as string | null },
      ...orderedProjects.map((project) => ({
        id: project.id,
        kind: "project" as const,
        project,
        name: project.name,
        color: project.color ?? null,
      })),
    ],
    issue.projectId ?? "",
    recentProjectIds,
  );

  const projectContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search projects..."
        value={projectSearch}
        onChange={(e) => setProjectSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        {projectPickerOptions
          .filter((option) => {
            if (!projectSearch.trim()) return true;
            const q = projectSearch.toLowerCase();
            return option.name.toLowerCase().includes(q);
          })
          .map((option) => (
            <button
              key={option.id || "__none__"}
              className={cn(
                "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 whitespace-nowrap",
                option.id === (issue.projectId ?? "") && "bg-accent",
              )}
              onClick={() => {
                if (option.kind === "project") {
                  const defaultMode = defaultExecutionWorkspaceModeForProject(option.project);
                  trackRecentProject(option.project.id);
                  onUpdate({
                    projectId: option.project.id,
                    projectWorkspaceId: defaultProjectWorkspaceIdForProject(option.project),
                    executionWorkspaceId: null,
                    executionWorkspacePreference: defaultMode,
                    executionWorkspaceSettings: option.project.executionWorkspacePolicy?.enabled
                      ? { mode: defaultMode }
                      : null,
                  });
                } else {
                  onUpdate({
                    projectId: null,
                    projectWorkspaceId: null,
                    executionWorkspaceId: null,
                    executionWorkspacePreference: null,
                    executionWorkspaceSettings: null,
                  });
                }
                setProjectOpen(false);
              }}
            >
              {option.kind === "project" ? (
                <span
                  className="shrink-0 h-3 w-3 rounded-sm"
                  style={{ backgroundColor: option.color ?? "#6366f1" }}
                />
              ) : null}
              {option.name}
            </button>
          ))}
      </div>
    </>
  );

  const blockedByIds = issue.blockedBy?.map((relation) => relation.id) ?? [];
  const blockedByRelations = issue.blockedBy ?? [];
  const visibleBlockedByRelations = blockedByExpanded
    ? blockedByRelations
    : blockedByRelations.slice(0, ISSUE_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenBlockedByCount = blockedByRelations.length - visibleBlockedByRelations.length;
  const visibleChildIssues = subTasksExpanded
    ? childIssues
    : childIssues.slice(0, ISSUE_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenChildIssueCount = childIssues.length - visibleChildIssues.length;
  const blockingIssues = issue.blocks ?? [];
  const visibleBlockingIssues = blockingExpanded
    ? blockingIssues
    : blockingIssues.slice(0, ISSUE_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenBlockingIssueCount = blockingIssues.length - visibleBlockingIssues.length;
  const visibleRelatedTasks = relatedTasksExpanded
    ? relatedTasks
    : relatedTasks.slice(0, ISSUE_PROPERTY_RELATION_PREVIEW_COUNT);
  const hiddenRelatedTaskCount = relatedTasks.length - visibleRelatedTasks.length;
  const descendantIssueIds = useMemo(() => {
    if (!allIssues?.length) return new Set<string>();
    const childrenByParentId = new Map<string, string[]>();
    for (const candidate of allIssues) {
      if (!candidate.parentId) continue;
      const children = childrenByParentId.get(candidate.parentId) ?? [];
      children.push(candidate.id);
      childrenByParentId.set(candidate.parentId, children);
    }

    const descendants = new Set<string>();
    const stack = [...(childrenByParentId.get(issue.id) ?? [])];
    while (stack.length > 0) {
      const candidateId = stack.pop();
      if (!candidateId || descendants.has(candidateId)) continue;
      descendants.add(candidateId);
      stack.push(...(childrenByParentId.get(candidateId) ?? []));
    }
    return descendants;
  }, [allIssues, issue.id]);
  const currentParentIssue = useMemo(() => {
    if (!issue.parentId) return null;
    return allIssues?.find((candidate) => candidate.id === issue.parentId) ?? null;
  }, [allIssues, issue.parentId]);
  const parentIdentifier = issue.ancestors?.[0]?.identifier ?? currentParentIssue?.identifier;
  const parentTitle = issue.ancestors?.[0]?.title ?? currentParentIssue?.title ?? issue.parentId?.slice(0, 8);
  const parentTrigger = issue.parentId ? (
    <span
      className="text-sm truncate min-w-0"
      title={`${parentIdentifier ? `${parentIdentifier} ` : ""}${parentTitle ?? ""}`.trim()}
    >
      {parentIdentifier ? `${parentIdentifier} ` : ""}
      {parentTitle}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">None</span>
  );
  const parentLink = issue.parentId ? (
    <Link
      to={`/issues/${parentIdentifier ?? issue.parentId}`}
      className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
      onClick={(e) => e.stopPropagation()}
    >
      <ArrowUpRight className="h-3 w-3" />
    </Link>
  ) : undefined;
  const parentOptions = (allIssues ?? [])
    .filter((candidate) => candidate.id !== issue.id)
    .filter((candidate) => !descendantIssueIds.has(candidate.id))
    .filter((candidate) => {
      if (!parentSearch.trim()) return true;
      const query = parentSearch.toLowerCase();
      return (
        (candidate.identifier ?? "").toLowerCase().includes(query) ||
        candidate.title.toLowerCase().includes(query)
      );
    })
    .sort((a, b) => {
      const aLabel = `${a.identifier ?? ""} ${a.title}`.trim();
      const bLabel = `${b.identifier ?? ""} ${b.title}`.trim();
      return aLabel.localeCompare(bLabel);
    });
  const parentContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search tasks..."
        value={parentSearch}
        onChange={(e) => setParentSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            !issue.parentId && "bg-accent",
          )}
          onClick={() => {
            onUpdate({ parentId: null });
            setParentOpen(false);
          }}
        >
          No parent
        </button>
        {parentOptions.map((candidate) => (
          <button
            key={candidate.id}
            className={cn(
              "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
              candidate.id === issue.parentId && "bg-accent",
            )}
            onClick={() => {
              onUpdate({ parentId: candidate.id });
              setParentOpen(false);
            }}
          >
            <StatusIcon status={candidate.status} className="h-3 w-3" />
            <span className="truncate">
              {candidate.identifier ? `${candidate.identifier} ` : ""}
              {candidate.title}
            </span>
          </button>
        ))}
      </div>
    </>
  );
  const blockerSearchActive = normalizedBlockedBySearch.length > 0;
  const blockerSourceIssues = blockerSearchActive ? searchedBlockedByIssues : allIssues;
  const blockerOptions = (blockerSourceIssues ?? [])
    .filter((candidate) => candidate.id !== issue.id);
  if (!blockerSearchActive) {
    blockerOptions.sort((a, b) => {
      const aLabel = `${a.identifier ?? ""} ${a.title}`.trim();
      const bLabel = `${b.identifier ?? ""} ${b.title}`.trim();
      return aLabel.localeCompare(bLabel);
    });
  }
  const blockerOptionsLoading = blockedByOpen && (
    blockerSearchActive ? isFetchingSearchedBlockedByIssues : isFetchingIssuePickerIssues
  );

  const toggleBlockedBy = (blockedByIssueId: string) => {
    const nextBlockedByIds = blockedByIds.includes(blockedByIssueId)
      ? blockedByIds.filter((candidate) => candidate !== blockedByIssueId)
      : [...blockedByIds, blockedByIssueId];
    onUpdate({ blockedByIssueIds: nextBlockedByIds });
    setBlockedByOpen(false);
    setBlockedBySearch("");
  };
  const removeBlockedBy = (blockedByIssueId: string) => {
    onUpdate({ blockedByIssueIds: blockedByIds.filter((candidate) => candidate !== blockedByIssueId) });
  };

  const blockedByContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder="Search tasks..."
        value={blockedBySearch}
        onChange={(e) => setBlockedBySearch(e.target.value)}
        autoFocus={!inline}
        aria-label="Search tasks to add as blockers"
      />
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        <button
          className={cn(
            "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
            blockedByIds.length === 0 && "bg-accent",
          )}
          onClick={() => {
            onUpdate({ blockedByIssueIds: [] });
            setBlockedByOpen(false);
            setBlockedBySearch("");
          }}
        >
          No blockers
        </button>
        {blockerOptions.map((candidate) => {
          const selected = blockedByIds.includes(candidate.id);
          return (
            <button
              key={candidate.id}
              className={cn(
                "flex w-full items-center gap-2 px-2 py-1.5 text-left text-xs rounded hover:bg-accent/50",
                selected && "bg-accent",
              )}
              onClick={() => toggleBlockedBy(candidate.id)}
            >
              <StatusIcon status={candidate.status} className="h-3 w-3" />
              <span className="truncate">
                {candidate.identifier ? `${candidate.identifier} ` : ""}
                {candidate.title}
              </span>
              {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
            </button>
          );
        })}
        {blockerOptionsLoading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">Searching tasks...</div>
        ) : blockerOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">No matching tasks.</div>
        ) : null}
      </div>
    </>
  );
  const renderAddBlockedByButton = (onClick?: () => void) => (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={onClick}
    >
      <Plus className="h-3 w-3" />
      Add blocker
    </button>
  );

  return (
    <div>
      <PropertySection title="Triage" first>
        <PropertyRow label="Status">
          <StatusIcon
            status={issue.status}
            size="lg"
            blockerAttention={issue.blockerAttention}
            onChange={(status) => onUpdate({ status })}
            showLabel
          />
        </PropertyRow>

        <PropertyRow label="Priority">
          <PriorityIcon
            priority={issue.priority}
            onChange={(priority) => onUpdate({ priority })}
            showLabel
          />
        </PropertyRow>

        <PropertyPicker
          inline={inline}
          label="Labels"
          open={labelsOpen}
          onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
          triggerContent={labelsTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-64"
          extra={labelsExtra}
        >
          {labelsContent}
        </PropertyPicker>

        <PropertyPicker
          inline={inline}
          label="Assignee"
          open={assigneeOpen}
          onOpenChange={(open) => { setAssigneeOpen(open); if (!open) { setAssigneeSearch(""); setPendingAssignee(null); } }}
          triggerContent={assigneeTrigger}
          popoverClassName="w-52"
          extra={issue.assigneeAgentId ? (
            <Link
              to={`/agents/${issue.assigneeAgentId}`}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {assigneeContent}
        </PropertyPicker>

        {showAssigneeAdapterOptions ? (
          <PropertyPicker
            inline={inline}
            label="Model"
            open={assigneeOptionsOpen}
            onOpenChange={setAssigneeOptionsOpen}
            triggerContent={assigneeOptionsTrigger}
            triggerClassName="min-w-0 max-w-full"
            popoverClassName={cn("max-w-full", inline ? "w-full" : "w-72")}
          >
            {assigneeOptionsContent}
          </PropertyPicker>
        ) : null}

        <PropertyPicker
          inline={inline}
          label="Project"
          open={projectOpen}
          onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
          triggerContent={projectTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-fit min-w-[11rem]"
          extra={issue.projectId ? (
            <Link
              to={projectLink(issue.projectId)!}
              className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
              onClick={(e) => e.stopPropagation()}
            >
              <ArrowUpRight className="h-3 w-3" />
            </Link>
          ) : undefined}
        >
          {projectContent}
        </PropertyPicker>
      </PropertySection>

      <PropertySection title="Relationships">
        <PropertyPicker
          inline={inline}
          label="Parent"
          open={parentOpen}
          onOpenChange={(open) => {
            setParentOpen(open);
            if (!open) setParentSearch("");
          }}
          triggerContent={parentTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-72"
          extra={parentLink}
        >
          {parentContent}
        </PropertyPicker>

        {inline ? (
          <div>
            <PropertyRow label="Blocked by" wrap>
              {visibleBlockedByRelations.map((relation) => (
                <RemovableIssueReferencePill key={relation.id} issue={relation} onRemove={removeBlockedBy} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenBlockedByCount}
                expanded={blockedByExpanded}
                onClick={() => setBlockedByExpanded((expanded) => !expanded)}
              />
              {renderAddBlockedByButton(() => setBlockedByOpen((open) => !open))}
            </PropertyRow>
            {blockedByOpen && (
              <div className="rounded-md border border-border bg-popover p-1 mb-2">
                {blockedByContent}
              </div>
            )}
          </div>
        ) : (
          <PropertyRow label="Blocked by" wrap>
            {visibleBlockedByRelations.map((relation) => (
              <RemovableIssueReferencePill key={relation.id} issue={relation} onRemove={removeBlockedBy} />
            ))}
            <ExpandRelationListButton
              hiddenCount={hiddenBlockedByCount}
              expanded={blockedByExpanded}
              onClick={() => setBlockedByExpanded((expanded) => !expanded)}
            />
            <Popover
              open={blockedByOpen}
              onOpenChange={(open) => {
                setBlockedByOpen(open);
                if (!open) setBlockedBySearch("");
              }}
            >
              <PopoverTrigger asChild>
                {renderAddBlockedByButton()}
              </PopoverTrigger>
              <PopoverContent className="w-72 p-1" align="end" collisionPadding={16}>
                {blockedByContent}
              </PopoverContent>
            </Popover>
          </PropertyRow>
        )}

        <PropertyRow label="Blocking" wrap>
          {blockingIssues.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleBlockingIssues.map((relation) => (
                <IssueReferencePill key={relation.id} issue={relation} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenBlockingIssueCount}
                expanded={blockingExpanded}
                onClick={() => setBlockingExpanded((expanded) => !expanded)}
              />
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">None</span>
          )}
        </PropertyRow>

        <PropertyRow label="Sub-tasks" wrap>
          <div className="flex flex-wrap items-center gap-1.5">
            {childIssues.length > 0
              ? visibleChildIssues.map((child) => (
                <IssueReferencePill key={child.id} issue={child} />
              ))
              : null}
            <ExpandRelationListButton
              hiddenCount={hiddenChildIssueCount}
              expanded={subTasksExpanded}
              onClick={() => setSubTasksExpanded((expanded) => !expanded)}
            />
            {onAddSubIssue ? (
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                onClick={onAddSubIssue}
              >
                <Plus className="h-3 w-3" />
                Add sub-task
              </button>
            ) : null}
          </div>
        </PropertyRow>

        {relatedTasks.length > 0 ? (
          <PropertyRow label="Related tasks" wrap>
            <div className="flex flex-wrap items-center gap-1.5">
              {visibleRelatedTasks.map((related) => (
                <IssueReferencePill key={related.id} issue={related} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenRelatedTaskCount}
                expanded={relatedTasksExpanded}
                onClick={() => setRelatedTasksExpanded((expanded) => !expanded)}
              />
            </div>
          </PropertyRow>
        ) : null}

        <ExternalObjectRows
          externalObjects={externalObjects}
          externalObjectsLoading={externalObjectsLoading}
          externalObjectsError={externalObjectsError}
          onRetryExternalObjects={onRetryExternalObjects}
        />
      </PropertySection>

      <PropertySection title="Execution">
        <PropertyPicker
          inline={inline}
          label="Reviewers"
          open={reviewersOpen}
          onOpenChange={(open) => { setReviewersOpen(open); if (!open) setReviewerSearch(""); }}
          triggerContent={reviewerTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-56"
        >
          {executionParticipantsContent(
            "review",
            reviewerValues,
            reviewerSearch,
            setReviewerSearch,
            () => updateExecutionPolicy([], approverValues),
          )}
        </PropertyPicker>
        {nextRunnableExecutionStage === "review" && reviewerValues.length > 0 ? runExecutionButton("review") : null}

        <PropertyPicker
          inline={inline}
          label="Approvers"
          open={approversOpen}
          onOpenChange={(open) => { setApproversOpen(open); if (!open) setApproverSearch(""); }}
          triggerContent={approverTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-56"
        >
          {executionParticipantsContent(
            "approval",
            approverValues,
            approverSearch,
            setApproverSearch,
            () => updateExecutionPolicy(reviewerValues, []),
          )}
        </PropertyPicker>
        {nextRunnableExecutionStage === "approval" && approverValues.length > 0 ? runExecutionButton("approval") : null}

        {currentExecutionLabel && (
          <PropertyRow label="Execution">
            <span className="text-sm truncate min-w-0" title={currentExecutionLabel}>{currentExecutionLabel}</span>
          </PropertyRow>
        )}

        {showScheduledRetryRow && scheduledRetryContent ? (
          <PropertyPicker
            inline={inline}
            label="Scheduled retry"
            open={scheduledRetryOpen}
            onOpenChange={setScheduledRetryOpen}
            triggerContent={scheduledRetryTrigger}
            triggerClassName="min-w-0 max-w-full"
            popoverClassName={cn("max-w-full", inline ? "w-full" : "w-80 sm:w-[32rem]")}
            extra={scheduledRetryAttemptBadge}
          >
            {scheduledRetryContent}
          </PropertyPicker>
        ) : null}

        <PropertyPicker
          inline={inline}
          label="Monitor"
          open={monitorOpen}
          onOpenChange={setMonitorOpen}
          triggerContent={monitorTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName={cn("max-w-full", inline ? "w-full" : "w-80 sm:w-[32rem]")}
          extra={monitorAttemptBadge}
        >
          {monitorContent}
        </PropertyPicker>

        {taskWatchdogsEnabled ? (
          <PropertyPicker
            inline={inline}
            label="Watchdog"
            open={watchdogOpen}
            onOpenChange={setWatchdogOpen}
            triggerContent={watchdogTrigger}
            triggerClassName="min-w-0 max-w-full"
            popoverClassName={cn("max-w-full", inline ? "w-full" : "w-80 sm:w-96")}
            extra={
              watchdogIssueRef ? (
                <Link
                  to={`/issues/${watchdogIssueRef.id}`}
                  className="inline-flex items-center justify-center h-5 w-5 rounded hover:bg-accent/50 transition-colors text-muted-foreground hover:text-foreground"
                  title="Open watchdog task"
                  aria-label="Open watchdog task"
                  onClick={(e) => e.stopPropagation()}
                >
                  <ArrowUpRight className="h-3 w-3" />
                </Link>
              ) : undefined
            }
          >
            {watchdogContent}
          </PropertyPicker>
        ) : null}
      </PropertySection>

      {hasWorkspaceRuntimeControls || issue.currentExecutionWorkspace?.branchName || issue.currentExecutionWorkspace?.cwd || issue.executionWorkspaceId ? (
        <PropertySection title="Workspace">
          {showWorkspaceDetailLink && issue.executionWorkspaceId && (
            <PropertyRow label="Workspace">
              <Link
                to={`/execution-workspaces/${issue.executionWorkspaceId}`}
                className="text-sm text-primary hover:underline inline-flex min-w-0 items-center gap-1.5"
              >
                <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                View workspace
                <ArrowUpRight className="h-3 w-3 shrink-0" />
              </Link>
            </PropertyRow>
          )}
          {hasWorkspaceRuntimeControls && (
            <PropertyRow label="Service">
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                <WorkspaceRuntimeQuickControls
                  sections={workspaceRuntimeSections}
                  isPending={controlWorkspaceRuntime.isPending}
                  pendingRequest={pendingWorkspaceRuntimeAction}
                  onAction={(request) => controlWorkspaceRuntime.mutate(request)}
                  square
                  align="start"
                  iconOnly
                />
                {runtimeActionMessage ? (
                  <span className="text-xs text-muted-foreground" role="status">{runtimeActionMessage}</span>
                ) : null}
                {runtimeActionErrorMessage ? (
                  <span className="text-xs text-destructive" role="alert">{runtimeActionErrorMessage}</span>
                ) : null}
              </div>
            </PropertyRow>
          )}
          {issue.currentExecutionWorkspace?.branchName && (
            <PropertyRow label="Branch">
              <TruncatedCopyable
                value={issue.currentExecutionWorkspace.branchName}
                icon={GitBranch}
              />
            </PropertyRow>
          )}
          {issue.currentExecutionWorkspace?.cwd && (
            <PropertyRow label="Folder">
              <TruncatedCopyable
                value={issue.currentExecutionWorkspace.cwd}
                icon={FolderOpen}
              />
            </PropertyRow>
          )}
        </PropertySection>
      ) : null}

      <PropertySection title="About">
        {originatingActor ? (
          <PropertyRow label="Originating">
            {originatingActor.kind === "agent" ? (
              <Link
                to={`/agents/${originatingActor.id}`}
                className="hover:underline"
              >
                <Identity
                  name={agentName(originatingActor.id) ?? originatingActor.id.slice(0, 8)}
                  size="sm"
                  shape="square"
                />
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <Identity
                  name={actualUserLabel(originatingActor.id) ?? originatingUserProfile?.label ?? "User"}
                  avatarUrl={originatingUserProfile?.image ?? null}
                  size="sm"
                />
                {originatingViaAgentName ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground">
                    via {originatingViaAgentName}
                  </span>
                ) : null}
              </span>
            )}
          </PropertyRow>
        ) : null}
        {issue.startedAt && (
          <PropertyRow label="Started">
            <span className="text-sm">{formatDateTime(issue.startedAt)}</span>
          </PropertyRow>
        )}
        {issue.completedAt && (
          <PropertyRow label="Completed">
            <span className="text-sm">{formatDateTime(issue.completedAt)}</span>
          </PropertyRow>
        )}
        <PropertyRow label="Created">
          <span className="text-sm">{formatDateTime(issue.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{timeAgo(issue.updatedAt)}</span>
        </PropertyRow>
        {issue.requestDepth > 0 && (
          <PropertyRow label="Depth">
            <span className="text-sm font-mono">{issue.requestDepth}</span>
          </PropertyRow>
        )}
      </PropertySection>
    </div>
  );
}
