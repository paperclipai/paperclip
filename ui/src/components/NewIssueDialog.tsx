import { usePrimaryAgentPresentation } from "./primary-agent/PrimaryAgentPresentation";
import { useWorkspaceIsolationControls } from "@/hooks/useWorkspaceIsolationControls";
import { useState, useEffect, useRef, useCallback, useMemo, type CSSProperties, type DragEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import type { AgentEnvConfig, EnvBinding, IssueWorkMode } from "@paperclipai/shared";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { MissingUserSecretsBanner } from "../pages/secrets/MissingUserSecretsBanner";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { buildCompanyUserInlineOptions, buildMarkdownMentionOptions, isAgentTaskTarget } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { useNavigate } from "../lib/router";
import {
  defaultExecutionWorkspaceModeForProject,
  defaultProjectWorkspaceIdForProject,
  issueExecutionWorkspaceModeForExistingWorkspace,
} from "../lib/project-workspace-defaults";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { useStreamlinedUiEnabled } from "../hooks/useStreamlinedUiEnabled";
import { getRecentAssigneeIds, getRecentAssigneeSelectionIds, sortAgentsByRecency, trackRecentAssignee, trackRecentAssigneeUser } from "../lib/recent-assignees";
import { getLastProjectId, getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { recordRecentTask } from "../lib/recent-tasks";
import { buildExecutionPolicy } from "../lib/issue-execution-policy";
import { createUuid } from "../lib/uuid";
import { isIssueWorkMode, nextWorkMode } from "../lib/work-mode-meta";
import { useToastActions } from "../context/ToastContext";
import { assigneeValueFromSelection, currentUserAssigneeOption, parseAssigneeValue } from "../lib/assignees";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Paperclip, FileText, Flag, PauseCircle, ListTree, X, ShieldAlert, Folder, ChevronDown, Lock } from "lucide-react";
import { cn } from "../lib/utils";
import type { MentionOption } from "./MarkdownEditor";
import { TaskChatComposer } from "./task-chat/TaskChatComposer";
import { ComposerWorktreePicker } from "./task-chat/ComposerWorktreePicker";
import { TaskChatPresentationProvider } from "./task-chat/presentation-mode";
import { mergeComposerRunSettings, type ComposerRunSettings } from "./task-chat/composer-run-settings";
import { useSidebar } from "../context/SidebarContext";
import { InlineBanner } from "./InlineBanner";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";
import { getTrustPreset } from "../lib/trust-policy-ui";

const DRAFT_KEY = "paperclip:issue-draft";
const DEBOUNCE_MS = 800;

type VisualViewportLayout = {
  height: number;
  offsetTop: number;
  constrained: boolean;
};

type NewIssueDialogViewportStyle = CSSProperties & {
  "--new-issue-visual-viewport-height"?: string;
  "--new-issue-dialog-top"?: string;
  "--new-issue-dialog-height"?: string;
};

type MobileEntityPickerViewportStyle = CSSProperties & {
  "--mobile-entity-picker-visual-viewport-height"?: string;
};

function readVisualViewportLayout(): VisualViewportLayout | null {
  if (typeof window === "undefined" || !window.visualViewport) return null;
  const { height, offsetTop } = window.visualViewport;
  // Mobile browsers can briefly report unusable geometry while the visual
  // viewport initializes or animates. Applying it collapses the dialog.
  if (!Number.isFinite(height) || height <= 0 || !Number.isFinite(offsetTop) || offsetTop < 0) {
    return null;
  }
  return {
    height,
    offsetTop,
    constrained: height < window.innerHeight,
  };
}

function useVisualViewportLayout(enabled: boolean) {
  const [layout, setLayout] = useState<VisualViewportLayout | null>(() =>
    enabled ? readVisualViewportLayout() : null,
  );

  useEffect(() => {
    if (!enabled) {
      setLayout(null);
      return;
    }

    const viewport = window.visualViewport;
    if (!viewport) return;

    const updateLayout = () => {
      const nextLayout = readVisualViewportLayout();
      // Keep the last valid keyboard geometry during transient invalid readings.
      if (nextLayout) setLayout(nextLayout);
    };
    updateLayout();
    viewport.addEventListener("resize", updateLayout);
    viewport.addEventListener("scroll", updateLayout);
    window.addEventListener("resize", updateLayout);
    return () => {
      viewport.removeEventListener("resize", updateLayout);
      viewport.removeEventListener("scroll", updateLayout);
      window.removeEventListener("resize", updateLayout);
    };
  }, [enabled]);

  return layout;
}

interface IssueDraft {
  isPrivate?: boolean;
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeValue: string;
  reviewerValue: string;
  approverValue: string;
  watchdogAgentId?: string;
  watchdogInstructions?: string;
  assigneeId?: string;
  projectId: string;
  projectWorkspaceId?: string;
  assigneeModelLane?: IssueModelLane;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  executionWorkspaceMode?: string;
  selectedExecutionWorkspaceId?: string;
  useIsolatedExecutionWorkspace?: boolean;
  workMode?: IssueWorkMode;
  composerSettings?: ComposerRunSettings | null;
}

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

import { Badge } from "@/components/ui/badge";
import { buildAssigneeAdapterOverrides, type IssueModelLane } from "../lib/issue-assignee-overrides";

function loadDraft(): IssueDraft | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    if (!raw) return null;
    return JSON.parse(raw) as IssueDraft;
  } catch {
    return null;
  }
}

function saveDraft(draft: IssueDraft) {
  localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
}

function clearDraft() {
  localStorage.removeItem(DRAFT_KEY);
}

function isTextDocumentFile(file: File) {
  const name = file.name.toLowerCase();
  return (
    name.endsWith(".md") ||
    name.endsWith(".markdown") ||
    name.endsWith(".txt") ||
    file.type === "text/markdown" ||
    file.type === "text/plain"
  );
}

function fileBaseName(filename: string) {
  return filename.replace(/\.[^.]+$/, "");
}

function slugifyDocumentKey(input: string) {
  const slug = input
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug || "document";
}

function titleizeFilename(input: string) {
  return input
    .split(/[-_ ]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function createUniqueDocumentKey(baseKey: string, stagedFiles: StagedIssueFile[]) {
  const existingKeys = new Set(
    stagedFiles
      .filter((file) => file.kind === "document")
      .map((file) => file.documentKey)
      .filter((key): key is string => Boolean(key)),
  );
  if (!existingKeys.has(baseKey)) return baseKey;
  let suffix = 2;
  while (existingKeys.has(`${baseKey}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseKey}-${suffix}`;
}

function formatFileSize(file: File) {
  if (file.size < 1024) return `${file.size} B`;
  if (file.size < 1024 * 1024) return `${(file.size / 1024).toFixed(1)} KB`;
  return `${(file.size / (1024 * 1024)).toFixed(1)} MB`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRequiredUserSecretBinding(value: unknown): value is Extract<EnvBinding, { type: "user_secret_ref" }> {
  return (
    isRecord(value) &&
    value.type === "user_secret_ref" &&
    typeof value.key === "string" &&
    value.key.trim().length > 0 &&
    value.required !== false &&
    value.allowMissingOverride !== true
  );
}

function collectRequiredUserSecretKeysFromEnv(
  env: AgentEnvConfig | Record<string, unknown> | null | undefined,
): string[] {
  if (!isRecord(env)) return [];
  return Object.values(env).flatMap((binding) => (isRequiredUserSecretBinding(binding) ? [binding.key.trim()] : []));
}

function uniqueRequiredUserSecretKeys(
  inputs: Array<AgentEnvConfig | Record<string, unknown> | null | undefined>,
): string[] {
  return [...new Set(inputs.flatMap(collectRequiredUserSecretKeysFromEnv))];
}

function shouldWarnAboutRunUserSecrets(status: string, assigneeAgentId: string | null | undefined) {
  return Boolean(assigneeAgentId) && (status === "todo" || status === "in_progress");
}

function defaultExecutionWorkspaceModeForIssueDefaults(
  defaults: {
    executionWorkspaceId?: unknown;
    executionWorkspaceMode?: unknown;
  },
  project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined,
) {
  if (typeof defaults.executionWorkspaceId === "string" && defaults.executionWorkspaceId.length > 0) {
    return "reuse_existing";
  }
  return typeof defaults.executionWorkspaceMode === "string" && defaults.executionWorkspaceMode.length > 0
    ? defaults.executionWorkspaceMode
    : defaultExecutionWorkspaceModeForProject(project);
}

function isWorkModePeriodShortcut(e: Pick<React.KeyboardEvent, "code" | "ctrlKey" | "key" | "metaKey">) {
  const isPeriod = e.code === "Period" || e.key === ".";
  return (e.metaKey || e.ctrlKey) && isPeriod;
}

function isWorkModeEscapeShortcut(e: Pick<KeyboardEvent, "key" | "metaKey">) {
  return e.metaKey && e.key === "Escape";
}

export function NewIssueDialog() {
  const { visible: workspaceIsolationControlsVisible } = useWorkspaceIsolationControls();
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const visualViewportLayout = useVisualViewportLayout(newIssueOpen);
  const dialogBodyRef = useRef<HTMLDivElement>(null);
  const { companies, selectedCompanyId: effectiveCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { pushToast } = useToastActions();
  const { enabled: streamlinedUiEnabled } = useStreamlinedUiEnabled();
  const [title, setTitle] = useState("");
  const [hasTitle, setHasTitle] = useState(false);
  const [description, setDescription] = useState("");
  const titleRef = useRef("");
  const descriptionRef = useRef("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [reviewerValue, setReviewerValue] = useState("");
  const [approverValue, setApproverValue] = useState("");
  const [watchdogAgentId, setWatchdogAgentId] = useState("");
  const [watchdogInstructions, setWatchdogInstructions] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [assigneeModelLane, setAssigneeModelLane] = useState<IssueModelLane>("primary");
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [executionWorkspaceMode, setExecutionWorkspaceMode] = useState<string>("shared_workspace");
  const [selectedExecutionWorkspaceId, setSelectedExecutionWorkspaceId] = useState("");
  const [workMode, setWorkMode] = useState<IssueWorkMode>("standard");
  const [isPrivate, setIsPrivate] = useState(false);
  const { isMobile } = useSidebar();
  const [composerSettings, setComposerSettings] = useState<ComposerRunSettings | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedIssueFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executionWorkspaceDefaultProjectId = useRef<string | null>(null);
  const initializationKeyRef = useRef<string | null>(null);
  const defaultAssigneePendingRef = useRef(false);
  const defaultProjectPendingRef = useRef(false);
  const createRequestRef = useRef<{ fingerprint: string; idempotencyKey: string } | null>(null);

  const primaryAgent = usePrimaryAgentPresentation(effectiveCompanyId);
  const isSubIssueMode = Boolean(newIssueDefaults.parentId);
  const parentIssueLabel =
    newIssueDefaults.parentIdentifier ?? (newIssueDefaults.parentId ? newIssueDefaults.parentId.slice(0, 8) : "");
  const parentExecutionWorkspaceId = newIssueDefaults.executionWorkspaceId ?? "";
  const parentExecutionWorkspaceLabel = newIssueDefaults.parentExecutionWorkspaceLabel ?? parentExecutionWorkspaceId;

  const { data: agents } = useQuery({
    queryKey: queryKeys.agents.list(effectiveCompanyId!),
    queryFn: () => agentsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });

  const { data: projects } = useQuery({
    queryKey: queryKeys.projects.list(effectiveCompanyId!),
    queryFn: () => projectsApi.list(effectiveCompanyId!),
    enabled: !!effectiveCompanyId && newIssueOpen,
  });
  const { data: mentionIssues } = useQuery({
    queryKey: queryKeys.issues.mentionPool(effectiveCompanyId!),
    queryFn: () => issuesApi.list(effectiveCompanyId!, {
      limit: 100,
      sortField: "updated",
      sortDir: "desc",
    }),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen,
    staleTime: 60_000,
  });
  const { data: session, isFetched: sessionFetched } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: companyMembers, isFetched: membersFetched } = useQuery({
    queryKey: queryKeys.access.companyUserDirectory(effectiveCompanyId!),
    queryFn: () => accessApi.listUserDirectory(effectiveCompanyId!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen,
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: newIssueOpen,
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const activeProjects = useMemo(() => projects ?? [], [projects]);
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId: effectiveCompanyId,
    userId: currentUserId,
  });
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const currentProjectExecutionWorkspacePolicy =
    experimentalSettings?.enableIsolatedWorkspaces === true ? (currentProject?.executionWorkspacePolicy ?? null) : null;
  const currentProjectSupportsExecutionWorkspace = Boolean(currentProjectExecutionWorkspacePolicy?.enabled);
  const canChooseWorktrees = workspaceIsolationControlsVisible && currentProjectSupportsExecutionWorkspace;
  const {
    data: reusableExecutionWorkspaces,
    isPending: worktreesLoading,
    isError: worktreesError,
    refetch: refetchWorktrees,
  } = useQuery({
    queryKey: queryKeys.executionWorkspaces.summaryList(effectiveCompanyId!, {
      projectId,
      reuseEligible: true,
    }),
    queryFn: () => executionWorkspacesApi.listSummaries(effectiveCompanyId!, {
      projectId,
      reuseEligible: true,
    }),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && canChooseWorktrees,
    retry: false,
  });

  const { data: privacyParent, isError: parentPrivacyError, refetch: refetchParentPrivacy } = useQuery({
    queryKey: queryKeys.issues.detail(newIssueDefaults.parentId ?? ""),
    queryFn: () => issuesApi.get(newIssueDefaults.parentId!),
    enabled: newIssueOpen && Boolean(newIssueDefaults.parentId),
    retry: false,
  });
  const parentPrivacyUnresolved = isSubIssueMode && !privacyParent;
  const inheritsPrivateAccess = privacyParent?.visibility === "private" || privacyParent?.project?.visibility === "private";
  const privateParentProject = privacyParent?.project?.visibility === "private" ? privacyParent.project : null;
  const inheritedPrivateProject = privateParentProject ?? (!isPrivate && currentProject?.visibility === "private" ? currentProject : null);
  const inheritedPrivacyReason = privacyParent?.visibility === "private"
    ? `Subtask of private task ${privacyParent.title || newIssueDefaults.parentTitle || parentIssueLabel}`
    : inheritedPrivateProject ? `In private project ${inheritedPrivateProject.name}` : undefined;
  const effectivePrivate = isPrivate || inheritsPrivateAccess
    || orderedProjects.some(project => project.id === projectId && project.visibility === "private");

  const selectedAssignee = useMemo(() => parseAssigneeValue(assigneeValue), [assigneeValue]);
  const selectedAssigneeAgentId = selectedAssignee.assigneeAgentId;
  const selectedAssigneeUserId = selectedAssignee.assigneeUserId;

  const selectedAssigneeAgent = useMemo(
    () => (agents ?? []).find((agent) => agent.id === selectedAssigneeAgentId) ?? null,
    [agents, selectedAssigneeAgentId],
  );
  const assigneeAdapterType = selectedAssigneeAgent?.adapterType ?? null;
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
      issues: mentionIssues,
    });
  }, [agents, companyMembers?.users, orderedProjects, mentionIssues]);

  const createIssue = useMutation({
    mutationFn: async ({
      companyId,
      stagedFiles: pendingStagedFiles,
      navigateOnCreate,
      ...data
    }: { companyId: string; stagedFiles: StagedIssueFile[]; navigateOnCreate?: boolean } & Record<string, unknown>) => {
      const issue = await issuesApi.create(companyId, data);
      const failures: string[] = [];

      for (const stagedFile of pendingStagedFiles) {
        try {
          if (stagedFile.kind === "document") {
            const body = await stagedFile.file.text();
            await issuesApi.upsertDocument(issue.id, stagedFile.documentKey ?? "document", {
              title: stagedFile.documentKey === "plan" ? null : (stagedFile.title ?? null),
              format: "markdown",
              body,
              baseRevisionId: null,
            });
          } else {
            await issuesApi.uploadAttachment(companyId, issue.id, stagedFile.file);
          }
        } catch {
          failures.push(stagedFile.file.name);
        }
      }

      return { issue, companyId, failures, navigateOnCreate };
    },
    onSuccess: ({ issue, companyId, failures, navigateOnCreate }) => {
      trackRecentProject(issue.projectId ?? "", companyId);
      if (issue.assigneeAgentId) trackRecentAssignee(issue.assigneeAgentId, companyId);
      if (issue.assigneeUserId) trackRecentAssigneeUser(issue.assigneeUserId, companyId);
      if (streamlinedUiEnabled) recordRecentTask(issue, currentUserId);
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      const prefix = (companies.find((company) => company.id === companyId)?.issuePrefix ?? "").trim();
      const issueRef = issue.identifier ?? issue.id;
      const openIssueAction = prefix
        ? { label: `Open ${issueRef}`, href: `/${prefix}/issues/${issueRef}` }
        : undefined;
      if (failures.length > 0) {
        pushToast({
          title: `Created ${issueRef} with upload warnings`,
          body: `${failures.length} staged ${failures.length === 1 ? "file" : "files"} could not be added.`,
          tone: "warn",
          action: openIssueAction,
        });
      } else {
        pushToast({
          title: `Created ${issueRef}`,
          tone: "success",
          action: openIssueAction,
        });
      }
      clearDraft();
      reset();
      closeNewIssue();
      if (navigateOnCreate) navigate(openIssueAction?.href ?? `/issues/${issueRef}`);
    },
  });

  // Debounced draft saving
  const scheduleSave = useCallback((draft: IssueDraft) => {
    if (draftTimer.current) clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => {
      if (draft.title.trim() || draft.description.trim()) saveDraft(draft);
    }, DEBOUNCE_MS);
  }, []);

  const setIssueText = useCallback((nextTitle: string, nextDescription: string) => {
    setHasTitle(Boolean(nextTitle));
    titleRef.current = nextTitle;
    descriptionRef.current = nextDescription;
    setTitle(nextTitle);
    setDescription(nextDescription);
  }, []);

  const queueDraftSave = useCallback(
    (overrides: { title?: string; description?: string } = {}) => {
      if (!newIssueOpen) return;
      const nextTitle = overrides.title ?? titleRef.current;
      const nextDescription = overrides.description ?? descriptionRef.current;
      scheduleSave({
        title: nextTitle,
        description: nextDescription,
        status,
        priority,
        assigneeValue,
        reviewerValue,
        approverValue,
        watchdogAgentId,
        watchdogInstructions,
        projectId,
        projectWorkspaceId,
        assigneeModelLane,
        assigneeModelOverride,
        assigneeThinkingEffort,
        assigneeChrome,
        executionWorkspaceMode,
        selectedExecutionWorkspaceId,
        workMode,
        isPrivate,
        composerSettings,
      });
    },
    [
      newIssueOpen,
      scheduleSave,
      status,
      priority,
      assigneeValue,
      reviewerValue,
      approverValue,
      watchdogAgentId,
      watchdogInstructions,
      projectId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      executionWorkspaceMode,
      selectedExecutionWorkspaceId,
      workMode,
      isPrivate,
      composerSettings,
    ],
  );

  const handleDescriptionChange = useCallback(
    (nextDescription: string) => {
      descriptionRef.current = nextDescription;
      setDescription(nextDescription);

      queueDraftSave({ description: nextDescription });
    },
    [queueDraftSave],
  );

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    queueDraftSave();
  }, [
    status,
    priority,
    assigneeValue,
    reviewerValue,
    approverValue,
    watchdogAgentId,
    watchdogInstructions,
    projectId,
    projectWorkspaceId,
    assigneeModelLane,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    executionWorkspaceMode,
    selectedExecutionWorkspaceId,
    workMode,
    newIssueOpen,
    queueDraftSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) {
      initializationKeyRef.current = null;
      defaultAssigneePendingRef.current = false;
      defaultProjectPendingRef.current = false;
      return;
    }
    const initializationKey = `${effectiveCompanyId ?? ""}:${JSON.stringify(newIssueDefaults)}`;
    if (initializationKeyRef.current === initializationKey) return;
    initializationKeyRef.current = initializationKey;

    executionWorkspaceDefaultProjectId.current = null;

    const draft = loadDraft();
    defaultProjectPendingRef.current = newIssueDefaults.projectId === undefined && !newIssueDefaults.parentId;
    defaultAssigneePendingRef.current = !newIssueDefaults.assigneeAgentId && !newIssueDefaults.assigneeUserId;
    setComposerSettings(null);
    setIsPrivate(false);
    createIssue.reset();
    if (newIssueDefaults.parentId) {
      const nextWorkMode = isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard";
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      const defaultProjectWorkspaceId =
        newIssueDefaults.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(defaultProject);
      const defaultExecutionWorkspaceMode = defaultExecutionWorkspaceModeForIssueDefaults(
        newIssueDefaults,
        defaultProject,
      );
      setIssueText(newIssueDefaults.title ?? "", newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceId);
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelLane("primary");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceMode);
      setWorkMode(nextWorkMode);
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current =
        hasExplicitProjectWorkspaceId || defaultProject ? defaultProjectId || null : null;
    } else if (newIssueDefaults.title || newIssueDefaults.description) {
      const nextWorkMode = isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard";
      setIssueText(newIssueDefaults.title ?? "", newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newIssueDefaults.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setReviewerValue("");
      setApproverValue("");

      setWatchdogAgentId("");
      setWatchdogInstructions("");

      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, defaultProject));
      setWorkMode(nextWorkMode);
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current =
        hasExplicitProjectWorkspaceId || newIssueDefaults.executionWorkspaceId || defaultProject
          ? defaultProjectId || null
          : null;
    } else if (draft && (draft.title.trim() || draft.description.trim())) {
      defaultAssigneePendingRef.current = false;
      defaultProjectPendingRef.current = false;
      const nextWorkMode = isIssueWorkMode(draft.workMode) ? draft.workMode : "standard";
      const restoredProjectId = newIssueDefaults.projectId ?? draft.projectId;
      const restoredProject = orderedProjects.find((project) => project.id === restoredProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      const hasExplicitExecutionWorkspaceId = newIssueDefaults.executionWorkspaceId !== undefined;
      const hasExplicitExecutionWorkspaceMode = newIssueDefaults.executionWorkspaceMode !== undefined;
      setIsPrivate(draft.isPrivate ?? false);
      setIssueText(draft.title, draft.description);
      setComposerSettings(draft.composerSettings ?? null);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId || newIssueDefaults.assigneeUserId
          ? assigneeValueFromSelection(newIssueDefaults)
          : (draft.assigneeValue ?? draft.assigneeId ?? ""),
      );
      setReviewerValue(draft.reviewerValue ?? "");
      setApproverValue(draft.approverValue ?? "");

      setWatchdogAgentId(draft.watchdogAgentId ?? "");
      setWatchdogInstructions(draft.watchdogInstructions ?? "");

      setProjectId(restoredProjectId);
      setProjectWorkspaceId(
        hasExplicitProjectWorkspaceId
          ? (newIssueDefaults.projectWorkspaceId ?? "")
          : (draft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject)),
      );
      setAssigneeModelLane(draft.assigneeModelLane ?? "primary");
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setExecutionWorkspaceMode(
        hasExplicitExecutionWorkspaceId || hasExplicitExecutionWorkspaceMode
          ? defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, restoredProject)
          : (draft.executionWorkspaceMode ??
              (draft.useIsolatedExecutionWorkspace
                ? "isolated_workspace"
                : defaultExecutionWorkspaceModeForProject(restoredProject))),
      );
      setWorkMode(nextWorkMode);
      setSelectedExecutionWorkspaceId(
        hasExplicitExecutionWorkspaceId
          ? (newIssueDefaults.executionWorkspaceId ?? "")
          : (draft.selectedExecutionWorkspaceId ?? ""),
      );
      executionWorkspaceDefaultProjectId.current =
        hasExplicitProjectWorkspaceId || hasExplicitExecutionWorkspaceId || draft.projectWorkspaceId || restoredProject
          ? restoredProjectId || null
          : null;
    } else {
      setWorkMode(isIssueWorkMode(newIssueDefaults.workMode) ? newIssueDefaults.workMode : "standard");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      setIssueText("", "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(newIssueDefaults.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setReviewerValue("");
      setApproverValue("");

      setWatchdogAgentId("");
      setWatchdogInstructions("");

      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForIssueDefaults(newIssueDefaults, defaultProject));
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current =
        hasExplicitProjectWorkspaceId || newIssueDefaults.executionWorkspaceId || defaultProject
          ? defaultProjectId || null
          : null;
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects, effectiveCompanyId, setIssueText]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    createRequestRef.current = null;
    setIssueText("", "");
    setStatus("todo");
    setPriority("");
    setAssigneeValue("");
    setReviewerValue("");
    setApproverValue("");

    setWatchdogAgentId("");
    setWatchdogInstructions("");

    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeModelLane("primary");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setExecutionWorkspaceMode("shared_workspace");
    setSelectedExecutionWorkspaceId("");
    setWorkMode("standard");

    setComposerSettings(null);
    setIsPrivate(false);

    setStagedFiles([]);
    setIsFileDragOver(false);

    executionWorkspaceDefaultProjectId.current = null;
    initializationKeyRef.current = null;
  }

  async function handleSubmit(body: string, mode: IssueWorkMode, settings: ComposerRunSettings | null) {
    const currentTitle = titleRef.current.trim();
    const currentDescription = body.trim();
    if (!effectiveCompanyId || (!currentTitle && !currentDescription) || createIssue.isPending || worktreeSelectionIncomplete || parentPrivacyUnresolved) return;
    const inheritedOverrides = buildAssigneeAdapterOverrides({
      adapterType: assigneeAdapterType,
      lane: assigneeChrome ? "custom" : assigneeModelLane,
      modelOverride: assigneeModelOverride,
      thinkingEffortOverride: assigneeThinkingEffort,
      chrome: assigneeChrome,
    });
    const selectedProject = orderedProjects.find((project) => project.id === projectId);
    // Hidden selectors must not submit a restored draft over the managed default.
    const executionWorkspacePolicy =
      workspaceIsolationControlsVisible && experimentalSettings?.enableIsolatedWorkspaces === true
        ? (selectedProject?.executionWorkspacePolicy ?? null)
        : null;
    const selectedReusableExecutionWorkspace = selectableReusableWorkspaces.find(
      (workspace) => workspace.id === selectedExecutionWorkspaceId,
    );
    const requestedExecutionWorkspaceMode =
      executionWorkspaceMode === "reuse_existing"
        ? issueExecutionWorkspaceModeForExistingWorkspace(selectedReusableExecutionWorkspace?.mode)
        : executionWorkspaceMode;
    const executionWorkspaceSettings = executionWorkspacePolicy?.enabled
      ? { mode: requestedExecutionWorkspaceMode }
      : null;
    const requestedProjectWorkspaceId = canChooseWorktrees && executionWorkspaceMode === "reuse_existing" && selectedReusableExecutionWorkspace
      ? selectedReusableExecutionWorkspace.projectWorkspaceId
      : projectWorkspaceId;
    // A task launched from a workspace (or its parent task) keeps that explicit
    // context. Draft-only choices are ignored while the selector is hidden.
    const contextualWorkspaceId =
      !workspaceIsolationControlsVisible && newIssueDefaults.projectId === projectId
        ? newIssueDefaults.executionWorkspaceId
        : undefined;
    const executionPolicy = buildExecutionPolicy({
      reviewerValues: reviewerValue ? [reviewerValue] : [],
      approverValues: approverValue ? [approverValue] : [],
    });
    const assigneeAdapterOverrides = settings
      ? mergeComposerRunSettings(inheritedOverrides, assigneeAdapterType ?? undefined, settings)
      : inheritedOverrides;
    const createData = {
      companyId: effectiveCompanyId,
      stagedFiles,
      ...(currentTitle ? { title: currentTitle } : {}),
      description: currentDescription || undefined,
      status,
      priority: priority || "medium",
      workMode: mode,
      ...(effectivePrivate ? { visibility: "private" } : {}),
      ...(selectedAssigneeAgentId ? { assigneeAgentId: selectedAssigneeAgentId } : {}),
      ...(selectedAssigneeUserId ? { assigneeUserId: selectedAssigneeUserId } : {}),
      ...(newIssueDefaults.parentId ? { parentId: newIssueDefaults.parentId } : {}),
      ...(newIssueDefaults.goalId ? { goalId: newIssueDefaults.goalId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(requestedProjectWorkspaceId ? { projectWorkspaceId: requestedProjectWorkspaceId } : {}),
      ...(assigneeAdapterOverrides ? { assigneeAdapterOverrides } : {}),
      ...(executionWorkspacePolicy?.enabled ? { executionWorkspacePreference: executionWorkspaceMode } : {}),
      ...(canChooseWorktrees &&
      executionWorkspaceMode === "reuse_existing" &&
      selectedExecutionWorkspaceId
        ? { executionWorkspaceId: selectedExecutionWorkspaceId }
        : {}),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
      ...(contextualWorkspaceId
        ? { executionWorkspaceId: contextualWorkspaceId, executionWorkspacePreference: "reuse_existing" }
        : {}),
      ...(executionPolicy ? { executionPolicy } : {}),
      ...(watchdogAgentId
        ? { watchdog: { agentId: watchdogAgentId, instructions: watchdogInstructions.trim() || null } }
        : {}),
    };
    // An explicit board create is a new task even when its title already exists.
    // Reuse the request key only for retries of the same submitted draft.
    const fingerprint = JSON.stringify(createData);
    if (createRequestRef.current?.fingerprint !== fingerprint) {
      createRequestRef.current = { fingerprint, idempotencyKey: createUuid() };
    }
    await createIssue.mutateAsync({
      ...createData,
      allowDuplicate: true,
      idempotencyKey: createRequestRef.current.idempotencyKey,
      navigateOnCreate: newIssueDefaults.navigateOnCreate === true,
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (isWorkModePeriodShortcut(e)) {
      e.preventDefault();
      setWorkMode((current) => nextWorkMode(current));
      return;
    }
  }

  function stageFiles(files: File[]) {
    if (files.length === 0 || createIssue.isPending) return;
    setStagedFiles((current) => {
      const next = [...current];
      for (const file of files) {
        if (isTextDocumentFile(file)) {
          const baseName = fileBaseName(file.name);
          const documentKey = createUniqueDocumentKey(slugifyDocumentKey(baseName), next);
          next.push({
            id: `${file.name}:${file.size}:${file.lastModified}:${documentKey}`,
            file,
            kind: "document",
            documentKey,
            title: titleizeFilename(baseName),
          });
          continue;
        }
        next.push({
          id: `${file.name}:${file.size}:${file.lastModified}`,
          file,
          kind: "attachment",
        });
      }
      return next;
    });
  }

  function handleFileDragEnter(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    setIsFileDragOver(true);
  }

  function handleFileDragOver(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.types.includes("Files")) return;
    evt.preventDefault();
    evt.dataTransfer.dropEffect = "copy";
    setIsFileDragOver(true);
  }

  function handleFileDragLeave(evt: DragEvent<HTMLDivElement>) {
    if (evt.currentTarget.contains(evt.relatedTarget as Node | null)) return;
    setIsFileDragOver(false);
  }

  function handleFileDrop(evt: DragEvent<HTMLDivElement>) {
    if (!evt.dataTransfer.files.length) return;
    evt.preventDefault();
    setIsFileDragOver(false);
    stageFiles(Array.from(evt.dataTransfer.files));
  }

  function removeStagedFile(id: string) {
    setStagedFiles((current) => current.filter((file) => file.id !== id));
  }

  const currentAssignee = selectedAssigneeAgentId ? (agents ?? []).find((a) => a.id === selectedAssigneeAgentId) : null;
  const currentAssigneeLowTrust = getTrustPreset(currentAssignee?.permissions) === "low_trust_review";
  const neededUserSecretKeys = useMemo(() => {
    if (!shouldWarnAboutRunUserSecrets(status, selectedAssigneeAgentId)) return [];
    return uniqueRequiredUserSecretKeys([
      isRecord(currentAssignee?.adapterConfig) ? (currentAssignee.adapterConfig.env as Record<string, unknown>) : null,
      currentProject?.env ?? null,
    ]);
  }, [currentAssignee?.adapterConfig, currentProject?.env, selectedAssigneeAgentId, status]);
  const selectableReusableWorkspaces = reusableExecutionWorkspaces ?? [];
  const selectedReusableWorktree = selectableReusableWorkspaces.find((workspace) => workspace.id === selectedExecutionWorkspaceId);
  const worktreeSelectionIncomplete = canChooseWorktrees && executionWorkspaceMode === "reuse_existing"
    && (worktreesLoading || worktreesError || !selectedReusableWorktree);
  const isUsingParentExecutionWorkspace =
    isSubIssueMode && parentExecutionWorkspaceId
      ? executionWorkspaceMode === "reuse_existing" && selectedExecutionWorkspaceId === parentExecutionWorkspaceId
      : false;
  const showParentWorkspaceWarning =
    isSubIssueMode &&
    currentProjectSupportsExecutionWorkspace &&
    Boolean(parentExecutionWorkspaceId) &&
    !isUsingParentExecutionWorkspace;
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId] }),
      ...sortAgentsByRecency((agents ?? []).filter(isAgentTaskTarget), recentAssigneeIds).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agents, companyMembers?.users, currentUserId, recentAssigneeIds],
  );
  // Resolve once after the directory loads, without resetting text typed while
  // the queries were in flight or replacing an explicit/restored assignee.
  useEffect(() => {
    if (!newIssueOpen || !effectiveCompanyId || !defaultAssigneePendingRef.current
      || !agents || !sessionFetched || !membersFetched || primaryAgent?.loading) return;
    defaultAssigneePendingRef.current = false;
    const available = new Set(assigneeOptions.map((option) => option.id));
    const scopedRecents = getRecentAssigneeSelectionIds(effectiveCompanyId);
    // Older history has no company key. Agent IDs identify their company;
    // human IDs can belong to several companies and cannot be migrated safely.
    const recents = scopedRecents.length ? scopedRecents
      : getRecentAssigneeSelectionIds().filter((value) => value.startsWith("agent:"));
    const recent = recents.find((value) => available.has(value));
    const targets = agents.filter(isAgentTaskTarget);
    const fallback = targets.find((agent) => agent.id === primaryAgent?.primaryAgentId)
      ?? targets.find((agent) => agent.role === "ceo") ?? targets[0];
    setAssigneeValue(recent ?? (fallback ? assigneeValueFromSelection({ assigneeAgentId: fallback.id }) : ""));
  }, [newIssueOpen, effectiveCompanyId, agents, assigneeOptions, sessionFetched, membersFetched, primaryAgent?.loading, primaryAgent?.primaryAgentId]);
  useEffect(() => {
    if (!newIssueOpen || !effectiveCompanyId || !defaultProjectPendingRef.current || !projects) return;
    defaultProjectPendingRef.current = false;
    const available = new Set(orderedProjects.filter((project) => !project.archivedAt).map((project) => project.id));
    const last = getLastProjectId(effectiveCompanyId);
    const remembered = last !== undefined
      ? (available.has(last) ? last : "")
      : (getRecentProjectIds().find((id) => available.has(id)) ?? "");
    setProjectId(remembered);
  }, [newIssueOpen, effectiveCompanyId, projects, orderedProjects]);
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");

  const handleProjectChange = useCallback(
    (nextProjectId: string) => {
      defaultProjectPendingRef.current = false;
      trackRecentProject(nextProjectId, effectiveCompanyId ?? undefined);
      setProjectId(nextProjectId);
      const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
      executionWorkspaceDefaultProjectId.current = nextProjectId || null;
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(nextProject));
      setSelectedExecutionWorkspaceId("");
    },
    [orderedProjects, effectiveCompanyId],
  );

  useEffect(() => {
    if (
      !newIssueOpen ||
      !projectId ||
      selectedExecutionWorkspaceId ||
      executionWorkspaceDefaultProjectId.current === projectId
    ) {
      return;
    }
    const project = orderedProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    executionWorkspaceDefaultProjectId.current = projectId;
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(project));
    setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(project));
    setSelectedExecutionWorkspaceId("");
  }, [newIssueOpen, orderedProjects, projectId, selectedExecutionWorkspaceId]);
  const dialogViewportStyle = useMemo<NewIssueDialogViewportStyle>(() => {
    const dialogGeometry = {
      // Fixed-position coordinates are relative to Safari's visual viewport.
      // Adding visualViewport.offsetTop here places the dialog below that
      // viewport after the software keyboard pans the page.
      "--new-issue-dialog-top": "var(--new-issue-dialog-top-gap)",
      "--new-issue-dialog-height":
        "calc(var(--new-issue-visual-viewport-height) - var(--new-issue-dialog-top-gap) - var(--new-issue-dialog-bottom-gap))",
    };
    if (!visualViewportLayout) return dialogGeometry;
    return {
      ...dialogGeometry,
      "--new-issue-visual-viewport-height": `${visualViewportLayout.height}px`,
      ...(visualViewportLayout.constrained
        ? {
            top: "var(--new-issue-dialog-top)",
            maxHeight: "var(--new-issue-dialog-height)",
            translate: "var(--pct-neg-50)",
          }
        : {}),
    };
  }, [visualViewportLayout]);
  const entityPickerViewportStyle = useMemo<MobileEntityPickerViewportStyle>(() => {
    if (!visualViewportLayout) return {};
    return {
      "--mobile-entity-picker-visual-viewport-height": `${visualViewportLayout.height}px`,
    };
  }, [visualViewportLayout]);

  useEffect(() => {
    if (!visualViewportLayout?.constrained) return;
    const focusedElement = document.activeElement;
    if (
      !(focusedElement instanceof HTMLElement) ||
      !dialogBodyRef.current?.contains(focusedElement) ||
      typeof focusedElement.scrollIntoView !== "function"
    ) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      focusedElement.scrollIntoView({ block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [visualViewportLayout]);

  const modelAgents = useMemo(() => new Map((agents ?? []).map((agent) => [agent.id, agent])), [agents]);
  const inheritedOverrides = buildAssigneeAdapterOverrides({
    adapterType: assigneeAdapterType,
    lane: assigneeChrome ? "custom" : assigneeModelLane,
    modelOverride: assigneeModelOverride,
    thinkingEffortOverride: assigneeThinkingEffort,
    chrome: assigneeChrome,
  });

  return (
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        style={dialogViewportStyle}
        className="flex max-h-(--new-issue-dialog-height) flex-col gap-0 overflow-hidden rounded-(--radius-task-composer) border-0 bg-transparent p-0 shadow-none sm:max-w-2xl"
        onKeyDown={handleKeyDown}
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          dialogBodyRef.current?.querySelector<HTMLElement>('[contenteditable="true"]')?.focus();
        }}
        onEscapeKeyDown={(event) => {
          if (event.defaultPrevented) return;
          if (isWorkModeEscapeShortcut(event)) {
            event.preventDefault();
            setWorkMode((current) => nextWorkMode(current));
          } else if (createIssue.isPending) event.preventDefault();
        }}
        onPointerDownOutside={(event) => {
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (
            createIssue.isPending ||
            target?.closest("[data-radix-popper-content-wrapper], [data-paperclip-floating-ui]")
          ) {
            event.preventDefault();
          }
        }}
      >
        <DialogTitle className="sr-only">{isSubIssueMode ? "New sub-task" : "New task"}</DialogTitle>
        <div
          ref={dialogBodyRef}
          className={cn("min-h-0 overflow-y-auto overscroll-contain", isFileDragOver && "bg-accent/20")}
          onDragEnter={handleFileDragEnter}
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
        >
          <TaskChatPresentationProvider mode={streamlinedUiEnabled ? "streamlined" : "production"}>
            <TaskChatComposer
              workMode={workMode}
              onWorkModeChange={setWorkMode}
              disabled={createIssue.isPending || !effectiveCompanyId}
              placeholder="Describe a task…"
              mobile={isMobile}
              mentions={mentionOptions}
              onImageUpload={async (file) => {
                if (!effectiveCompanyId) throw new Error("No organization selected");
                const asset = await assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
                return asset.contentPath;
              }}
              companyId={effectiveCompanyId}
              enableReassign
              reassignOptions={assigneeOptions}
              modelAgents={modelAgents}
              agentMap={modelAgents}
              currentAssigneeValue={assigneeValue}
              assigneeAdapterOverrides={inheritedOverrides}
              onPendingAssigneeChange={(value) => {
                if (value === null) return;
                defaultAssigneePendingRef.current = false;
                const next = parseAssigneeValue(value);
                if (next.assigneeAgentId) trackRecentAssignee(next.assigneeAgentId, effectiveCompanyId ?? undefined);
                if (next.assigneeUserId) trackRecentAssigneeUser(next.assigneeUserId, effectiveCompanyId ?? undefined);
                setAssigneeValue(value);
                setComposerSettings(null);
                setAssigneeModelLane("primary");
                setAssigneeModelOverride("");
                setAssigneeThinkingEffort("");
                setAssigneeChrome(false);
                if (value && status === "backlog") setStatus("todo");
              }}
              creation={{
                value: description,
                onChange: handleDescriptionChange,
                onSubmit: handleSubmit,
                privacy: parentPrivacyUnresolved ? undefined : {
                  private: effectivePrivate,
                  inherited: inheritedPrivacyReason,
                  onChange: (checked) => {
                    setIsPrivate(checked);
                    if (!checked && currentProject?.visibility === "private") handleProjectChange("");
                    if (checked && !projectId && currentUserId) {
                      const personalProject = orderedProjects.find(project => project.personalOwnerUserId === currentUserId);
                      if (personalProject) handleProjectChange(personalProject.id);
                    }
                  },
                },
                submitLabel: isSubIssueMode ? "Create sub-task" : "Create task",
                canSubmitWithoutBody: Boolean(title.trim()),
                onSelectFiles: stageFiles,
                runSettings: composerSettings,
                onRunSettingsChange: setComposerSettings,
                header:
                  hasTitle || isSubIssueMode ? (
                    <div className="mb-3 flex flex-col gap-2 text-xs">
                      {hasTitle ? (
                        <input
                          aria-label="Task title"
                          value={title}
                          disabled={createIssue.isPending}
                          className="w-full bg-transparent text-sm text-foreground outline-none"
                          onChange={(event) => {
                            titleRef.current = event.target.value;
                            setTitle(event.target.value);
                            queueDraftSave({ title: event.target.value });
                          }}
                        />
                      ) : null}
                      {isSubIssueMode ? (
                        <div className="px-4 pb-2">
                          <div className="max-w-full rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
                            <div className="flex items-center gap-1.5">
                              <ListTree className="h-3.5 w-3.5 shrink-0" />
                              <span className="shrink-0">Sub-task of</span>
                              <span className="font-medium text-foreground">{parentIssueLabel}</span>
                            </div>
                            {newIssueDefaults.parentTitle ? (
                              <div className="pl-5 text-foreground/80 truncate">{newIssueDefaults.parentTitle}</div>
                            ) : null}
                          </div>
                        </div>
                      ) : null}
                    </div>
                  ) : undefined,
                details: (
                  <>
                    {parentPrivacyUnresolved ? (
                      <div role={parentPrivacyError ? "alert" : "status"} className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                        <span>{parentPrivacyError ? "Couldn't check parent access." : "Checking parent access…"}</span>
                        {parentPrivacyError ? <Button variant="ghost" size="sm" onClick={() => void refetchParentPrivacy()}>Retry</Button> : null}
                      </div>
                    ) : null}
                    {worktreeSelectionIncomplete && !worktreesLoading ? (
                      <p role="alert" className="mb-2 text-xs text-destructive">
                        {worktreesError ? "Couldn't check the selected worktree. Retry in Worktrees or choose New worktree."
                          : "The selected worktree is no longer available. Choose another worktree or start a new one."}
                      </p>
                    ) : null}
                    {stagedFiles.length > 0 ? (
                      <div className="mt-4 space-y-3 rounded-lg border border-border/70 p-3">
                        {stagedDocuments.length > 0 ? (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">Documents</div>
                            <div className="space-y-2">
                              {stagedDocuments.map((file) => (
                                <div
                                  key={file.id}
                                  className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <Badge
                                        variant="outline"
                                        className="border-border font-mono text-(length:--text-nano) uppercase tracking-(--tracking-eyebrow) text-muted-foreground"
                                      >
                                        {file.documentKey}
                                      </Badge>
                                      <span className="truncate text-sm">{file.file.name}</span>
                                    </div>
                                    <div className="mt-1 flex items-center gap-2 text-(length:--text-micro) text-muted-foreground">
                                      <FileText className="h-3.5 w-3.5" />
                                      <span>{file.title || file.file.name}</span>
                                      <span>•</span>
                                      <span>{formatFileSize(file.file)}</span>
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="shrink-0 text-muted-foreground"
                                    onClick={() => removeStagedFile(file.id)}
                                    disabled={createIssue.isPending}
                                    title="Remove document"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {stagedAttachments.length > 0 ? (
                          <div className="space-y-2">
                            <div className="text-xs font-medium text-muted-foreground">Attachments</div>
                            <div className="space-y-2">
                              {stagedAttachments.map((file) => (
                                <div
                                  key={file.id}
                                  className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2"
                                >
                                  <div className="min-w-0">
                                    <div className="flex items-center gap-2">
                                      <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                                      <span className="truncate text-sm">{file.file.name}</span>
                                    </div>
                                    <div className="mt-1 text-(length:--text-micro) text-muted-foreground">
                                      {file.file.type || "application/octet-stream"} • {formatFileSize(file.file)}
                                    </div>
                                  </div>
                                  <Button
                                    variant="ghost"
                                    size="icon-xs"
                                    className="shrink-0 text-muted-foreground"
                                    onClick={() => removeStagedFile(file.id)}
                                    disabled={createIssue.isPending}
                                    title="Remove attachment"
                                  >
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ))}
                            </div>
                          </div>
                        ) : null}
                      </div>
                    ) : null}
                    {assigneeValue && status === "backlog" ? (
                      <div
                        data-testid="new-issue-assigned-backlog-note"
                        className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
                      >
                        <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
                        <span className="leading-snug">
                          Assigning implies executable intent - leave status as{" "}
                          <span className="font-medium">Backlog</span> only to deliberately park this. The assignee will
                          not be woken until status moves to <span className="font-medium">Todo</span> or{" "}
                          <span className="font-medium">In Progress</span>.
                        </span>
                      </div>
                    ) : null}

                    {selectedAssigneeAgent?.status === "paused" ? (
                      <div data-testid="new-issue-paused-assignee-note" className="mx-4 mb-2">
                        <InlineBanner tone="warning" icon={PauseCircle} compact>
                          <span className="font-medium">{selectedAssigneeAgent.name}</span> is paused and will not start
                          work on this task until it is resumed
                          {selectedAssigneeAgent.pauseReason === "import"
                            ? " — it arrived paused from an organization import"
                            : ""}
                          . You can resume it from the task page after creating the task.
                        </InlineBanner>
                      </div>
                    ) : null}

                    {currentAssigneeLowTrust ? (
                      <div
                        data-testid="new-issue-low-trust-assignee-note"
                        className="mx-4 mb-2 flex items-start gap-2 rounded-md border border-amber-300/70 bg-amber-50/90 px-3 py-2 text-xs text-amber-900 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
                      >
                        <ShieldAlert className="mt-0.5 h-3.5 w-3.5 shrink-0 text-amber-600 dark:text-amber-300" />
                        <span className="leading-snug">
                          Low-trust review agent. It can only act inside its assigned review boundary; task, project, or
                          run policy defines the concrete scope.
                        </span>
                      </div>
                    ) : null}

                    {showParentWorkspaceWarning ? (
                      <div className="mb-2">
                        <InlineBanner tone="warning" compact>
                          This sub-task will no longer use the parent task workspace
                          {parentExecutionWorkspaceLabel ? ` (${parentExecutionWorkspaceLabel})` : ""}.
                        </InlineBanner>
                      </div>
                    ) : null}
                    {effectiveCompanyId && neededUserSecretKeys.length > 0 ? (
                      <MissingUserSecretsBanner companyId={effectiveCompanyId} definitionKeys={neededUserSecretKeys} />
                    ) : null}
                  </>
                ),
                submitDisabled: worktreeSelectionIncomplete || parentPrivacyUnresolved,
                contextBar: (
                  <>
                    <InlineEntitySelector
                      value={projectId}
                      options={projectOptions}
                      recentOptionIds={recentProjectIds}
                      placeholder="Project"
                      mobileTitle="Select project"
                      modal
                      className="h-8 min-w-0 flex-1 gap-1.5 border-0 bg-transparent px-2 text-xs shadow-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-0 sm:max-w-64 sm:flex-none"
                      disabled={createIssue.isPending}
                      triggerDataSlot="new-issue-compact-control"
                      contentStyle={entityPickerViewportStyle}
                      noneLabel="No project"
                      noneAtTop
                      searchPlaceholder="Search projects..."
                      emptyMessage="No projects found."
                      onChange={handleProjectChange}
                      renderTriggerValue={(option) =>
                        option && currentProject ? (
                          <>
                            <Folder className="size-3.5 shrink-0" style={{ color: currentProject.color ?? "var(--project-seed)" }} aria-hidden />
                            <span className="truncate">{option.label}</span>
                            {currentProject.visibility === "private" ? <Lock className="size-3 shrink-0 text-muted-foreground" aria-label="Private project" /> : null}
                            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                          </>
                        ) : (
                          <>
                            <Folder className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                            <span className="truncate text-muted-foreground">Project</span>
                            <ChevronDown className="size-3 shrink-0 text-muted-foreground" aria-hidden />
                          </>
                        )
                      }
                      renderOption={(option) => {
                        if (!option.id) return <><Folder className="size-4 shrink-0 text-muted-foreground" aria-hidden /><span className="truncate">{option.label}</span></>;
                        const project = orderedProjects.find((item) => item.id === option.id);
                        return (
                          <>
                            <Folder className="size-4 shrink-0" style={{ color: project?.color ?? "var(--project-seed)" }} aria-hidden />
                            <span className="min-w-0 flex-1 truncate">{option.label}</span>
                            {project?.visibility === "private" ? <Lock className="size-3.5 shrink-0 text-muted-foreground" aria-label="Private project" /> : null}
                          </>
                        );
                      }}
                    />
                    {canChooseWorktrees ? (
                      <ComposerWorktreePicker
                        mode={executionWorkspaceMode}
                        workspaceId={selectedExecutionWorkspaceId}
                        selectedWorkspaceLabel={selectedReusableWorktree?.name ?? (selectedExecutionWorkspaceId === parentExecutionWorkspaceId ? newIssueDefaults.parentExecutionWorkspaceLabel : undefined)}
                        workspaces={selectableReusableWorkspaces}
                        onChange={(mode, workspaceId) => {
                          setExecutionWorkspaceMode(mode);
                          setSelectedExecutionWorkspaceId(workspaceId);
                          if (workspaceId) {
                            const workspace = selectableReusableWorkspaces.find((entry) => entry.id === workspaceId);
                            if (workspace) setProjectWorkspaceId(workspace.projectWorkspaceId ?? "");
                          } else {
                            setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(currentProject));
                          }
                        }}
                        loading={worktreesLoading}
                        error={worktreesError}
                        onRetry={() => void refetchWorktrees()}
                        disabled={createIssue.isPending}
                        mobile={isMobile}
                        contentStyle={entityPickerViewportStyle}
                      />
                    ) : null}
                  </>
                ),
              }}
            />
          </TaskChatPresentationProvider>
        </div>
      </DialogContent>
    </Dialog>
  );
}
