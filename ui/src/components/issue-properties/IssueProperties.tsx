import { localizeUiError, describeUiError } from "@/lib/localized-ui-error";
import { t, useTranslation, Trans } from "@/i18n";
import { isLockedIssueStub } from "@/components/LockedIssueChip";
import { IssuePullRequestLinks } from "../IssuePullRequestLinks";
import { useIssueWorkProducts } from "../../hooks/useIssueWorkProducts";
import { getIssuePullRequests, pullRequestHref, pullRequestIdentity } from "../../lib/issue-pull-requests";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { AgentIdentity } from "@/components/AgentIdentity";
import { AgentAvatar } from "@/components/AgentAvatar";
import { normalizeLegacyRunnerProvider } from "@paperclipai/adapter-utils";
import { useCallback, useEffect, useMemo, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { PROPERTIES_PANE_HEADER_SLOT_ID } from "../PropertiesPanel";
import { issueStatusText } from "@/lib/status-colors";
import { copyTextToClipboard } from "@/lib/clipboard";
import { Link } from "@/lib/router";
import {
  deriveOriginatingActor,
  isArtifactReviewDocumentKey,
  type ExecutionWorkspace,
  type Issue,
  type IssueLabel,
} from "@paperclipai/shared";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { accessApi } from "../../api/access";
import { agentsApi } from "../../api/agents";
import { authApi } from "../../api/auth";
import { executionWorkspacesApi } from "../../api/execution-workspaces";
import { instanceSettingsApi } from "../../api/instanceSettings";
import { issuesApi } from "../../api/issues";
import { useIssuePlanDocument } from "@/hooks/useIssuePlanDocument";
import { useIssueDocuments } from "@/hooks/useIssueDocuments";
import { useStreamlinedUiEnabled } from "@/hooks/useStreamlinedUiEnabled";
import { selectArtifactAttachments } from "@/lib/issue-artifacts";
import { projectsApi } from "../../api/projects";
import { useCompany } from "../../context/CompanyContext";
import { useSidebar } from "../../context/SidebarContext";
import { queryKeys } from "../../lib/queryKeys";
import { ACCOUNT_BOUND_MODEL_DISCOVERY_QUERY_OPTIONS, nativeTaskModelCatalogOptions } from "../../lib/native-model-catalog";
import { buildCompanyUserInlineOptions, buildCompanyUserLabelMap, buildCompanyUserProfileMap, isAgentTaskTarget } from "../../lib/company-members";
import { ISSUE_OVERRIDE_ADAPTER_TYPES, type IssueModelLane } from "../../lib/issue-assignee-overrides";
import { useProjectOrder } from "../../hooks/useProjectOrder";
import {
  getRecentAssigneeIds,
  sortAgentsByRecency,
  trackRecentAssignee,
  trackRecentAssigneeUser,
} from "../../lib/recent-assignees";
import { getRecentProjectIds } from "../../lib/recent-projects";
import { orderItemsBySelectedAndRecent } from "../../lib/recent-selections";
import { formatAssigneeUserLabel, formatUserLabel } from "../../lib/assignees";
import { buildExecutionPolicy, stageParticipantValues } from "../../lib/issue-execution-policy";
import { useExecutionPolicy } from "../../hooks/useExecutionPolicy";
import {
  areAutomaticMonitorChecksPaused,
  canCheckIssueMonitorNow,
  formatMonitorAbsolute,
  formatMonitorAbsoluteFull,
  formatMonitorEta,
  formatMonitorEtaLabel,
  formatMonitorOffset,
  useMonitorCountdown,
} from "../../lib/issue-monitor";
import { extractProviderIdWithFallback } from "../../lib/model-utils";
import { formatRetryReason } from "../../lib/runRetryState";
import { useRetryNowMutation } from "../../hooks/useRetryNowMutation";
import { RetryErrorBand } from "../IssueScheduledRetryCard";
import { StatusIcon } from "../StatusIcon";
import { PriorityIcon } from "../PriorityIcon";
import { SHOW_TASK_PRIORITY_UI } from "../../lib/ui-flags";
import { Identity } from "../Identity";
import { ProjectTile } from "../ProjectTile";
import { IssueReferencePill } from "../IssueReferencePill";
import { formatDate, formatDateTime, cn, projectUrl } from "../../lib/utils";
import type { IssueExternalObjectGroup } from "../../hooks/useIssueExternalObjects";
import { timeAgo } from "../../lib/timeAgo";
import { invalidateInboxIssueQueries } from "../../lib/inboxArchiveCache";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { IssuePropertiesPlansTab } from "./IssuePropertiesPlansTab";
import { IssuePropertiesArtifactsTab } from "./IssuePropertiesArtifactsTab";
import { User, ArrowUpRight, Plus, X, GitBranch, FolderOpen, HardDrive, Check, Clock, RotateCcw, Loader2, CheckCircle2, ArchiveRestore, ChevronLeft } from "lucide-react";
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
import {
  buildWorkspaceSelectionUpdate,
  currentWorkspaceSelection,
} from "../../lib/issue-workspace-selection";
import {
  buildReusableExecutionWorkspaceOptionGroups,
  dedupeReusableExecutionWorkspaces,
  reusableWorkspaceOptionMatches,
} from "../../lib/reusable-execution-workspaces";
import { issueReviewPolicyBadge } from "../../lib/review-policy";
import { IssueCasesPanel } from "../IssueCasesPanel";
import { ExpandRelationListButton, RemovableIssueReferencePill } from "./relation-controls";
import { RoutineOriginRow } from "./routine-origin-row";
import { Badge } from "@/components/ui/badge";
import {
  TaskDetailReferencesPanel,
  TaskDetailSubtasksPanel,
  type TaskDetailRelationItem,
} from "../task-detail/TaskDetailRelationsPanel";

function splitMiddleTruncation(value: string): { prefix: string; suffix: string } | null {
  const splitAt = Math.max(value.lastIndexOf("/"), value.lastIndexOf("\\"));
  if (splitAt <= 0 || splitAt >= value.length - 1) return null;
  return {
    prefix: value.slice(0, splitAt + 1),
    suffix: value.slice(splitAt + 1),
  };
}

function TruncatedCopyable({ value, icon: Icon }: { value: string; icon: ComponentType<{ className?: string }> }) {
  useTranslation("task-components");
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(timerRef.current), []);
  const handleCopy = useCallback(async () => {
    try {
      await copyTextToClipboard(value);
      setCopied(true);
      clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch { /* noop */ }
  }, [value]);
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const middle = streamlinedUiEnabled ? splitMiddleTruncation(value) : null;

  return (
    <div className="flex items-center gap-1.5 min-w-0 flex-1" title={value}>
      <Icon className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
      <button
        type="button"
        className={cn(
          "cursor-pointer text-left font-mono text-sm transition-colors hover:text-foreground",
          streamlinedUiEnabled ? "min-w-0 flex-1" : "min-w-0 truncate",
        )}
        onClick={handleCopy}
        title={value}
        aria-label={t("task-components:copyToClipboard_95f5bf10", { value1: value })}
      >
        {!streamlinedUiEnabled ? value : middle ? (
          <span className="flex min-w-0" data-middle-truncate="true">
            <span className="min-w-0 truncate">{middle.prefix}</span>
            <span className="max-w-1/2 shrink-0 truncate">{middle.suffix}</span>
          </span>
        ) : (
          <span className="block truncate">{value}</span>
        )}
      </button>
      {copied && (
        <span className={cn("inline-flex items-center gap-1 text-xs shrink-0", issueStatusText.done)} role="status">
          <Check className="h-3 w-3 shrink-0" />{t("task-components:copied_8d525e5f")}</span>
      )}
    </div>
  );
}

interface IssuePropertiesProps {
  issue: Issue;
  childIssues?: Issue[];
  issueLinkState?: unknown;
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
  onCheckMonitorNow?: () => void;
  checkingMonitorNow?: boolean;
  documentDeepLink?: IssuePropertiesDocumentDeepLink | null;
  /** Render only the Properties body when a parent owns the side-panel tabs. */
  sidePanelContentOnly?: boolean;
}

export interface IssuePropertiesDocumentDeepLink {
  requestId: number;
  tab: "plans" | "artifacts" | "document";
  documentKey: string;
}

const ISSUE_BLOCKER_SEARCH_LIMIT = 50;
const ISSUE_PROPERTY_RELATION_PREVIEW_COUNT = 5;
const STREAMLINED_PANE_TAB_CLASS =
  "task-detail-pane-tab h-7 rounded-md text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring";

type IssuePaneTab = "properties" | "subtasks" | "references" | "plans" | "artifacts";

interface IssuePaneTabDescriptor {
  value: IssuePaneTab;
  label: string;
  count?: number;
  closable: boolean;
}

export function IssueProperties({
  issue,
  childIssues = [],
  issueLinkState,
  onAddSubIssue,
  onUpdate,
  inline,
  hasActiveRun = false,
  externalObjects,
  externalObjectsLoading,
  externalObjectsError,
  onRetryExternalObjects,
  onCheckMonitorNow,
  checkingMonitorNow = false,
  documentDeepLink,
  sidePanelContentOnly = false,
}: IssuePropertiesProps) {
  useTranslation("task-components");
  const policyResult = useExecutionPolicy(issue.executionPolicy);
  const policyAvailable = policyResult.success;
  const executionPolicy = policyResult.success ? policyResult.data : null;
  const { selectedCompanyId } = useCompany();
  const { isMobile } = useSidebar();
  const queryClient = useQueryClient();
  const companyId = issue.companyId ?? selectedCompanyId;
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
  });
  // Managed-sandbox-only policy: the workspace folder is a host filesystem
  // path, so the Folder row disappears. The Branch row above it stays. The gate
  // fails closed whenever the policy is unknown — in flight and also on a failed
  // read — because an unresolved policy reads as "not managed" and would show
  // the folder the policy exists to hide.
  const hideHostPaths =
    experimentalSettings === undefined || experimentalSettings.enableManagedSandboxOnly === true;
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  // Classic Task Interface: gate the Properties | Plans | Artifacts tab shell.
  // Flag ON renders the legacy stacked sections verbatim (no Tabs wrapper);
  // flag OFF — including while settings load — renders the chat-style tab
  // shell. This pane is always task-scoped, so the flag alone is a sufficient
  // gate.
  // Classic Task Interface alone controls the production tabbed-vs-stacked
  // boundary. Streamlined UI layers new relationship tabs and visual treatment
  // onto master's tabbed task-chat pane without changing that boundary.
  const taskChatShellEnabled = experimentalSettings?.enableClassicTaskInterface !== true;
  const streamlinedPropertiesEnabled = streamlinedUiEnabled && taskChatShellEnabled;
  // When hosted by the resizable PropertiesPanel, the tab strip portals into
  // the pane's header bar (left of the window controls). The slot only exists
  // once the panel has committed, hence the effect; inline hosts (mobile sheet)
  // keep the tab strip in place.
  const [paneHeaderSlot, setPaneHeaderSlot] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (!taskChatShellEnabled || inline) {
      setPaneHeaderSlot(null);
      return;
    }
    setPaneHeaderSlot(document.getElementById(PROPERTIES_PANE_HEADER_SLOT_ID));
  }, [taskChatShellEnabled, inline]);
  // A Plan tab represents materialized plan content, not merely planning mode.
  // Same query keys as the tab bodies, so these share their cached fetches.
  const { data: paneTabPlanDocument } = useIssuePlanDocument(
    taskChatShellEnabled ? issue.id : null,
  );
  const { data: paneTabAcceptedPlans } = useQuery({
    queryKey: queryKeys.issues.acceptedPlanDecompositions(issue.id),
    queryFn: () => issuesApi.listAcceptedPlanDecompositions(issue.id),
    enabled: taskChatShellEnabled,
  });
  const { data: paneTabAttachments } = useQuery({
    queryKey: queryKeys.issues.attachments(issue.id),
    queryFn: () => issuesApi.listAttachments(issue.id),
    enabled: taskChatShellEnabled,
  });
  const { data: paneTabWorkProducts, isError: workProductsError, refetch: refetchWorkProducts } = useIssueWorkProducts(issue.id);
  const pullRequests = useMemo(() => getIssuePullRequests(paneTabWorkProducts), [paneTabWorkProducts]);
  const remainingExternalObjects = useMemo(() => {
    const identities = new Set(pullRequests.map((product) => pullRequestIdentity(pullRequestHref(product))).filter(Boolean));
    return externalObjects?.filter((entry) => !identities.has(pullRequestIdentity(entry.pill.url)));
  }, [externalObjects, pullRequests]);
  const { data: paneTabDocuments } = useIssueDocuments(taskChatShellEnabled ? issue.id : null);
  // Proxy `artifact-review-*` documents surface only through their Work
  // product row, so they must not summon the Plan or Documents surfaces.
  const paneTabStandaloneDocuments = (paneTabDocuments ?? []).filter(
    (doc) => !isArtifactReviewDocumentKey(doc.key),
  );
  const hasPlanTab =
    Boolean(paneTabPlanDocument)
    || (paneTabAcceptedPlans?.length ?? 0) > 0
    || paneTabStandaloneDocuments.length > 0;
  // Artifacts covers the same three sources the tab body composes: work
  // products, documents (redundant with the Plan tab, intentionally), and
  // attachments from agents and people.
  const hasArtifactsTab =
    (paneTabWorkProducts?.length ?? 0) > 0
    || paneTabStandaloneDocuments.length > 0
    || selectArtifactAttachments(paneTabAttachments, paneTabWorkProducts).length > 0;
  const [paneTab, setPaneTab] = useState<IssuePaneTab>("properties");
  const [closedPaneTabs, setClosedPaneTabs] = useState<Set<IssuePaneTab>>(() => new Set());
  // Once a plan document exists, surface it: switch the pane to the Plan tab so
  // the write-up is exposed alongside the plan-approval card, instead of leaving
  // the user on Properties. Only auto-switch until the user picks a tab by hand —
  // after that their choice wins. Ref-guarded so it fires once per mount.
  const paneTabUserChosenRef = useRef(false);
  const handlePaneTabChange = useCallback((value: string) => {
    paneTabUserChosenRef.current = true;
    setPaneTab(value as IssuePaneTab);
  }, []);
  useEffect(() => {
    setClosedPaneTabs(new Set());
  }, [issue.id]);
  useEffect(() => {
    if (hasPlanTab && !paneTabUserChosenRef.current) {
      setPaneTab("plans");
    }
  }, [hasPlanTab]);
  useEffect(() => {
    if (!documentDeepLink) return;
    const targetTab = documentDeepLink.tab;
    if (targetTab === "document") return;
    paneTabUserChosenRef.current = true;
    setPaneTab(targetTab);
    setClosedPaneTabs((current) => {
      if (!current.has(targetTab)) return current;
      const next = new Set(current);
      next.delete(targetTab);
      return next;
    });
  }, [documentDeepLink]);
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
  const [workspacePickerOpen, setWorkspacePickerOpen] = useState(false);
  const [workspacePickerStep, setWorkspacePickerStep] = useState<"mode" | "reuse">("mode");
  const [workspaceSearch, setWorkspaceSearch] = useState("");
  const [blockedByOpen, setBlockedByOpen] = useState(false);
  const [blockedBySearch, setBlockedBySearch] = useState("");
  const [blockedByExpanded, setBlockedByExpanded] = useState(false);
  const [blockingExpanded, setBlockingExpanded] = useState(false);
  const [subTasksExpanded, setSubTasksExpanded] = useState(false);
  const [subtasksOpen, setSubtasksOpen] = useState(false);
  const [relatedTasksExpanded, setRelatedTasksExpanded] = useState(false);
  const [parentOpen, setParentOpen] = useState(false);
  const [parentSearch, setParentSearch] = useState("");
  const [reviewersOpen, setReviewersOpen] = useState(false);
  const [reviewerSearch, setReviewerSearch] = useState("");
  const [approversOpen, setApproversOpen] = useState(false);
  const [approverSearch, setApproverSearch] = useState("");
  const [monitorOpen, setMonitorOpen] = useState(false);
  const [monitorDetailsOpen, setMonitorDetailsOpen] = useState(false);
  const [scheduledRetryOpen, setScheduledRetryOpen] = useState(false);
  const [labelsOpen, setLabelsOpen] = useState(false);
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [labelSearch, setLabelSearch] = useState("");
  const [newLabelName, setNewLabelName] = useState("");
  // token-extraction: allowlisted — color-picker seed state, persisted into label-create payload; a var() string would break that payload.
  const [newLabelColor, setNewLabelColor] = useState("#6366f1");
  const [monitorAtInput, setMonitorAtInput] = useState(() => toDateTimeLocalValue(executionPolicy?.monitor?.nextCheckAt));
  const [monitorNotesInput, setMonitorNotesInput] = useState(executionPolicy?.monitor?.notes ?? "");
  const [monitorServiceInput, setMonitorServiceInput] = useState(executionPolicy?.monitor?.serviceName ?? "");
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);
  const [runtimeActionErrorMessage, setRuntimeActionErrorMessage] = useState<string | null>(null);
  const [unarchiveErrorMessage, setUnarchiveErrorMessage] = useState<string | null>(null);
  const [watchdogOpen, setWatchdogOpen] = useState(false);
  const [watchdogAgentInput, setWatchdogAgentInput] = useState(issue.watchdog?.watchdogAgentId ?? "");
  const [watchdogInstructionsInput, setWatchdogInstructionsInput] = useState(issue.watchdog?.instructions ?? "");
  const normalizedBlockedBySearch = blockedBySearch.trim();
  const normalizedParentSearch = parentSearch.trim();

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
    queryKey: queryKeys.projects.list(companyId!, { includeArchived: true }),
    queryFn: () => projectsApi.list(companyId!, { includeArchived: true }),
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

  const { data: searchedParentIssues, isFetching: isFetchingSearchedParentIssues } = useQuery({
    queryKey: companyId
      ? queryKeys.issues.search(companyId, normalizedParentSearch, undefined, ISSUE_BLOCKER_SEARCH_LIMIT)
      : ["issues", "blocker-search", normalizedParentSearch, ISSUE_BLOCKER_SEARCH_LIMIT],
    queryFn: () => issuesApi.list(companyId!, {
      q: normalizedParentSearch,
      limit: ISSUE_BLOCKER_SEARCH_LIMIT,
    }),
    enabled: !!companyId && parentOpen && normalizedParentSearch.length > 0,
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

  const unarchiveFromInbox = useMutation({
    mutationFn: () => issuesApi.unarchiveFromInbox(issue.id),
    onMutate: () => {
      setUnarchiveErrorMessage(null);
    },
    onSuccess: () => {
      setUnarchiveErrorMessage(null);
      queryClient.setQueryData<Issue>(queryKeys.issues.detail(issue.id), (current) =>
        current ? { ...current, archivedAt: null, archivedByActorType: null, archivedByAgentId: null, archivedByRunId: null } : current,
      );
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      if (companyId) invalidateInboxIssueQueries(queryClient, companyId);
    },
    onError: (error) => {
      setUnarchiveErrorMessage(error instanceof Error && error.message.trim().length > 0
        ? error.message
        : "Failed to unarchive this issue. Please try again.");
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
    if (!id) return id?.slice(0, 8) ?? t("final-components-b:issue-properties.IssueProperties.None_dc937b");
    const project = orderedProjects.find((p) => p.id === id);
    return project?.name ?? id.slice(0, 8);
  };
  const currentProject = issue.projectId
    ? orderedProjects.find((project) => project.id === issue.projectId) ?? null
    : null;
  const issueProject = issue.project ?? currentProject;
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const workspacePickerEligible = workspaceIsolationControlsVisible && experimentalSettings?.enableIsolatedWorkspaces === true
    && Boolean(issueProject?.executionWorkspacePolicy?.enabled);
  const {
    data: reusableExecutionWorkspaces,
    isLoading: reusableExecutionWorkspacesLoading,
    isError: reusableExecutionWorkspacesError,
  } = useQuery({
    queryKey: queryKeys.executionWorkspaces.list(companyId!, {
      projectId: issue.projectId ?? undefined,
      projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
      reuseEligible: true,
    }),
    queryFn: () => executionWorkspacesApi.list(companyId!, {
      projectId: issue.projectId ?? undefined,
      projectWorkspaceId: issue.projectWorkspaceId ?? undefined,
      reuseEligible: true,
    }),
    enabled: Boolean(companyId) && Boolean(issue.projectId) && workspacePickerEligible && workspacePickerOpen,
  });
  const effectiveWorkspaceSelection = currentWorkspaceSelection(issue, issueProject);
  const hasWorkspaceOverride = issue.executionWorkspacePreference != null
    || issue.executionWorkspaceSettings != null;
  const activeWorkspacePickerMode = effectiveWorkspaceSelection === "reuse_existing"
    ? "reuse"
    : !hasWorkspaceOverride
      ? "default"
      : effectiveWorkspaceSelection === "isolated_workspace"
        ? "isolated"
        : "default";
  const reusableWorkspaceOptions = useMemo(
    () => buildReusableExecutionWorkspaceOptionGroups(
      dedupeReusableExecutionWorkspaces(reusableExecutionWorkspaces ?? []),
    ).map((group) => ({
      ...group,
      options: group.options.filter((option) => reusableWorkspaceOptionMatches(option, workspaceSearch)),
    })).filter((group) => group.options.length > 0),
    [reusableExecutionWorkspaces, workspaceSearch],
  );
  const boundWorkspace = (reusableExecutionWorkspaces ?? []).find(
    (workspace) => workspace.id === issue.executionWorkspaceId,
  ) ?? issue.currentExecutionWorkspace ?? null;
  const workspaceTriggerLabel = activeWorkspacePickerMode === "isolated"
    ? t("task-components:newIsolatedWorkspace_0c67029f")
    : activeWorkspacePickerMode === "reuse"
      ? boundWorkspace?.name ?? t("task-components:reuseExistingWorkspace_c84ba2b6")
      : t("task-components:default_21b111cb");
  const workspaceTriggerTitle = activeWorkspacePickerMode === "reuse"
    ? boundWorkspace?.branchName ?? undefined
    : undefined;
  const closeWorkspacePicker = () => {
    setWorkspacePickerOpen(false);
    setWorkspacePickerStep("mode");
    setWorkspaceSearch("");
  };
  const saveWorkspaceSelection = (
    selection: null | "isolated_workspace" | "reuse_existing",
    workspace?: ExecutionWorkspace,
  ) => {
    const update = buildWorkspaceSelectionUpdate(selection, workspace?.id, workspace?.mode);
    if (!update) return;
    onUpdate(update);
    closeWorkspacePicker();
  };
  const issueUsesMainWorkspace = useMemo(
    () => isMainIssueWorkspace({ issue, project: issueProject }),
    [issue, issueProject],
  );
  const showWorkspaceDetailLink = Boolean(issue.executionWorkspaceId && issue.currentExecutionWorkspace?.id === issue.executionWorkspaceId) && !issueUsesMainWorkspace
    && experimentalSettings?.enableIsolatedWorkspaces === true;
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
      if (!workspaceId) throw localizeUiError(new Error("This task is not attached to a workspace."), { key: "final-components-b:error.This_task_is_not_attached_to_a_workspace_391e13" });
      return executionWorkspacesApi.controlRuntimeCommands(workspaceId, request.action, request);
    },
    onSuccess: (result, request) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(result.workspace.id), result.workspace);
      void queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(issue.id) });
      if (result.workspace.projectId) void queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
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
  const panelReferencedTasks = useMemo<TaskDetailRelationItem[]>(() => {
    const outbound = issue.relatedWork?.outbound.map(({ issue: referenced }) => ({
      id: referenced.id,
      identifier: referenced.identifier,
      title: referenced.title,
      status: referenced.status,
    })) ?? [];
    if (outbound.length > 0) return outbound;
    return referencedIssueIdentifiers.map((identifier) => ({
      id: identifier,
      identifier,
      title: identifier,
    }));
  }, [issue.relatedWork?.outbound, referencedIssueIdentifiers]);
  const panelMentionedInTasks = useMemo<TaskDetailRelationItem[]>(
    () => issue.relatedWork?.inbound.map(({ issue: referenced }) => ({
      id: referenced.id,
      identifier: referenced.identifier,
      title: referenced.title,
      status: referenced.status,
    })) ?? [],
    [issue.relatedWork?.inbound],
  );
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
  const nativeCatalog = nativeTaskModelCatalogOptions(assignee);
  const assigneeAdapterType = assignee?.adapterType ?? null;
  const assigneeAdapterOverrides = issue.assigneeAdapterOverrides ?? null;
  const showAssigneeAdapterOptions = assigneeAdapterOverrides !== null;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && (ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType) || nativeCatalog),
  );
  const assigneeOverrideLane = overrideLane(assigneeAdapterOverrides);
  const assigneeOverrideAdapterConfig = asRecord(assigneeAdapterOverrides?.adapterConfig);
  const assigneeOverrideModel =
    typeof assigneeOverrideAdapterConfig.model === "string" ? assigneeOverrideAdapterConfig.model : "";
  const assigneePrimaryAdapterConfig = asRecord(assignee?.adapterConfig);
  const assigneePrimaryModel =
    typeof assigneePrimaryAdapterConfig.model === "string" ? assigneePrimaryAdapterConfig.model : "";
  const effectiveAssigneeModel = assigneeOverrideModel || assigneePrimaryModel;
  const assigneeOverrideThinkingEffort = thinkingEffortValueFor(
    assigneeAdapterType,
    assigneeOverrideAdapterConfig,
  );
  const assigneeOverrideChrome = assigneeAdapterType === "claude_local"
    && assigneeOverrideAdapterConfig.chrome === true;
  const catalogProvider = assigneeAdapterType === "paperclip_runner" ? String(normalizeLegacyRunnerProvider(assigneePrimaryAdapterConfig).provider ?? "codex") : undefined;
  const catalogAcpxAgent = catalogProvider === "acpx" ? String(assigneePrimaryAdapterConfig.acpxAgent ?? "claude") : undefined;
  const catalogEnvironmentId = nativeCatalog ? assignee?.defaultEnvironmentId ?? null : null;
  const nativeCatalogScope = JSON.stringify(nativeCatalog ?? null);
  const requestNativeModels = Boolean(nativeCatalog && assigneeOptionsOpen && showAssigneeAdapterOptions && supportsAssigneeOverrides);
  const { data: assigneeAdapterModels, refetch: refreshAssigneeModels } = useQuery({
    queryKey:
      companyId && assigneeAdapterType
        ? [...queryKeys.agents.adapterModels(companyId, assigneeAdapterType, catalogEnvironmentId, catalogProvider), catalogAcpxAgent ?? null, nativeCatalog ?? null]
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(companyId!, assigneeAdapterType!, {
      provider: catalogProvider,
      ...(catalogAcpxAgent ? { acpxAgent: catalogAcpxAgent } : {}),
      ...(nativeCatalog ? { environmentId: catalogEnvironmentId, ...nativeCatalog } : {}),
    }),
    ...(nativeCatalog ? ACCOUNT_BOUND_MODEL_DISCOVERY_QUERY_OPTIONS : {}),
    enabled: Boolean(companyId) && showAssigneeAdapterOptions && supportsAssigneeOverrides && (!nativeCatalog || requestNativeModels),
  });
  useEffect(() => {
    if (requestNativeModels) void refreshAssigneeModels();
  }, [requestNativeModels, nativeCatalogScope, catalogEnvironmentId, companyId, refreshAssigneeModels]);
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
  const updateAssigneeOverrideModel = (nextModel: string) => {
    const nextConfig: Record<string, unknown> = {
      ...assigneeOverrideAdapterConfig,
      model: nextModel || undefined,
    };
    if (
      assigneeAdapterType === "codex_local"
      && assigneeOverrideThinkingEffort
      && !thinkingEffortOptionsFor(assigneeAdapterType, nextModel || assigneePrimaryModel).some(
        (option) => option.value === assigneeOverrideThinkingEffort,
      )
    ) {
      delete nextConfig.modelReasoningEffort;
      delete nextConfig.reasoningEffort;
      delete nextConfig.effort;
    }
    updateAssigneeAdapterOverrides(buildAssigneeOverrideWithConfig(nextConfig));
  };
  const setAssigneeOverrideLane = (lane: IssueModelLane) => {
    if (lane === "primary") {
      updateAssigneeAdapterOverrides(null);
      return;
    }
    updateAssigneeAdapterOverrides(buildAssigneeOverrideWithConfig(assigneeOverrideAdapterConfig) ?? { adapterConfig: {} });
  };
  const assigneeOptionsTrigger = (() => {
    if (assigneeOverrideLane === "custom") {
      const details = [
        assigneeOverrideModel,
        assigneeOverrideThinkingEffort,
        assigneeOverrideChrome ? "Chrome" : "",
      ].filter(Boolean);
      const summary = details.length > 0 ? t("final-components-b:Override_details_ed1b9c", { details: details.join(" · ") }) : t("final-components-b:issue-properties.IssueProperties.Override_adapter_options_332c4f");
      return (
        <span
          className="min-w-0 truncate text-sm"
          title={t("task-components:taskLevelModelOverrideReplacesTheAgent_a80572fa", { value1: details.length > 0 ? ` (${details.join(" · ")})` : "" })}
        >
          {summary}
        </span>
      );
    }
    return <span className="text-sm text-muted-foreground">{t("task-components:primaryModel_51cbaf4c")}</span>;
  })();
  const assigneeOptionsContent = supportsAssigneeOverrides ? (
    <div className="w-full space-y-3 p-2">
      <div className="space-y-1.5">
        <div className="text-xs text-muted-foreground">{t("task-components:modelLane_7cd1d36f")}</div>
        <div className="flex w-full overflow-hidden rounded-md border border-border" role="radiogroup" aria-label={t("task-components:modelLane_7cd1d36f")}>
          {(["primary", "custom"] as const).map((lane) => (
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
              {lane === "primary" ? t("task-components:primary_efe10c80") : t("task-components:override_43bc0f5f")}
            </button>
          ))}
        </div>
        {assigneeOverrideLane === "custom" ? (
          <p className="text-xs text-muted-foreground">{t("task-components:taskLevelModelOverrideReplacesTheAgent_fd6678a2")}</p>
        ) : null}
      </div>
      {assigneeOverrideLane === "custom" ? (
        <>
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">{t("task-components:model_5e2c614c")}</div>
            <InlineEntitySelector
              value={assigneeOverrideModel}
              options={modelOverrideOptions}
              placeholder={t("task-components:defaultModel_3840d9d2")}
              disablePortal
              noneLabel={t("final-components-b:issue-properties.IssueProperties.Default_model_3840d9")}
              searchPlaceholder={t("task-components:searchModels_37b90680")}
              emptyMessage={t("task-components:noModelsFound_339e5fcd")}
              onChange={updateAssigneeOverrideModel}
            />
          </div>
          <div className="space-y-1.5">
            <div className="text-xs text-muted-foreground">{t("task-components:thinkingEffort_264c28cb")}</div>
            <div className="flex items-center gap-1.5 flex-wrap">
              {thinkingEffortOptionsFor(assigneeAdapterType, effectiveAssigneeModel).map((option) => (
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
              <div className="text-xs text-muted-foreground">{t("task-components:enableChromeChrome_df1c9d67")}</div>
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
          ? t("task-components:thisAssigneeSAdapterDoesNotExpose_8b4cf55a")
          : t("task-components:selectACompatibleAssigneeAgentToEdit_747f189d")}
      </p>
      <button
        type="button"
        className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
        onClick={() => updateAssigneeAdapterOverrides(null)}
      >{t("task-components:clearAdapterOptions_9a262cb3")}</button>
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
      agentMap: new Map((agents ?? []).map((agent) => [agent.id, agent])),
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
    if (!policyAvailable) return;
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
      return userLabel(value.slice("user:".length)) ?? t("final-components-b:issue-properties.IssueProperties.User_b512d9");
    }
    return value;
  };
  const reviewerLabel = reviewerValues.map((value) => executionParticipantLabel(value)).join(", ");
  const approverLabel = approverValues.map((value) => executionParticipantLabel(value)).join(", ");
  const reviewerTrigger = reviewerValues.length > 0
    ? <span className="text-sm truncate min-w-0" title={reviewerLabel}>{reviewerLabel}</span>
    : <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>;
  const approverTrigger = approverValues.length > 0
    ? <span className="text-sm truncate min-w-0" title={approverLabel}>{approverLabel}</span>
    : <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>;
  // PAP-16506 P4: who may give the `in_review` verdict. Only an agent sets this,
  // and only the two opt-in constraints are worth a row — the default (`null` ≡
  // "anyone can approve") is what every issue already does, so it shows nothing.
  const reviewPolicyBadge = issueReviewPolicyBadge(issue.reviewPolicy);
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
        {stageType === "review" ? t("task-components:runReviewNow_32a0248a") : t("task-components:runApprovalNow_f574ab35")}
      </button>
    </PropertyRow>
  );
  const currentExecutionLabel = (() => {
    if (!issue.executionState?.currentStageType) return null;
    const stageLabel = issue.executionState.currentStageType === "review" ? t("task-components:review_aff0766a") : t("task-components:approval_147fb813");
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
    setMonitorAtInput(toDateTimeLocalValue(executionPolicy?.monitor?.nextCheckAt));
    setMonitorNotesInput(executionPolicy?.monitor?.notes ?? "");
    setMonitorServiceInput(executionPolicy?.monitor?.serviceName ?? "");
  }, [
    executionPolicy?.monitor?.nextCheckAt,
    executionPolicy?.monitor?.notes,
    executionPolicy?.monitor?.serviceName,
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
        return agent ? <AgentAvatar agent={agent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/> : null;
      })()}
      <span className="shrink-0 max-w-40 truncate">{agentName(issue.watchdog.watchdogAgentId)}</span>
      {issue.watchdog.instructions?.trim() ? (
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          · {issue.watchdog.instructions.trim()}
        </span>
      ) : null}
      {issue.watchdog.status === "disabled" ? (
        <span className="shrink-0 text-xs text-muted-foreground">{t("task-components:disabled_f2d421e5")}</span>
      ) : null}
    </span>
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
  );
  const labelsExtra = !streamlinedPropertiesEnabled && (issue.labelIds ?? []).length > 0 ? (
    <button
      type="button"
      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
      onClick={() => setLabelsOpen(true)}
      aria-label={t("task-components:addLabel_e3488b90")}
      title={t("task-components:addLabel_e3488b90")}
    >
      <Plus className="h-3 w-3" />{t("task-components:addLabel_e3488b90")}</button>
  ) : undefined;
  const watchdogContent = (
    <div className="space-y-3 p-2">
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-foreground">{t("task-components:watchdogAgent_c6f340c4")}</div>
        <InlineEntitySelector
          value={watchdogAgentInput}
          options={watchdogAgentOptions}
          placeholder={t("task-components:selectAgent_e9a702a9")}
          noneLabel={t("final-components-b:issue-properties.IssueProperties.No_watchdog_agent_3c2f72")}
          searchPlaceholder={t("final-components-b:issue-properties.IssueProperties.Search_agents_32f446")}
          emptyMessage={t("task-components:noAgentsFound_61666542")}
          onChange={setWatchdogAgentInput}
          renderTriggerValue={(option) => {
            if (!option) return <span className="text-muted-foreground">{t("task-components:selectAgent_e9a702a9")}</span>;
            const agent = (agents ?? []).find((candidate) => candidate.id === option.id);
            return (
              <>
                {agent ? <AgentAvatar agent={agent} size={16} className="h-3 w-3 shrink-0 text-muted-foreground"/> : null}
                <span className="truncate">{option.label}</span>
              </>
            );
          }}
          renderOption={(option) => {
            const agent = (agents ?? []).find((candidate) => candidate.id === option.id);
            return (
              <>
                {agent ? <AgentAvatar agent={agent} size={16} className="h-3 w-3 shrink-0 text-muted-foreground"/> : null}
                <span className="truncate">{option.label}</span>
              </>
            );
          }}
        />
      </div>
      <div className="space-y-1.5">
        <div className="text-xs font-medium text-foreground">{t("task-components:instructions_934652dc")}{" "}<span className="font-normal text-muted-foreground">{t("task-components:optional_0059798b")}</span>
        </div>
        <Textarea
          value={watchdogInstructionsInput}
          onChange={(event) => setWatchdogInstructionsInput(event.target.value)}
          placeholder={t("task-components:whatShouldTheWatchdogWatchForAnd_f3065c6b")}
          rows={4}
          className="text-xs"
        />
      </div>
      {watchdogIssueRef ? (
        <div className="text-xs text-muted-foreground">{t("task-components:watchdogTask_c9c37c8b")}{" "}
          <Link to={`/issues/${watchdogIssueRef.id}`} className="text-primary hover:underline">
            {watchdogIssueRef.identifier ?? t("task-components:viewTask_01444a2b")}
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
          {deleteWatchdog.isPending ? t("task-components:removing_d4b09919") : t("task-components:remove_c3812fc4")}
        </button>
        <Button
          type="button"
          size="sm"
          className="h-7 text-xs"
          disabled={!watchdogAgentInput || upsertWatchdog.isPending}
          onClick={saveWatchdog}
        >
          {upsertWatchdog.isPending ? t("task-components:saving_23e39291") : issue.watchdog ? t("task-components:update_c1c1009d") : t("task-components:setWatchdog_03d6a683")}
        </Button>
      </div>
    </div>
  );

  const updateMonitor = (nextMonitor: Issue["executionPolicy"] extends infer T
    ? T extends { monitor?: infer M | null } | null | undefined
      ? M | null
      : never
    : never) => {
    if (!policyAvailable) return;
    const basePolicy = buildExecutionPolicy({
      existingPolicy: issue.executionPolicy ?? null,
      reviewerValues,
      approverValues,
    });
    if (!basePolicy && !nextMonitor) {
      onUpdate({ executionPolicy: null });
      return;
    }
    const { monitor: _previousMonitor, ...policyWithoutMonitor } = basePolicy ?? {};
    onUpdate({
      executionPolicy: {
        ...policyWithoutMonitor,
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
  const monitorState = issue.executionState?.monitor ?? null;
  const monitorNextCheckAt = monitorState?.nextCheckAt ?? issue.monitorNextCheckAt ?? executionPolicy?.monitor?.nextCheckAt ?? null;
  const monitorAttemptCount = issue.monitorAttemptCount ?? monitorState?.attemptCount ?? 0;
  const monitorLastTriggeredAt = issue.monitorLastTriggeredAt ?? monitorState?.lastTriggeredAt ?? null;
  const monitorServiceName = executionPolicy?.monitor?.serviceName ?? monitorState?.serviceName ?? null;
  const monitorNotes = executionPolicy?.monitor?.notes ?? monitorState?.notes ?? null;
  const monitorPaused = areAutomaticMonitorChecksPaused(issue);
  const canCheckMonitorNow = canCheckIssueMonitorNow(issue, monitorServiceName);
  const monitorNow = useMonitorCountdown(monitorPaused ? null : monitorNextCheckAt);
  const monitorRelative = monitorNextCheckAt ? formatMonitorEta(monitorNextCheckAt, monitorNow) : null;
  const monitorIsDueNow = monitorRelative === "due now";
  const monitorIsOverdue = Boolean(monitorRelative?.startsWith("overdue by "));
  const monitorPrimary = monitorNextCheckAt
    ? monitorPaused ? t("final-components-b:issue-properties.IssueProperties.Automatic_checks_paused_03d978") : formatMonitorEtaLabel(monitorNextCheckAt, monitorNow)
    : monitorState?.status === "cleared"
      ? t("final-components-b:issue-properties.IssueProperties.Cleared_15f3a2")
      : t("final-components-b:issue-properties.IssueProperties.None_dc937b");
  const monitorSecondary = monitorNextCheckAt
    ? monitorPaused
      ? canCheckMonitorNow ? t("final-components-b:issue-properties.IssueProperties.Check_now_to_request_a_manual_check_bcf1ae") : t("final-components-b:issue-properties.IssueProperties.Resume_this_task_to_continue_checking_c6f59e")
      : monitorIsDueNow
      ? t("final-components-b:issue-properties.IssueProperties.checking_momentarily_801f78")
      : `${formatMonitorAbsolute(monitorNextCheckAt, {}, monitorNow)}${monitorIsOverdue ? t("final-components-b:issue-properties.IssueProperties.fires_on_next_tick_2528f8") : monitorAttemptCount > 0 ? t("final-components-b:Attempt_attempt_1b309e", { attempt: monitorAttemptCount }) : ""}`
    : monitorState?.status === "cleared"
      ? [
          monitorLastTriggeredAt ? `last checked ${timeAgo(monitorLastTriggeredAt)}` : null,
          monitorAttemptCount > 0 ? `after attempt ${monitorAttemptCount}` : null,
        ].filter(Boolean).join(" · ")
      : null;
  const monitorTrigger = (
    <TooltipProvider>
      <Tooltip open={monitorDetailsOpen} onOpenChange={setMonitorDetailsOpen}>
      <TooltipTrigger asChild>
        <span
          className="inline-flex min-w-0 items-start gap-1.5"
          data-testid="monitor-row-trigger"
          onClick={() => setMonitorDetailsOpen(false)}
        >
      {monitorNextCheckAt ? (
            <Clock className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden="true" />
      ) : null}
          <span className="flex min-w-0 flex-col items-start">
            <span className={cn("text-sm", monitorNextCheckAt ? "font-semibold text-foreground" : "text-muted-foreground")}>{monitorPrimary}</span>
            {monitorSecondary ? (
              <span className="text-xs text-muted-foreground">{monitorSecondary}</span>
            ) : null}
          </span>
        </span>
      </TooltipTrigger>
      {monitorNextCheckAt ? (
        <TooltipContent
          side="left"
          className="w-80 border border-border bg-popover p-0 text-popover-foreground shadow-md"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between border-b border-border px-4 py-3">
            <span className="text-sm font-semibold">{t("task-components:monitor_4c2e1df4")}</span>
            {monitorAttemptCount > 0 ? <span className="text-xs text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.issue-properties.IssueProperties.bc1605e5a630_0900e" values={{ monitorAttemptCount: monitorAttemptCount }} /></span> : null}
          </div>
          <div className="space-y-3 px-4 py-3 text-left">
            <div>
              <div className="text-xs text-muted-foreground">{t("task-components:nextCheck_9625086a")}</div>
              <div className="text-sm">{formatMonitorAbsoluteFull(monitorNextCheckAt)}</div>
              <div className="text-xs text-muted-foreground">{monitorPaused ? t("final-components-b:issue-properties.IssueProperties.Automatic_checks_paused_03d978") : monitorRelative}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("task-components:watching_fbc59405")}</div>
              <div className="text-sm">{monitorServiceName ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("task-components:notes_8a7525b1")}</div>
              <div className="whitespace-normal text-sm">{monitorNotes ?? "—"}</div>
            </div>
            <div>
              <div className="text-xs text-muted-foreground">{t("task-components:lastTriggered_4876b1e2")}</div>
              <div className="text-sm">{monitorLastTriggeredAt ? formatMonitorAbsoluteFull(monitorLastTriggeredAt) : t("task-components:notYetTriggered_bb0ba130")}</div>
            </div>
          </div>
          <div className="flex gap-2 border-t border-border px-4 py-3">
            {onCheckMonitorNow && canCheckMonitorNow ? (
              <Button type="button" size="sm" variant="outline" disabled={checkingMonitorNow} onClick={() => { setMonitorDetailsOpen(false); onCheckMonitorNow(); }}>
                {checkingMonitorNow ? t("task-components:checking_ec963ffc") : t("task-components:checkNow_2937cffb")}
              </Button>
            ) : null}
            <Button type="button" size="sm" variant="outline" onClick={() => { setMonitorDetailsOpen(false); setMonitorOpen(true); }}>{t("task-components:edit_464c4ffd")}</Button>
            <Button type="button" size="sm" variant="outline" onClick={() => { setMonitorDetailsOpen(false); clearMonitor(); }}>{t("task-components:clear_83b12c22")}</Button>
          </div>
        </TooltipContent>
      ) : null}
      </Tooltip>
    </TooltipProvider>
  );

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
    <span className="whitespace-nowrap shrink-0 text-xs text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.issue-properties.IssueProperties.bc1605e5a630_5d715" values={{ scheduledRetryAttempt: scheduledRetryAttempt }} /></span>
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
          {scheduledRetryIsContinuation ? t("task-components:scheduledContinuation_90d74172") : t("task-components:scheduledRetry_263ed103")}
        </span>
        {scheduledRetryAttempt !== null ? (
          <span className="text-xs text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.issue-properties.IssueProperties.bc1605e5a630_5d715" values={{ scheduledRetryAttempt: scheduledRetryAttempt }} /></span>
        ) : null}
      </div>
      <dl className="grid grid-cols-(--gtc-15) gap-y-1">
        {scheduledRetryReasonLabel ? (
          <>
            <dt className="text-muted-foreground">{t("task-components:reason_f81ab834")}</dt>
            <dd className="text-foreground">{scheduledRetryReasonLabel}</dd>
          </>
        ) : null}
        {scheduledRetryAbsolute ? (
          <>
            <dt className="text-muted-foreground">{t("task-components:nextAttempt_94158821")}</dt>
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
            <dt className="text-muted-foreground">{t("task-components:replacesRun_28efd336")}</dt>
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
            <dt className="text-muted-foreground">{t("task-components:agent_11b39c93")}</dt>
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
            <dt className="text-muted-foreground">{t("task-components:lastError_5488d837")}</dt>
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
              <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />{t("task-components:retrying_a16c8b1c")}</span>
          ) : scheduledRetryRetryNowSuccess ? (
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 className="h-3.5 w-3.5" aria-hidden="true" />
              {retryNow.data?.outcome === "already_promoted" ? t("task-components:alreadyPromoted_8a7ece83") : t("task-components:promoted_0cf04463")}
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />{t("task-components:retryNow_5148c3e2")}</span>
          )}
        </Button>
        <span className="text-right text-xs text-muted-foreground">
          {retryNow.isPending
            ? t("task-components:promotingScheduledRetry_ff49385c")
            : scheduledRetryRetryNowSuccess
              ? retryNow.data?.outcome === "already_promoted"
                ? t("task-components:alreadyPromotedRunStarting_53e3c8d4")
                : t("task-components:promotedRunStarting_6c8f599a")
              : retryNow.data?.outcome === "waiting" && retryNow.data.scheduledRetry?.runId === scheduledRetry.runId
                ? retryNow.data.message
                : scheduledRetryIsContinuation
                  ? t("task-components:pullsContinuationForwardImmediately_0e8e38b5")
                  : t("task-components:pullsRetryForwardImmediately_4730094a")}
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
          placeholder={t("task-components:whatShouldTheAgentReCheck_ade0821d")}
          value={monitorNotesInput}
          onChange={(e) => setMonitorNotesInput(e.target.value)}
        />
      </div>
      <div className="flex flex-col gap-2 md:flex-row">
        <input
          type="text"
          className="min-w-0 flex-1 rounded-md border border-border bg-transparent px-2 py-1 text-xs"
          placeholder={t("task-components:externalService_7ede008e")}
          value={monitorServiceInput}
          onChange={(e) => setMonitorServiceInput(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
            disabled={!monitorAtInput}
            onClick={saveMonitor}
          >{t("task-components:schedule_f4830a1d")}</button>
          {executionPolicy?.monitor ? (
            <button
              type="button"
              className="inline-flex items-center rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
              onClick={clearMonitor}
            >{t("task-components:clear_83b12c22")}</button>
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
    <div className="flex min-w-0 flex-col items-start gap-1">
      {selectedIssueLabels.slice(0, 3).map((label) => (
        <PropertyChip
          key={label.id}
          className="border-0"
          style={{
            backgroundColor: `${label.color}22`,
            color: label.color,
          }}
        >
          {label.name}
        </PropertyChip>
      ))}
      {selectedIssueLabels.length > 3 && (
        <Badge variant="outline" className="border-border text-muted-foreground"><Trans ns="final-components-b" i18nKey="numeric.issue-properties.IssueProperties.59f3302a07f5_25270" values={{ count: selectedIssueLabels.length - 3 }} /></Badge>
      )}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
  );
  const labelsContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder={t("task-components:searchLabels_8b2837c0")}
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
            placeholder={t("task-components:newLabel_2bda0a8b")}
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
          {createLabel.isPending ? t("task-components:creating_c79ed949") : t("task-components:createLabel_69b585c1")}
        </button>
      </div>
    </>
  );

  const assigneeTrigger = assignee ? (
    <AgentIdentity agent={assignee} size="sm" />
  ) : assigneeUserLabel ? (
    <>
      <User className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 truncate text-sm" title={assigneeUserLabel}>{assigneeUserLabel}</span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:unassigned_14d33bd0")}</span>
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
          label: t("task-components:assignToMe_9dd977a4"),
          searchText: userLabel(currentUserId) ?? "",
        }]
      : []),
    ...(issue.createdByUserId && issue.createdByUserId !== currentUserId
      ? [{
          kind: "user" as const,
          value: `user:${issue.createdByUserId}`,
          userId: issue.createdByUserId,
          label: creatorUserLabel ? t("final-components-b:Assign_to_userName_beb3a4", { userName: creatorUserLabel }) : t("final-components-b:issue-properties.IssueProperties.Assign_to_requester_448a74"),
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
            trackRecentAssignee(option.agent.id, companyId ?? undefined),
          );
        } else if (option.kind === "user") {
          selectAssignee({ assigneeAgentId: null, assigneeUserId: option.userId }, option.label, () =>
            trackRecentAssigneeUser(option.userId, companyId ?? undefined),
          );
        } else {
          selectAssignee({ assigneeAgentId: null, assigneeUserId: null }, option.label);
        }
      }}
    >
      {option.kind === "agent" ? (
        <AgentAvatar agent={option.agent} size={16} className="shrink-0 h-3 w-3 text-muted-foreground"/>
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
        placeholder={t("task-components:searchAssignees_ad7ec86d")}
        value={assigneeSearch}
        onChange={(e) => setAssigneeSearch(e.target.value)}
        autoFocus={!inline}
      />
      <div className="max-h-56 overflow-y-auto overscroll-contain">
        {showNoAssigneeOption
          ? renderAssigneeOption({ kind: "none", value: "", label: t("task-components:noAssignee_d64d8cec"), searchText: "" })
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
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:noMatches_d6572bd2")}</div>
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
        placeholder={t("task-components:search_9a453e6d", { value1: stageType === "review" ? "reviewers" : "approvers" })}
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
        ><Trans ns="task-components" i18nKey="sentence_c69b90c4d585" components={{ part1: <>{stageType === "review" ? t("task-components:reviewers_f49dd73f") : t("task-components:approvers_45522a36")}</> }} /></button>
        {currentUserId && (
          <button
            className={cn(
              "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
              values.includes(`user:${currentUserId}`) && "bg-accent",
            )}
            onClick={() => toggleExecutionParticipant(stageType, `user:${currentUserId}`)}
          >
            <User className="h-3 w-3 shrink-0 text-muted-foreground" />{t("task-components:assignToMe_9dd977a4")}</button>
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
            {creatorUserLabel ? creatorUserLabel : t("task-components:requester_b5687cf0")}
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
                <AgentAvatar agent={agent} size={16} className="shrink-0 h-3 w-3 text-muted-foreground"/>
                {agent.name}
              </button>
            );
          })}
      </div>
    </>
  );

  const projectTrigger = issue.projectId ? (
    <>
      <ProjectTile
        color={issueProject?.color ?? null}
        icon={issueProject?.icon ?? null}
        size="sm"
      />
      <span className="text-sm truncate min-w-0" title={projectName(issue.projectId)}>{projectName(issue.projectId)}</span>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
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
        placeholder={t("task-components:searchProjects_c59dd5a3")}
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
                onUpdate({ projectId: option.kind === "project" ? option.project.id : null });
                setProjectOpen(false);
              }}
            >
              {option.kind === "project" ? (
                <ProjectTile
                  color={option.project.color ?? null}
                  icon={option.project.icon ?? null}
                  size="xs"
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
  const blockedByTrigger = blockedByRelations.length > 0 ? (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {blockedByRelations.slice(0, 2).map((relation) => (
        <IssueReferencePill
          key={relation.id}
          issue={relation}
          onRemove={(id) => onUpdate({ blockedByIssueIds: blockedByIds.filter((candidate) => candidate !== id) })}
        />
      ))}
      {blockedByRelations.length > 2 ? (
        <Badge asChild variant="outline" className="border-border text-muted-foreground hover:bg-accent/50">
          <button type="button" onClick={() => setBlockedByOpen(true)}><Trans ns="final-components-b" i18nKey="numeric.issue-properties.IssueProperties.59f3302a07f5_597d1" values={{ count: blockedByRelations.length - 2 }} /></button>
        </Badge>
      ) : null}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
  );
  const subtasksTrigger = childIssues.length > 0 ? (
    <div className="flex min-w-0 flex-col items-start gap-1">
      {childIssues.slice(0, 2).map((child) => (
        <IssueReferencePill variant="property" key={child.id} issue={child} className="min-w-0 max-w-full" />
      ))}
      {childIssues.length > 2 ? (
        <Badge asChild variant="outline" className="border-border text-muted-foreground hover:bg-accent/50">
          <button type="button" onClick={() => setSubtasksOpen(true)}><Trans ns="final-components-b" i18nKey="numeric.issue-properties.IssueProperties.59f3302a07f5_151b6" values={{ count: childIssues.length - 2 }} /></button>
        </Badge>
      ) : null}
    </div>
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
  );
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
  const parentAncestor = issue.ancestors?.find((ancestor) => ancestor.id === issue.parentId);
  const parentIdentifier = parentAncestor?.identifier ?? currentParentIssue?.identifier;
  const parentTitle = parentAncestor?.title ?? currentParentIssue?.title ?? issue.parentId?.slice(0, 8);
  const parentTrigger = issue.parentId ? (
    <IssueReferencePill
      variant="property"
      issue={isLockedIssueStub(parentAncestor) ? parentAncestor : {
        id: issue.parentId,
        identifier: parentIdentifier ?? issue.parentId,
        title: parentTitle ?? t("task-components:parentTask_fb8d8591"),
        status: parentAncestor?.status ?? currentParentIssue?.status,
      }}
      className="min-w-0 max-w-full"
    />
  ) : (
    <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
  );
  const parentSearchActive = normalizedParentSearch.length > 0;
  // When the user types, search on the server. The default list caps at 500 rows
  // and sorts priority-first, so a medium-priority or low-priority match past that
  // cap never enters the client list. A server query with `q` still finds it.
  const parentSourceIssues = parentSearchActive ? searchedParentIssues : allIssues;
  const parentOptions = (parentSourceIssues ?? [])
    .filter((candidate) => candidate.id !== issue.id)
    .filter((candidate) => !descendantIssueIds.has(candidate.id))
    .sort((a, b) => {
      const aLabel = `${a.identifier ?? ""} ${a.title}`.trim();
      const bLabel = `${b.identifier ?? ""} ${b.title}`.trim();
      return aLabel.localeCompare(bLabel);
    });
  const parentOptionsLoading = parentOpen && (
    parentSearchActive ? isFetchingSearchedParentIssues : isFetchingIssuePickerIssues
  );
  const parentContent = (
    <>
      <input
        className="w-full px-2 py-1.5 text-xs bg-transparent outline-none border-b border-border mb-1 placeholder:text-muted-foreground/50"
        placeholder={t("task-components:searchTasks_c1af8370")}
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
        >{t("task-components:noParent_bfc4337c")}</button>
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
            <StatusIcon status={candidate.status} displayStatus={candidate.displayStatus} className="h-3 w-3" />
            <span className="truncate">
              {candidate.identifier ? `${candidate.identifier} ` : ""}
              {candidate.title}
            </span>
          </button>
        ))}
        {parentOptionsLoading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:searchingTasks_33bf3954")}</div>
        ) : parentOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:noMatchingTasks_ee92fb1d")}</div>
        ) : null}
      </div>
    </>
  );
  const blockerSearchActive = normalizedBlockedBySearch.length > 0;
  const blockerSourceIssues = blockerSearchActive
    ? searchedBlockedByIssues
    : streamlinedPropertiesEnabled
      ? [...(issue.blockedBy ?? []), ...(allIssues ?? [])]
      : allIssues;
  const blockerOptions = streamlinedPropertiesEnabled
    ? Array.from(
        new Map(
          (blockerSourceIssues ?? [])
            .filter((candidate) => candidate.id !== issue.id)
            .map((candidate) => [candidate.id, candidate]),
        ).values(),
      )
    : (blockerSourceIssues ?? []).filter((candidate) => candidate.id !== issue.id);
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
        placeholder={t("task-components:searchTasks_c1af8370")}
        value={blockedBySearch}
        onChange={(e) => setBlockedBySearch(e.target.value)}
        autoFocus={!inline}
        aria-label={t("task-components:searchTasksToAddAsBlockers_b075e6c5")}
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
        >{t("task-components:noBlockers_c93d3fab")}</button>
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
              <StatusIcon status={candidate.status} displayStatus={candidate.displayStatus} className="h-3 w-3" />
              <span className="truncate">
                {candidate.identifier ? `${candidate.identifier} ` : ""}
                {candidate.title}
              </span>
              {selected && <Check className="ml-auto h-3.5 w-3.5 shrink-0 text-foreground" aria-hidden="true" />}
            </button>
          );
        })}
        {blockerOptionsLoading ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:searchingTasks_33bf3954")}</div>
        ) : blockerOptions.length === 0 ? (
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:noMatchingTasks_ee92fb1d")}</div>
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
      <Plus className="h-3 w-3" />{t("task-components:addBlocker_61671f98")}</button>
  );
  const subtasksContent = (
    <>
      <div className="max-h-48 overflow-y-auto overscroll-contain">
        {childIssues.length > 0 ? childIssues.map((child) => (
          <Link
            key={child.id}
            to={`/issues/${child.identifier ?? child.id}`}
            state={issueLinkState}
            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-accent/50"
            onClick={() => setSubtasksOpen(false)}
          >
            <StatusIcon status={child.status} displayStatus={child.displayStatus} className="h-3 w-3" />
            <span className="min-w-0 truncate">
              {child.identifier ? `${child.identifier} ` : ""}
              {child.title}
            </span>
          </Link>
        )) : (
          <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:noSubtasksYet_17d17d5b")}</div>
        )}
      </div>
      {onAddSubIssue ? (
        <div className="mt-2 border-t border-border pt-2">
          <button
            type="button"
            className="flex w-full items-center justify-center gap-1.5 rounded border border-border px-2 py-1.5 text-xs hover:bg-accent/50"
            onClick={() => {
              setSubtasksOpen(false);
              onAddSubIssue();
            }}
          >
            <Plus className="h-3 w-3" />{t("task-components:addSubtask_65db0c29")}</button>
        </div>
      ) : null}
    </>
  );

  const propertiesBody = (
    <div className={cn(streamlinedPropertiesEnabled && "task-detail-properties pl-4")}>
      <PropertySection
        title={streamlinedPropertiesEnabled ? t("task-components:work_104ab921") : t("task-components:triage_4ffbef3c")}
        first
        streamlined={streamlinedPropertiesEnabled}
      >
        <PropertyRow label={t("task-components:status_920e413c")}>
          <StatusIcon
            status={issue.status} displayStatus={issue.displayStatus}
            externalConversationState={issue.externalConversationState}
            glyphContainerClassName="inline-flex size-6 shrink-0 items-center justify-center"
            blockerAttention={issue.blockerAttention}
            onChange={(status) => onUpdate({ status })}
            showLabel
          />
        </PropertyRow>

        {/* PAP-411: priority UI is hidden behind SHOW_TASK_PRIORITY_UI. Revive by flipping the flag. */}
        {SHOW_TASK_PRIORITY_UI && (
          <PropertyRow label={t("task-components:priority_d60dbba0")}>
            <PriorityIcon
              priority={issue.priority}
              onChange={(priority) => onUpdate({ priority })}
              showLabel
            />
          </PropertyRow>
        )}

        <PropertyPicker
          inline={inline}
          label={t("task-components:assignee_5e20d20e")}
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
            label={t("task-components:model_5e2c614c")}
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
          label={t("task-components:project_98595978")}
          open={projectOpen}
          onOpenChange={(open) => { setProjectOpen(open); if (!open) setProjectSearch(""); }}
          triggerContent={projectTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-fit min-w-(--sz-11rem)"
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

        <PropertyPicker
          inline={inline}
          label={t("task-components:labels_934b8899")}
          open={labelsOpen}
          onOpenChange={(open) => { setLabelsOpen(open); if (!open) setLabelSearch(""); }}
          triggerContent={labelsTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-64"
          extra={labelsExtra}
          stacked
        >
          {labelsContent}
        </PropertyPicker>
      </PropertySection>

      <PropertySection title={t("task-components:relationships_85752a46")} streamlined={streamlinedPropertiesEnabled}>
        <PropertyPicker
          inline={inline}
          label={t("task-components:parent_5f7953f7")}
          open={parentOpen}
          onOpenChange={(open) => {
            setParentOpen(open);
            if (!open) setParentSearch("");
          }}
          triggerContent={parentTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName="w-72"
          separateTrigger={!!issue.parentId}
        >
          {parentContent}
        </PropertyPicker>

        {issue.originKind === "routine_execution" && issue.originId ? (
          <RoutineOriginRow routineId={issue.originId} />
        ) : null}

        {streamlinedPropertiesEnabled ? (
          <PropertyPicker
            inline={inline}
            label={t("task-components:blockedBy_36931a94")}
            open={blockedByOpen}
            onOpenChange={(open) => {
              setBlockedByOpen(open);
              if (!open) setBlockedBySearch("");
            }}
            separateTrigger={blockedByRelations.length > 0}
            triggerContent={blockedByTrigger}
            triggerClassName="min-w-0 max-w-full"
            popoverClassName="w-72"
            stacked
          >
            {blockedByContent}
          </PropertyPicker>
        ) : inline ? (
          <div>
            <PropertyRow label={t("task-components:blockedBy_36931a94")} wrap>
              {visibleBlockedByRelations.map((relation) => (
                <RemovableIssueReferencePill
                  key={relation.id}
                  issue={relation}
                  onRemove={removeBlockedBy}
                  isMobile={isMobile}
                />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenBlockedByCount}
                expanded={blockedByExpanded}
                onClick={() => setBlockedByExpanded((expanded) => !expanded)}
              />
              {renderAddBlockedByButton(() => setBlockedByOpen((open) => !open))}
            </PropertyRow>
            {blockedByOpen ? (
              <div className="rounded-md border border-border bg-popover p-1 mb-2">
                {blockedByContent}
              </div>
            ) : null}
          </div>
        ) : (
          <PropertyRow label={t("task-components:blockedBy_36931a94")} wrap>
            {visibleBlockedByRelations.map((relation) => (
              <RemovableIssueReferencePill
                key={relation.id}
                issue={relation}
                onRemove={removeBlockedBy}
                isMobile={isMobile}
              />
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
              <PopoverTrigger asChild>{renderAddBlockedByButton()}</PopoverTrigger>
              <PopoverContent className="w-72 p-1" align="end" collisionPadding={16}>
                {blockedByContent}
              </PopoverContent>
            </Popover>
          </PropertyRow>
        )}

        <PropertyRow label={t("task-components:blocking_f778a331")} wrap>
          {blockingIssues.length > 0 ? (
            <div className="flex flex-col items-start gap-1.5">
              {visibleBlockingIssues.map((relation) => (
                <IssueReferencePill variant="property" key={relation.id} issue={relation} />
              ))}
              <ExpandRelationListButton
                hiddenCount={hiddenBlockingIssueCount}
                expanded={blockingExpanded}
                onClick={() => setBlockingExpanded((expanded) => !expanded)}
              />
            </div>
          ) : (
            <span className="text-sm text-muted-foreground">{t("task-components:none_dc937b59")}</span>
          )}
        </PropertyRow>

        {streamlinedPropertiesEnabled ? (
          <PropertyPicker
            inline={inline}
            label={t("task-components:subtasks_7eff0a19")}
            open={subtasksOpen}
            onOpenChange={setSubtasksOpen}
            separateTrigger={childIssues.length > 0}
            triggerContent={subtasksTrigger}
            triggerClassName="min-w-0 max-w-full"
            popoverClassName="w-72"
            stacked
          >
            {subtasksContent}
          </PropertyPicker>
        ) : !taskChatShellEnabled ? (
          <PropertyRow label={t("task-components:subTasks_ede4f888")} wrap>
            <div className="flex flex-col items-start gap-1.5">
              {visibleChildIssues.map((child) => (
                <IssueReferencePill key={child.id} issue={child} />
              ))}
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
                  <Plus className="h-3 w-3" />{t("task-components:addSubTask_d4a8efaa")}</button>
              ) : null}
            </div>
          </PropertyRow>
        ) : null}

        {(!streamlinedPropertiesEnabled || !taskChatShellEnabled) && relatedTasks.length > 0 ? (
          <PropertyRow label={streamlinedPropertiesEnabled ? t("task-components:referenced_e1ea8a5e") : t("task-components:relatedTasks_c5ded36c")} wrap>
            <div className="flex flex-col items-start gap-1.5">
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

        {pullRequests.length > 0 || workProductsError ? (
          <PropertyRow label={t("task-components:pullRequests_d9e3f260")} wrap>
            <div className="flex min-w-0 flex-col gap-2">
              <IssuePullRequestLinks products={pullRequests} externalObjects={externalObjects?.map((entry) => entry.pill)} />
              {workProductsError ? (
                <span className="text-xs text-muted-foreground">{t("task-components:couldnTLoadPullRequests_e2da62bd")}{" "}<button type="button" className="text-primary hover:underline" onClick={() => void refetchWorkProducts()}>{t("task-components:retry_942087cc")}</button>
                </span>
              ) : null}
            </div>
          </PropertyRow>
        ) : null}
        <ExternalObjectRows
          externalObjects={remainingExternalObjects}
          externalObjectsLoading={externalObjectsLoading}
          externalObjectsError={externalObjectsError}
          onRetryExternalObjects={onRetryExternalObjects}
        />
      </PropertySection>

      <PropertySection title={t("task-components:execution_a45cd4bd")} streamlined={streamlinedPropertiesEnabled}>
        {/* Read-only: agents set the policy, the board does not. */}
        {reviewPolicyBadge ? (
          <PropertyRow label={t("task-components:approvals_2bfc3471")}>
            <PropertyChip title={reviewPolicyBadge.description}>
              <reviewPolicyBadge.Icon className="shrink-0 text-muted-foreground" aria-hidden />
              <span className="min-w-0 truncate">{reviewPolicyBadge.label}</span>
            </PropertyChip>
          </PropertyRow>
        ) : null}

        {!policyAvailable ? (
          <PropertyRow label={t("task-components:executionPolicy_b9215cec")} wrap>
            <span role="status" className="text-sm text-muted-foreground">{t("task-components:executionPolicyUnavailableRefreshToTryAgain_f5e92904")}</span>
          </PropertyRow>
        ) : (<>
        <PropertyPicker
          inline={inline}
          label={t("task-components:reviewers_06499a30")}
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
          label={t("task-components:approvers_97ecaec1")}
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
        </>)}

        {currentExecutionLabel && (
          <PropertyRow label={t("task-components:execution_a45cd4bd")}>
            <span className="text-sm truncate min-w-0" title={currentExecutionLabel}>{currentExecutionLabel}</span>
          </PropertyRow>
        )}

        {showScheduledRetryRow && scheduledRetry?.scheduledRetryReason === "workspace_busy" ? (
          <PropertyRow label={t("task-components:workspace_87bb59ba")}>
            <span className="text-sm text-muted-foreground">{t("task-components:waitingForWorkspace_e682cb09")}</span>
          </PropertyRow>
        ) : showScheduledRetryRow && scheduledRetryContent ? (
          <PropertyPicker
            inline={inline}
            label={t("task-components:scheduledRetry_263ed103")}
            open={scheduledRetryOpen}
            onOpenChange={setScheduledRetryOpen}
            triggerContent={scheduledRetryTrigger}
            triggerClassName="min-w-0 max-w-full"
            popoverClassName={cn("max-w-full", inline ? "w-full" : "w-80 sm:w-(--sz-32rem)")}
            extra={scheduledRetryAttemptBadge}
          >
            {scheduledRetryContent}
          </PropertyPicker>
        ) : null}

        {policyAvailable ? (
        <PropertyPicker
          inline={inline}
          label={t("task-components:monitor_4c2e1df4")}
          open={monitorOpen}
          onOpenChange={setMonitorOpen}
          triggerContent={monitorTrigger}
          triggerClassName="min-w-0 max-w-full"
          popoverClassName={cn("max-w-full", inline ? "w-full" : "w-80 sm:w-(--sz-32rem)")}
        >
          {monitorContent}
        </PropertyPicker>
        ) : null}

        <PropertyPicker
          inline={inline}
          label={t("task-components:watchdog_da0ccfea")}
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
                title={t("task-components:openWatchdogTask_b396a984")}
                aria-label={t("task-components:openWatchdogTask_b396a984")}
                onClick={(e) => e.stopPropagation()}
              >
                <ArrowUpRight className="h-3 w-3" />
              </Link>
            ) : undefined
          }
        >
          {watchdogContent}
        </PropertyPicker>
      </PropertySection>

      {workspacePickerEligible || hasWorkspaceRuntimeControls || issue.currentExecutionWorkspace?.branchName || issue.currentExecutionWorkspace?.cwd || issue.executionWorkspaceId ? (
        <PropertySection title={t("task-components:workspace_87bb59ba")} streamlined={streamlinedPropertiesEnabled}>
          {workspacePickerEligible ? (
            <PropertyPicker
              inline={inline}
              label={t("task-components:execution_a45cd4bd")}
              open={workspacePickerOpen}
              onOpenChange={(open) => {
                setWorkspacePickerOpen(open);
                if (!open) {
                  setWorkspacePickerStep("mode");
                  setWorkspaceSearch("");
                }
              }}
              triggerContent={(
                <span className="truncate" title={workspaceTriggerTitle}>
                  {workspaceTriggerLabel}
                </span>
              )}
              triggerClassName="min-w-0 max-w-full"
              popoverClassName={cn("max-w-full", inline ? "w-full" : "w-72")}
            >
              {workspacePickerStep === "mode" ? (
                <>
                  <div className="space-y-0.5">
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                      onClick={() => saveWorkspaceSelection(null)}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{t("task-components:default_21b111cb")}</span>
                        <span className="block text-xs text-muted-foreground">{t("task-components:useTheProjectWorkspacePolicy_8bf3f9b7")}</span>
                      </span>
                      {activeWorkspacePickerMode === "default" ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                      onClick={() => saveWorkspaceSelection("isolated_workspace")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{t("task-components:newIsolatedWorkspace_0c67029f")}</span>
                        <span className="block text-xs text-muted-foreground">{t("task-components:createAFreshWorkspaceOnTheNext_b5e083cc")}</span>
                      </span>
                      {activeWorkspacePickerMode === "isolated" ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                    <button
                      type="button"
                      className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                      onClick={() => setWorkspacePickerStep("reuse")}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm">{t("task-components:reuseExistingWorkspace_9d80bee3")}</span>
                        <span className="block text-xs text-muted-foreground">{t("task-components:pickAWorkspaceToReuse_50fe55e7")}</span>
                      </span>
                      {activeWorkspacePickerMode === "reuse" ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                    </button>
                  </div>
                  <div className="mt-1 border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
                    {issue.executionWorkspaceId ? t("task-components:currentWorkspaceStaysActiveAppliesOnThe_84ea502a") : t("task-components:appliesOnTheNextRun_d6d33783")}
                  </div>
                </>
              ) : (
                <>
                  <div className="border-b border-border pb-1">
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded px-1 py-1 text-xs text-muted-foreground hover:bg-accent/50 hover:text-foreground"
                      onClick={() => setWorkspacePickerStep("mode")}
                      aria-label={t("task-components:backToWorkspaceOptions_bc31531c")}
                    >
                      <ChevronLeft className="h-3.5 w-3.5" />{t("task-components:workspaceMode_36e8bba4")}</button>
                    <input
                      className="block w-full bg-transparent px-2 py-1.5 text-xs outline-none placeholder:text-muted-foreground/50"
                      placeholder={t("task-components:searchWorkspaces_5c192a3e")}
                      value={workspaceSearch}
                      onChange={(event) => setWorkspaceSearch(event.target.value)}
                      autoFocus={!inline}
                      aria-label={t("task-components:searchReusableWorkspaces_cb34b5eb")}
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto overscroll-contain py-1">
                    {reusableExecutionWorkspacesLoading ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:loadingWorkspaces_3f9adb0f")}</div>
                    ) : reusableExecutionWorkspacesError ? (
                      <div className="px-2 py-2 text-xs text-destructive">{t("task-components:failedToLoadWorkspaces_c7033771")}</div>
                    ) : reusableWorkspaceOptions.length === 0 ? (
                      <div className="px-2 py-2 text-xs text-muted-foreground">{t("task-components:noMatchingWorkspaces_76be0ffe")}</div>
                    ) : reusableWorkspaceOptions.map((group) => (
                      <div key={group.id} className="py-1">
                        <div className="px-2 pb-1 text-xs font-medium text-muted-foreground">{group.label}</div>
                        {group.options.map((option) => (
                          <button
                            key={option.key}
                            type="button"
                            className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left hover:bg-accent/50"
                            onClick={() => saveWorkspaceSelection("reuse_existing", option.workspace)}
                          >
                            <span className="min-w-0 flex-1">
                              <span className="block truncate text-sm">{option.label}</span>
                              <span className="block truncate text-xs text-muted-foreground">{option.description}</span>
                            </span>
                            {issue.executionWorkspaceId === option.workspaceId ? <Check className="h-3.5 w-3.5 shrink-0" /> : null}
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                  <div className="border-t border-border px-2 py-1.5 text-xs text-muted-foreground">
                    {issue.executionWorkspaceId ? t("task-components:currentWorkspaceStaysActiveAppliesOnThe_84ea502a") : t("task-components:appliesOnTheNextRun_d6d33783")}
                  </div>
                </>
              )}
            </PropertyPicker>
          ) : null}
          {showWorkspaceDetailLink && issue.executionWorkspaceId && (
            <PropertyRow label={t("task-components:workspace_87bb59ba")}>
              <Link
                to={`/execution-workspaces/${issue.executionWorkspaceId}`}
                className="text-sm text-primary hover:underline inline-flex min-w-0 items-center gap-1.5"
              >
                <HardDrive className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />{t("task-components:viewWorkspace_ea77e961")}<ArrowUpRight className="h-3 w-3 shrink-0" />
              </Link>
            </PropertyRow>
          )}
          {hasWorkspaceRuntimeControls && (
            <PropertyRow label={t("task-components:service_d677190e")}>
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
            <PropertyRow label={t("task-components:branch_52656e81")}>
              <TruncatedCopyable
                value={issue.currentExecutionWorkspace.branchName}
                icon={GitBranch}
              />
            </PropertyRow>
          )}
          {issue.currentExecutionWorkspace?.cwd && !hideHostPaths && (
            <PropertyRow label={t("task-components:folder_74ccd433")}>
              <TruncatedCopyable
                value={issue.currentExecutionWorkspace.cwd}
                icon={FolderOpen}
              />
            </PropertyRow>
          )}
        </PropertySection>
      ) : null}

      <PropertySection title={t("task-components:about_4efca0d1")} streamlined={streamlinedPropertiesEnabled}>
        {originatingActor ? (
          <PropertyRow label={t("task-components:originating_28d9df90")}>
            {originatingActor.kind === "agent" ? (
              <Link
                to={`/agents/${originatingActor.id}`}
                className="hover:underline"
              >
                <AgentIdentity agent={agents?.find((agent) => agent.id === originatingActor.id) ?? { id: originatingActor.id, name: agentName(originatingActor.id) ?? "Agent" }} size="sm" />
              </Link>
            ) : (
              <span className="flex min-w-0 items-center gap-1.5">
                <Identity
                  name={actualUserLabel(originatingActor.id) ?? originatingUserProfile?.label ?? t("final-components-b:issue-properties.IssueProperties.User_b512d9")}
                  avatarUrl={originatingUserProfile?.image ?? null}
                  size="sm"
                />
                {originatingViaAgentName ? (
                  <span className="shrink-0 truncate text-xs text-muted-foreground"><Trans ns="task-components" i18nKey="sentence_9dcf0de02fbd" components={{ part1: <>{originatingViaAgentName}</> }} /></span>
                ) : null}
              </span>
            )}
          </PropertyRow>
        ) : null}
        {issue.startedAt && (
          <PropertyRow label={t("task-components:started_ecbc89cd")}>
            <span
              className={streamlinedPropertiesEnabled ? "min-w-0 truncate whitespace-nowrap text-sm" : "text-sm"}
              title={streamlinedPropertiesEnabled ? formatDateTime(issue.startedAt) : undefined}
            >{formatDateTime(issue.startedAt)}</span>
          </PropertyRow>
        )}
        {issue.completedAt && (
          <PropertyRow label={t("task-components:completed_22a970d2")}>
            <span
              className={streamlinedPropertiesEnabled ? "min-w-0 truncate whitespace-nowrap text-sm" : "text-sm"}
              title={streamlinedPropertiesEnabled ? formatDateTime(issue.completedAt) : undefined}
            >{formatDateTime(issue.completedAt)}</span>
          </PropertyRow>
        )}
        <PropertyRow label={t("task-components:created_d70b9e24")}>
          <span
            className={streamlinedPropertiesEnabled ? "min-w-0 truncate whitespace-nowrap text-sm" : "text-sm"}
            title={streamlinedPropertiesEnabled ? formatDateTime(issue.createdAt) : undefined}
          >{formatDateTime(issue.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={t("task-components:updated_3a5ecca1")}>
          <span
            className={streamlinedPropertiesEnabled ? "min-w-0 truncate whitespace-nowrap text-sm" : "text-sm"}
            title={streamlinedPropertiesEnabled ? timeAgo(issue.updatedAt) : undefined}
          >{timeAgo(issue.updatedAt)}</span>
        </PropertyRow>
        {issue.archivedAt && issue.archivedByActorType === "agent" && issue.archivedByAgentId ? (
          (() => {
            const archivedByAgent = (agents ?? []).find((candidate) => candidate.id === issue.archivedByAgentId);
            const archivedByName = agentName(issue.archivedByAgentId);
            return (
              <PropertyRow label={t("task-components:archived_bdb86505")}>
                <div className="flex min-w-0 max-w-full flex-col items-start gap-1">
                  {/* The row label already reads "Archived", so the value shows just
                      the attributing agent (icon + name) — this gives the name the
                      full ~164px value column at the real 320px pane width, where an
                      "Archived by …" prefix would clip even short names. The full
                      phrasing + timestamp live in the tooltip so any residual
                      truncation on genuinely long names is recoverable. */}
                  <span
                    className="flex min-w-0 max-w-full items-center gap-1.5 text-sm"
                    title={t("task-components:archivedBy_2e1acf44", { value1: archivedByName, value2: formatDateTime(issue.archivedAt) })}
                  >
                    {archivedByAgent
                      ? <AgentAvatar agent={archivedByAgent} size={16} className="h-3.5 w-3.5 shrink-0 text-muted-foreground"/>
                      : null}
                    <span className="min-w-0 truncate">
                      {archivedByName}
                    </span>
                  </span>
                  <div className="flex min-w-0 max-w-full items-center gap-2">
                    <span className="shrink-0 text-xs text-muted-foreground">{timeAgo(issue.archivedAt)}</span>
                    <button
                      type="button"
                      className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground disabled:opacity-50"
                      onClick={() => unarchiveFromInbox.mutate()}
                      disabled={unarchiveFromInbox.isPending}
                    >
                      <ArchiveRestore className="h-3 w-3" />
                      {unarchiveFromInbox.isPending ? t("task-components:unarchiving_80a70ba6") : t("task-components:unarchive_f565318d")}
                    </button>
                  </div>
                  {unarchiveErrorMessage ? (
                    <p className="text-xs text-destructive" role="alert">
                      {unarchiveErrorMessage}
                    </p>
                  ) : null}
                </div>
              </PropertyRow>
            );
          })()
        ) : null}
        {issue.requestDepth > 0 && (
          <PropertyRow label={t("task-components:depth_f1dbc339")}>
            <span className="text-sm font-mono">{issue.requestDepth}</span>
          </PropertyRow>
        )}
      </PropertySection>

      {/* Experimental Cases rail (PAP-12969) — self-gates on the flag and
          renders nothing when no cases are linked. */}
      <div className="pt-3">
        <IssueCasesPanel issueId={issue.id} />
      </div>
    </div>
  );

  // Classic Task Interface ON: the legacy stacked pane, byte-for-byte.
  if (!taskChatShellEnabled || sidePanelContentOnly) return propertiesBody;

  const hasSubtasksTab = streamlinedPropertiesEnabled && childIssues.length > 0;
  const hasReferencesTab = streamlinedPropertiesEnabled
    && (panelReferencedTasks.length > 0 || panelMentionedInTasks.length > 0);
  const availablePaneTabs: IssuePaneTabDescriptor[] = [
    { value: "properties", label: t("task-components:properties_ae43692b"), closable: false },
    ...(hasSubtasksTab
      ? [{ value: "subtasks" as const, label: t("task-components:subtasks_7eff0a19"), count: childIssues.length, closable: true }]
      : []),
    ...(hasReferencesTab
      ? [{ value: "references" as const, label: t("task-components:references_69824d3b"), closable: true }]
      : []),
    ...(hasPlanTab
      ? [{ value: "plans" as const, label: t("task-components:plan_fa8ed0bd"), closable: true }]
      : []),
    ...(hasArtifactsTab
      ? [{ value: "artifacts" as const, label: t("task-components:artifacts_314ae71b"), closable: true }]
      : []),
  ];
  const visiblePaneTabs = availablePaneTabs.filter(
    (tab) => tab.value === "properties" || !closedPaneTabs.has(tab.value),
  );
  const hiddenPaneTabs = availablePaneTabs.filter((tab) => closedPaneTabs.has(tab.value));

  // Chat-style with nothing to switch between: render one selected tab button
  // so the header uses the same filled-tab treatment as the multi-tab state.
  if (!hasSubtasksTab && !hasReferencesTab && !hasPlanTab && !hasArtifactsTab) {
    return (
      <>
        {paneHeaderSlot
          ? streamlinedPropertiesEnabled ? createPortal(
              <div className="flex items-center" role="tablist" aria-label={t("task-components:propertiesPanelSections_60eb8c4e")}>
                <button
                  type="button"
                  role="tab"
                  aria-selected="true"
                  className={cn(
                    STREAMLINED_PANE_TAB_CLASS,
                    "inline-flex flex-none items-center bg-muted px-3",
                  )}
                >{t("task-components:properties_ae43692b")}</button>
              </div>,
              paneHeaderSlot,
            ) : createPortal(<span className="text-sm font-medium">{t("task-components:properties_ae43692b")}</span>, paneHeaderSlot)
          : null}
        {propertiesBody}
      </>
    );
  }

  // Flag ON: wrap the same body in a Properties | Plan | Artifacts tab shell
  // (v5 decision: singular "Plan", Docs merged into Artifacts). The Properties
  // tab is unchanged. Panel hosts portal the strip into the pane header bar;
  // portals keep React context, so the Tabs root still drives it.
  // Fall back to Properties if the selected tab's content went away (or the
  // selection was made on another issue).
  const activePaneTab =
    (paneTab === "plans" && !hasPlanTab)
    || (paneTab === "artifacts" && !hasArtifactsTab)
    || (paneTab === "subtasks" && !hasSubtasksTab)
    || (paneTab === "references" && !hasReferencesTab)
    || closedPaneTabs.has(paneTab)
      ? "properties"
      : paneTab;
  const closePaneTab = (value: IssuePaneTab) => {
    if (value === "properties") return;
    paneTabUserChosenRef.current = true;
    setClosedPaneTabs((current) => {
      const next = new Set(current);
      next.add(value);
      return next;
    });
    if (activePaneTab !== value) return;
    const closingIndex = visiblePaneTabs.findIndex((tab) => tab.value === value);
    const fallback = visiblePaneTabs[closingIndex - 1]
      ?? visiblePaneTabs[closingIndex + 1]
      ?? availablePaneTabs[0];
    setPaneTab(fallback.value);
  };
  const reopenPaneTab = (value: IssuePaneTab) => {
    paneTabUserChosenRef.current = true;
    setClosedPaneTabs((current) => {
      if (!current.has(value)) return current;
      const next = new Set(current);
      next.delete(value);
      return next;
    });
    setPaneTab(value);
  };
  const codexStylePaneTabs = Boolean(paneHeaderSlot && streamlinedPropertiesEnabled);
  // Production keeps the master underline treatment. Streamlined task detail
  // uses the compact, truncating Codex-inspired pane-tab treatment instead.
  const paneTabTriggerClass = paneHeaderSlot
    ? streamlinedPropertiesEnabled
      ? cn(
          STREAMLINED_PANE_TAB_CLASS,
          "min-w-0 flex-1 justify-start overflow-hidden after:hidden",
        )
      : "h-full group-data-[orientation=horizontal]/tabs:after:bottom-0"
    : undefined;
  const paneTabs = codexStylePaneTabs ? visiblePaneTabs : availablePaneTabs;
  const tabList = (
    <TabsList
      variant="line"
      className={
        paneHeaderSlot
          ? streamlinedPropertiesEnabled
            ? "min-w-0 flex-1 items-center justify-start gap-0 overflow-hidden p-0 group-data-[orientation=horizontal]/tabs:h-full"
            : "items-stretch justify-start gap-1 p-0 group-data-[orientation=horizontal]/tabs:h-full"
          : "w-full justify-start gap-1"
      }
    >
      {paneTabs.map((tab, index) => {
        const trigger = (
          <TabsTrigger
            key={codexStylePaneTabs ? undefined : tab.value}
            value={tab.value}
            className={cn(
              paneTabTriggerClass,
              codexStylePaneTabs && "mx-1.5 hover:bg-accent/50 group-focus-within/pane-tab:bg-accent/50",
              codexStylePaneTabs && "px-3",
            )}
          >
            <span
              className={cn(
                codexStylePaneTabs
                  && "task-detail-pane-tab-label min-w-0 flex-1 overflow-hidden whitespace-nowrap",
              )}
              title={tab.label}
            >
              {tab.label}
            </span>
            {tab.count ? (
              <span className="shrink-0 font-mono text-(length:--text-nano) text-muted-foreground transition-opacity group-hover/pane-tab:opacity-0 group-focus-within/pane-tab:opacity-0">
                {tab.count}
              </span>
            ) : null}
          </TabsTrigger>
        );
        if (!codexStylePaneTabs) return trigger;
        return (
          <div
            key={tab.value}
            data-slot="task-detail-pane-tab"
            className="group/pane-tab relative flex min-w-0 flex-1 basis-0 items-center"
          >
            {index > 0 ? (
              <span
                data-slot="task-detail-pane-tab-divider"
                aria-hidden="true"
                className="absolute left-0 top-1/2 h-4 w-px -translate-y-1/2 bg-border"
              />
            ) : null}
            {trigger}
            {tab.closable ? (
              <button
                type="button"
                className="absolute right-2.5 top-1/2 z-20 inline-flex size-5 -translate-y-1/2 items-center justify-center rounded-sm text-muted-foreground opacity-0 transition-opacity hover:bg-accent hover:text-foreground focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-(length:--rad-3) focus-visible:ring-ring group-hover/pane-tab:opacity-100 group-focus-within/pane-tab:opacity-100"
                aria-label={t("task-components:closeTab_e6e6dac9", { value1: tab.label })}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  closePaneTab(tab.value);
                }}
              >
                <X className="size-3.5" aria-hidden />
              </button>
            ) : null}
          </div>
        );
      })}
    </TabsList>
  );
  const tabStrip = codexStylePaneTabs ? (
    <div className="flex h-full min-w-0 flex-1 items-center">
      {tabList}
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className="size-6 shrink-0 text-muted-foreground"
            disabled={hiddenPaneTabs.length === 0}
            aria-label={t("task-components:openClosedSidebarTab_a5dddc07")}
            title={hiddenPaneTabs.length === 0 ? t("task-components:allSidebarTabsAreOpen_48d6f9cc") : t("task-components:openClosedSidebarTab_a5dddc07")}
          >
            <Plus className="size-3.5" aria-hidden />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="start" className="min-w-(--sz-8rem)">
          {hiddenPaneTabs.map((tab) => (
            <DropdownMenuItem key={tab.value} onClick={() => reopenPaneTab(tab.value)}>
              {tab.label}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  ) : tabList;
  return (
    <Tabs value={activePaneTab} onValueChange={handlePaneTabChange} className="flex min-h-0 flex-col gap-3">
      {paneHeaderSlot
        ? createPortal(
            // Portals keep React context but break the DOM tree the Tailwind
            // group-selectors need: the active-tab underline is styled via
            // `group-data-[orientation=horizontal]/tabs:*`, so restore that
            // ancestor here (display: contents keeps it out of layout).
            <div className="group/tabs contents" data-orientation="horizontal">
              {tabStrip}
            </div>,
            paneHeaderSlot,
          )
        : tabStrip}
      <TabsContent value="properties">{propertiesBody}</TabsContent>
      {hasSubtasksTab ? (
        <TabsContent value="subtasks">
          <TaskDetailSubtasksPanel
            items={childIssues}
            onAddSubtask={onAddSubIssue}
            issueLinkState={issueLinkState}
          />
        </TabsContent>
      ) : null}
      {hasReferencesTab ? (
        <TabsContent value="references">
          <TaskDetailReferencesPanel
            referenced={panelReferencedTasks}
            mentionedIn={panelMentionedInTasks}
            issueLinkState={issueLinkState}
          />
        </TabsContent>
      ) : null}
      {hasPlanTab ? (
        <TabsContent value="plans">
          <IssuePropertiesPlansTab issue={issue} inline={inline} />
        </TabsContent>
      ) : null}
      {hasArtifactsTab ? (
        <TabsContent value="artifacts">
          <IssuePropertiesArtifactsTab
            issue={issue}
            documentDeepLink={documentDeepLink?.tab === "artifacts" ? documentDeepLink : null}
          />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}
