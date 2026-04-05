import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type DragEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pickTextColorForSolidBg } from "@/lib/color-contrast";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { useToast } from "../context/ToastContext";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "../lib/assignees";
import { Modal } from "@heroui/react";
import { Button } from "@heroui/react";
import { Popover } from "@heroui/react";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Maximize2,
  Minimize2,
  MoreHorizontal,
  ChevronRight,
  ChevronDown,
  CircleDot,
  Minus,
  ArrowUp,
  ArrowDown,
  AlertTriangle,
  Tag,
  Calendar,
  Paperclip,
  FileText,
  Loader2,
  X,
} from "lucide-react";
import { cn } from "../lib/utils";
import { extractProviderIdWithFallback } from "../lib/model-utils";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../lib/status-colors";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { AgentIcon } from "./AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";

const DRAFT_KEY = "paperclip:issue-draft";
const DEBOUNCE_MS = 800;


interface IssueDraft {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeValue: string;
  assigneeId?: string;
  projectId: string;
  projectWorkspaceId?: string;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  executionWorkspaceMode?: string;
  selectedExecutionWorkspaceId?: string;
  useIsolatedExecutionWorkspace?: boolean;
}

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);
const STAGED_FILE_ACCEPT = "image/*,application/pdf,text/plain,text/markdown,application/json,text/csv,text/html,.md,.markdown";

const ISSUE_THINKING_EFFORT_OPTIONS = {
  claude_local: [
    { value: "", label: "Default" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
  ],
  codex_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
  ],
  opencode_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
    { value: "xhigh", label: "X-High" },
    { value: "max", label: "Max" },
  ],
} as const;

function buildAssigneeAdapterOverrides(input: {
  adapterType: string | null | undefined;
  modelOverride: string;
  thinkingEffortOverride: string;
  chrome: boolean;
}): Record<string, unknown> | null {
  const adapterType = input.adapterType ?? null;
  if (!adapterType || !ISSUE_OVERRIDE_ADAPTER_TYPES.has(adapterType)) {
    return null;
  }

  const adapterConfig: Record<string, unknown> = {};
  if (input.modelOverride) adapterConfig.model = input.modelOverride;
  if (input.thinkingEffortOverride) {
    if (adapterType === "codex_local") {
      adapterConfig.modelReasoningEffort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    } else if (adapterType === "claude_local") {
      adapterConfig.effort = input.thinkingEffortOverride;
    } else if (adapterType === "opencode_local") {
      adapterConfig.variant = input.thinkingEffortOverride;
    }
  }
  if (adapterType === "claude_local" && input.chrome) {
    adapterConfig.chrome = true;
  }

  const overrides: Record<string, unknown> = {};
  if (Object.keys(adapterConfig).length > 0) {
    overrides.adapterConfig = adapterConfig;
  }
  return Object.keys(overrides).length > 0 ? overrides : null;
}

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

const statuses = [
  { value: "backlog", label: "Backlog", color: issueStatusText.backlog ?? issueStatusTextDefault },
  { value: "todo", label: "Todo", color: issueStatusText.todo ?? issueStatusTextDefault },
  { value: "in_progress", label: "In Progress", color: issueStatusText.in_progress ?? issueStatusTextDefault },
  { value: "in_review", label: "In Review", color: issueStatusText.in_review ?? issueStatusTextDefault },
  { value: "done", label: "Done", color: issueStatusText.done ?? issueStatusTextDefault },
];

const priorities = [
  { value: "critical", label: "Critical", icon: AlertTriangle, color: priorityColor.critical ?? priorityColorDefault },
  { value: "high", label: "High", icon: ArrowUp, color: priorityColor.high ?? priorityColorDefault },
  { value: "medium", label: "Medium", icon: Minus, color: priorityColor.medium ?? priorityColorDefault },
  { value: "low", label: "Low", icon: ArrowDown, color: priorityColor.low ?? priorityColorDefault },
];

const EXECUTION_WORKSPACE_MODES = [
  { value: "shared_workspace", label: "Project default" },
  { value: "isolated_workspace", label: "New isolated workspace" },
  { value: "reuse_existing", label: "Reuse existing workspace" },
] as const;

function defaultProjectWorkspaceIdForProject(project: { workspaces?: Array<{ id: string; isPrimary: boolean }>; executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null } | null | undefined) {
  if (!project) return "";
  return project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces?.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces?.[0]?.id
    ?? "";
}

function defaultExecutionWorkspaceModeForProject(project: { executionWorkspacePolicy?: { enabled?: boolean; defaultMode?: string | null } | null } | null | undefined) {
  const defaultMode = project?.executionWorkspacePolicy?.enabled ? project.executionWorkspacePolicy.defaultMode : null;
  if (
    defaultMode === "isolated_workspace" ||
    defaultMode === "operator_branch" ||
    defaultMode === "adapter_default"
  ) {
    return defaultMode === "adapter_default" ? "agent_default" : defaultMode;
  }
  return "shared_workspace";
}

function issueExecutionWorkspaceModeForExistingWorkspace(mode: string | null | undefined) {
  if (mode === "isolated_workspace" || mode === "operator_branch" || mode === "shared_workspace") {
    return mode;
  }
  if (mode === "adapter_managed" || mode === "cloud_sandbox") {
    return "agent_default";
  }
  return "shared_workspace";
}

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const { pushToast } = useToast();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [projectId, setProjectId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [executionWorkspaceMode, setExecutionWorkspaceMode] = useState<string>("shared_workspace");
  const [selectedExecutionWorkspaceId, setSelectedExecutionWorkspaceId] = useState("");
  const [expanded, setExpanded] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
  const [stagedFiles, setStagedFiles] = useState<StagedIssueFile[]>([]);
  const [isFileDragOver, setIsFileDragOver] = useState(false);
  const draftTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const executionWorkspaceDefaultProjectId = useRef<string | null>(null);

  const effectiveCompanyId = dialogCompanyId ?? selectedCompanyId;
  const dialogCompany = companies.find((c) => c.id === effectiveCompanyId) ?? selectedCompany;

  // Popover states
  const [statusOpen, setStatusOpen] = useState(false);
  const [priorityOpen, setPriorityOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const [companyOpen, setCompanyOpen] = useState(false);
  const descriptionEditorRef = useRef<MarkdownEditorRef>(null);
  const stageFileInputRef = useRef<HTMLInputElement | null>(null);
  const assigneeSelectorRef = useRef<HTMLButtonElement | null>(null);
  const projectSelectorRef = useRef<HTMLButtonElement | null>(null);

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
  const { data: reusableExecutionWorkspaces } = useQuery({
    queryKey: queryKeys.executionWorkspaces.list(effectiveCompanyId!, {
      projectId,
      projectWorkspaceId: projectWorkspaceId || undefined,
      reuseEligible: true,
    }),
    queryFn: () =>
      executionWorkspacesApi.list(effectiveCompanyId!, {
        projectId,
        projectWorkspaceId: projectWorkspaceId || undefined,
        reuseEligible: true,
      }),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && Boolean(projectId),
  });
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    enabled: newIssueOpen,
    retry: false,
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const activeProjects = useMemo(
    () => (projects ?? []).filter((p) => !p.archivedAt),
    [projects],
  );
  const { orderedProjects } = useProjectOrder({
    projects: activeProjects,
    companyId: effectiveCompanyId,
    userId: currentUserId,
  });

  const selectedAssignee = useMemo(() => parseAssigneeValue(assigneeValue), [assigneeValue]);
  const selectedAssigneeAgentId = selectedAssignee.assigneeAgentId;
  const selectedAssigneeUserId = selectedAssignee.assigneeUserId;

  const assigneeAdapterType = (agents ?? []).find((agent) => agent.id === selectedAssigneeAgentId)?.adapterType ?? null;
  const supportsAssigneeOverrides = Boolean(
    assigneeAdapterType && ISSUE_OVERRIDE_ADAPTER_TYPES.has(assigneeAdapterType),
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    const options: MentionOption[] = [];
    const activeAgents = [...(agents ?? [])]
      .filter((agent) => agent.status !== "terminated")
      .sort((a, b) => a.name.localeCompare(b.name));
    for (const agent of activeAgents) {
      options.push({
        id: `agent:${agent.id}`,
        name: agent.name,
        kind: "agent",
        agentId: agent.id,
        agentIcon: agent.icon,
      });
    }
    for (const project of orderedProjects) {
      options.push({
        id: `project:${project.id}`,
        name: project.name,
        kind: "project",
        projectId: project.id,
        projectColor: project.color,
      });
    }
    return options;
  }, [agents, orderedProjects]);

  const { data: assigneeAdapterModels } = useQuery({
    queryKey:
      effectiveCompanyId && assigneeAdapterType
        ? queryKeys.agents.adapterModels(effectiveCompanyId, assigneeAdapterType)
        : ["agents", "none", "adapter-models", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModels(effectiveCompanyId!, assigneeAdapterType!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && supportsAssigneeOverrides,
  });

  const createIssue = useMutation({
    mutationFn: async ({
      companyId,
      stagedFiles: pendingStagedFiles,
      ...data
    }: { companyId: string; stagedFiles: StagedIssueFile[] } & Record<string, unknown>) => {
      const issue = await issuesApi.create(companyId, data);
      const failures: string[] = [];

      for (const stagedFile of pendingStagedFiles) {
        try {
          if (stagedFile.kind === "document") {
            const body = await stagedFile.file.text();
            await issuesApi.upsertDocument(issue.id, stagedFile.documentKey ?? "document", {
              title: stagedFile.documentKey === "plan" ? null : stagedFile.title ?? null,
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

      return { issue, companyId, failures };
    },
    onSuccess: ({ issue, companyId, failures }) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listMineByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.listUnreadTouchedByMe(companyId) });
      queryClient.invalidateQueries({ queryKey: queryKeys.sidebarBadges(companyId) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
      if (failures.length > 0) {
        const prefix = (companies.find((company) => company.id === companyId)?.issuePrefix ?? "").trim();
        const issueRef = issue.identifier ?? issue.id;
        pushToast({
          title: `Created ${issueRef} with upload warnings`,
          body: `${failures.length} staged ${failures.length === 1 ? "file" : "files"} could not be added.`,
          tone: "warn",
          action: prefix
            ? { label: `Open ${issueRef}`, href: `/${prefix}/issues/${issueRef}` }
            : undefined,
        });
      }
      clearDraft();
      reset();
      closeNewIssue();
    },
  });

  const uploadDescriptionImage = useMutation({
    mutationFn: async (file: File) => {
      if (!effectiveCompanyId) throw new Error("No company selected");
      return assetsApi.uploadImage(effectiveCompanyId, file, "issues/drafts");
    },
  });

  // Debounced draft saving
  const scheduleSave = useCallback(
    (draft: IssueDraft) => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
      draftTimer.current = setTimeout(() => {
        if (draft.title.trim()) saveDraft(draft);
      }, DEBOUNCE_MS);
    },
    [],
  );

  // Save draft on meaningful changes
  useEffect(() => {
    if (!newIssueOpen) return;
    scheduleSave({
      title,
      description,
      status,
      priority,
      assigneeValue,
      projectId,
      projectWorkspaceId,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      executionWorkspaceMode,
      selectedExecutionWorkspaceId,
    });
  }, [
    title,
    description,
    status,
    priority,
    assigneeValue,
    projectId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    executionWorkspaceMode,
    selectedExecutionWorkspaceId,
    newIssueOpen,
    scheduleSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) return;
    setDialogCompanyId(selectedCompanyId);
    executionWorkspaceDefaultProjectId.current = null;

    const draft = loadDraft();
    if (newIssueDefaults.title) {
      setTitle(newIssueDefaults.title);
      setDescription(newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(defaultProject));
      setSelectedExecutionWorkspaceId("");
      executionWorkspaceDefaultProjectId.current = defaultProjectId || null;
    } else if (draft && draft.title.trim()) {
      const restoredProjectId = newIssueDefaults.projectId ?? draft.projectId;
      const restoredProject = orderedProjects.find((project) => project.id === restoredProjectId);
      setTitle(draft.title);
      setDescription(draft.description);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId || newIssueDefaults.assigneeUserId
          ? assigneeValueFromSelection(newIssueDefaults)
          : (draft.assigneeValue ?? draft.assigneeId ?? ""),
      );
      setProjectId(restoredProjectId);
      setProjectWorkspaceId(draft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject));
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setExecutionWorkspaceMode(
        draft.executionWorkspaceMode
          ?? (draft.useIsolatedExecutionWorkspace ? "isolated_workspace" : defaultExecutionWorkspaceModeForProject(restoredProject)),
      );
      setSelectedExecutionWorkspaceId(draft.selectedExecutionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current = restoredProjectId || null;
    } else {
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(defaultProject));
      setSelectedExecutionWorkspaceId("");
      executionWorkspaceDefaultProjectId.current = defaultProjectId || null;
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects]);

  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeOptionsOpen(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      return;
    }

    const validThinkingValues =
      assigneeAdapterType === "codex_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.codex_local
        : assigneeAdapterType === "opencode_local"
          ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
          : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
    if (!validThinkingValues.some((option) => option.value === assigneeThinkingEffort)) {
      setAssigneeThinkingEffort("");
    }
  }, [supportsAssigneeOverrides, assigneeAdapterType, assigneeThinkingEffort]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setTitle("");
    setDescription("");
    setStatus("todo");
    setPriority("");
    setAssigneeValue("");
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeOptionsOpen(false);
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setExecutionWorkspaceMode("shared_workspace");
    setSelectedExecutionWorkspaceId("");
    setExpanded(false);
    setDialogCompanyId(null);
    setStagedFiles([]);
    setIsFileDragOver(false);
    setCompanyOpen(false);
    executionWorkspaceDefaultProjectId.current = null;
  }

  function handleCompanyChange(companyId: string) {
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setAssigneeValue("");
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setExecutionWorkspaceMode("shared_workspace");
    setSelectedExecutionWorkspaceId("");
  }

  function discardDraft() {
    clearDraft();
    reset();
    closeNewIssue();
  }

  function handleSubmit() {
    if (!effectiveCompanyId || !title.trim() || createIssue.isPending) return;
    const assigneeAdapterOverrides = buildAssigneeAdapterOverrides({
      adapterType: assigneeAdapterType,
      modelOverride: assigneeModelOverride,
      thinkingEffortOverride: assigneeThinkingEffort,
      chrome: assigneeChrome,
    });
    const selectedProject = orderedProjects.find((project) => project.id === projectId);
    const executionWorkspacePolicy =
      experimentalSettings?.enableIsolatedWorkspaces === true
        ? selectedProject?.executionWorkspacePolicy ?? null
        : null;
    const selectedReusableExecutionWorkspace = deduplicatedReusableWorkspaces.find(
      (workspace) => workspace.id === selectedExecutionWorkspaceId,
    );
    const requestedExecutionWorkspaceMode =
      executionWorkspaceMode === "reuse_existing"
        ? issueExecutionWorkspaceModeForExistingWorkspace(selectedReusableExecutionWorkspace?.mode)
        : executionWorkspaceMode;
    const executionWorkspaceSettings = executionWorkspacePolicy?.enabled
      ? { mode: requestedExecutionWorkspaceMode }
      : null;
    createIssue.mutate({
      companyId: effectiveCompanyId,
      stagedFiles,
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority: priority || "medium",
      ...(selectedAssigneeAgentId ? { assigneeAgentId: selectedAssigneeAgentId } : {}),
      ...(selectedAssigneeUserId ? { assigneeUserId: selectedAssigneeUserId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
      ...(assigneeAdapterOverrides ? { assigneeAdapterOverrides } : {}),
      ...(executionWorkspacePolicy?.enabled ? { executionWorkspacePreference: executionWorkspaceMode } : {}),
      ...(executionWorkspaceMode === "reuse_existing" && selectedExecutionWorkspaceId
        ? { executionWorkspaceId: selectedExecutionWorkspaceId }
        : {}),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  function stageFiles(files: File[]) {
    if (files.length === 0) return;
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

  function handleStageFilesPicked(evt: ChangeEvent<HTMLInputElement>) {
    stageFiles(Array.from(evt.target.files ?? []));
    if (stageFileInputRef.current) {
      stageFileInputRef.current.value = "";
    }
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

  const hasDraft = title.trim().length > 0 || description.trim().length > 0 || stagedFiles.length > 0;
  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const currentPriority = priorities.find((p) => p.value === priority);
  const currentAssignee = selectedAssigneeAgentId
    ? (agents ?? []).find((a) => a.id === selectedAssigneeAgentId)
    : null;
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const currentProjectExecutionWorkspacePolicy =
    experimentalSettings?.enableIsolatedWorkspaces === true
      ? currentProject?.executionWorkspacePolicy ?? null
      : null;
  const currentProjectSupportsExecutionWorkspace = Boolean(currentProjectExecutionWorkspacePolicy?.enabled);
  const deduplicatedReusableWorkspaces = useMemo(() => {
    const workspaces = reusableExecutionWorkspaces ?? [];
    const seen = new Map<string, typeof workspaces[number]>();
    for (const ws of workspaces) {
      const key = ws.cwd ?? ws.id;
      const existing = seen.get(key);
      if (!existing || new Date(ws.lastUsedAt) > new Date(existing.lastUsedAt)) {
        seen.set(key, ws);
      }
    }
    return Array.from(seen.values());
  }, [reusableExecutionWorkspaces]);
  const selectedReusableExecutionWorkspace = deduplicatedReusableWorkspaces.find(
    (workspace) => workspace.id === selectedExecutionWorkspaceId,
  );
  const assigneeOptionsTitle =
    assigneeAdapterType === "claude_local"
      ? "Claude options"
      : assigneeAdapterType === "codex_local"
        ? "Codex options"
        : assigneeAdapterType === "opencode_local"
          ? "OpenCode options"
        : "Agent options";
  const thinkingEffortOptions =
    assigneeAdapterType === "codex_local"
      ? ISSUE_THINKING_EFFORT_OPTIONS.codex_local
      : assigneeAdapterType === "opencode_local"
        ? ISSUE_THINKING_EFFORT_OPTIONS.opencode_local
      : ISSUE_THINKING_EFFORT_OPTIONS.claude_local;
  const recentAssigneeIds = useMemo(() => getRecentAssigneeIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agents, currentUserId, recentAssigneeIds],
  );
  const projectOptions = useMemo<InlineEntityOption[]>(
    () =>
      orderedProjects.map((project) => ({
        id: project.id,
        label: project.name,
        searchText: project.description ?? "",
      })),
    [orderedProjects],
  );
  const savedDraft = loadDraft();
  const hasSavedDraft = Boolean(savedDraft?.title.trim() || savedDraft?.description.trim());
  const canDiscardDraft = hasDraft || hasSavedDraft;
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : "Failed to create issue. Try again.";
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");

  const handleProjectChange = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    executionWorkspaceDefaultProjectId.current = nextProjectId || null;
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
    setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(nextProject));
    setSelectedExecutionWorkspaceId("");
  }, [orderedProjects]);

  useEffect(() => {
    if (!newIssueOpen || !projectId || executionWorkspaceDefaultProjectId.current === projectId) {
      return;
    }
    const project = orderedProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    executionWorkspaceDefaultProjectId.current = projectId;
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(project));
    setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(project));
    setSelectedExecutionWorkspaceId("");
  }, [newIssueOpen, orderedProjects, projectId]);
  const modelOverrideOptions = useMemo<InlineEntityOption[]>(
    () => {
      return [...(assigneeAdapterModels ?? [])]
        .sort((a, b) => {
          const providerA = extractProviderIdWithFallback(a.id);
          const providerB = extractProviderIdWithFallback(b.id);
          const byProvider = providerA.localeCompare(providerB);
          if (byProvider !== 0) return byProvider;
          return a.id.localeCompare(b.id);
        })
        .map((model) => ({
          id: model.id,
          label: model.label,
          searchText: `${model.id} ${extractProviderIdWithFallback(model.id)}`,
        }));
    },
    [assigneeAdapterModels],
  );

  return (
    <Modal.Backdrop
      isOpen={newIssueOpen}
      onOpenChange={(open: boolean) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <Modal.Container size={expanded ? "lg" : "md"}>
        <Modal.Dialog>
      <div
        className={cn(
          "p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)]",
          expanded
            ? "h-[calc(100dvh-2rem)]"
            : ""
        )}
        onKeyDown={handleKeyDown}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-default-200/60 shrink-0">
          <div className="flex items-center gap-2 text-sm">
            <Popover isOpen={companyOpen} onOpenChange={setCompanyOpen}>
              <Popover.Trigger>
                <button
                  className={cn(
                    "px-2 py-0.5 rounded-md text-xs font-semibold tracking-wide cursor-pointer hover:opacity-80 transition-opacity",
                    !dialogCompany?.brandColor && "bg-accent/15 text-accent",
                  )}
                  style={
                    dialogCompany?.brandColor
                      ? {
                          backgroundColor: dialogCompany.brandColor,
                          color: pickTextColorForSolidBg(dialogCompany.brandColor),
                        }
                      : undefined
                  }
                >
                  {(dialogCompany?.name ?? "").slice(0, 3).toUpperCase()}
                </button>
              </Popover.Trigger>
              <Popover.Content className="w-52 overflow-hidden p-0">
                <Popover.Dialog className="bg-overlay shadow-lg">
                  {companies.filter((c) => c.status !== "archived").map((c) => (
                    <button
                      key={c.id}
                      className={cn(
                        "flex items-center gap-2.5 w-full px-3 py-2 text-xs transition-colors",
                        c.id === effectiveCompanyId
                          ? "bg-accent/15 text-accent font-medium"
                          : "text-foreground hover:bg-default/40",
                      )}
                      onClick={() => {
                        handleCompanyChange(c.id);
                        setCompanyOpen(false);
                      }}
                    >
                      <span
                        className={cn(
                          "flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-[10px] font-bold leading-none",
                          !c.brandColor && "bg-accent/15 text-accent",
                        )}
                        style={
                          c.brandColor
                            ? {
                                backgroundColor: c.brandColor,
                                color: pickTextColorForSolidBg(c.brandColor),
                              }
                            : undefined
                        }
                      >
                        {c.name.charAt(0).toUpperCase()}
                      </span>
                      <span className="truncate">{c.name}</span>
                    </button>
                  ))}
                </Popover.Dialog>
              </Popover.Content>
            </Popover>
            <span className="text-foreground/30">/</span>
            <span className="text-foreground/60 font-medium">New issue</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              isIconOnly
              size="sm"
              className="text-foreground/40"
              onPress={() => setExpanded(!expanded)}
              isDisabled={createIssue.isPending}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              isIconOnly
              size="sm"
              className="text-foreground/40"
              onPress={() => closeNewIssue()}
              isDisabled={createIssue.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <textarea
            className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-foreground/50"
            placeholder="Issue title"
            rows={1}
            value={title}
            onChange={(e) => {
              setTitle(e.target.value);
              e.target.style.height = "auto";
              e.target.style.height = `${e.target.scrollHeight}px`;
            }}
            readOnly={createIssue.isPending}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.metaKey &&
                !e.ctrlKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                descriptionEditorRef.current?.focus();
              }
              if (e.key === "Tab" && !e.shiftKey) {
                e.preventDefault();
                if (assigneeValue) {
                  // Assignee already set — skip to project or description
                  if (projectId) {
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

        <div className="px-4 pb-2 shrink-0">
          <div className="overflow-x-auto overscroll-x-contain">
            <div className="inline-flex items-center gap-2 text-sm text-foreground/40 flex-wrap sm:flex-nowrap sm:min-w-max">
              <span>For</span>
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={assigneeValue}
                options={assigneeOptions}
                placeholder="Assignee"
                disablePortal
                noneLabel="No assignee"
                searchPlaceholder="Search assignees..."
                emptyMessage="No assignees found."
                onChange={(value) => {
                  const nextAssignee = parseAssigneeValue(value);
                  if (nextAssignee.assigneeAgentId) {
                    trackRecentAssignee(nextAssignee.assigneeAgentId);
                  }
                  setAssigneeValue(value);
                }}
                onConfirm={() => {
                  if (projectId) {
                    descriptionEditorRef.current?.focus();
                  } else {
                    projectSelectorRef.current?.focus();
                  }
                }}
                renderTriggerValue={(option) =>
                  option ? (
                    currentAssignee ? (
                      <>
                        <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-foreground/40">Assignee</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-foreground/40" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
              <span>in</span>
              <InlineEntitySelector
                ref={projectSelectorRef}
                value={projectId}
                options={projectOptions}
                placeholder="Project"
                disablePortal
                noneLabel="No project"
                searchPlaceholder="Search projects..."
                emptyMessage="No projects found."
                onChange={handleProjectChange}
                onConfirm={() => {
                  descriptionEditorRef.current?.focus();
                }}
                renderTriggerValue={(option) =>
                  option && currentProject ? (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: currentProject.color ?? "#6366f1" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-foreground/40">Project</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const project = orderedProjects.find((item) => item.id === option.id);
                  return (
                    <>
                      <span
                        className="h-3.5 w-3.5 shrink-0 rounded-sm"
                        style={{ backgroundColor: project?.color ?? "#6366f1" }}
                      />
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
              />
            </div>
          </div>
        </div>

        {currentProject && currentProjectSupportsExecutionWorkspace && (
          <div className="px-4 py-3 shrink-0 space-y-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Execution workspace</div>
              <div className="text-[11px] text-foreground/40">
                Control whether this issue runs in the shared workspace, a new isolated workspace, or an existing one.
              </div>
              <select
                className="w-full rounded border border-default-200/40 bg-transparent px-2 py-1.5 text-xs outline-none"
                value={executionWorkspaceMode}
                onChange={(e) => {
                  setExecutionWorkspaceMode(e.target.value);
                  if (e.target.value !== "reuse_existing") {
                    setSelectedExecutionWorkspaceId("");
                  }
                }}
              >
                {EXECUTION_WORKSPACE_MODES.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              {executionWorkspaceMode === "reuse_existing" && (
                <select
                  className="w-full rounded border border-default-200/40 bg-transparent px-2 py-1.5 text-xs outline-none"
                  value={selectedExecutionWorkspaceId}
                  onChange={(e) => setSelectedExecutionWorkspaceId(e.target.value)}
                >
                  <option value="">Choose an existing workspace</option>
                  {deduplicatedReusableWorkspaces.map((workspace) => (
                    <option key={workspace.id} value={workspace.id}>
                      {workspace.name} · {workspace.status} · {workspace.branchName ?? workspace.cwd ?? workspace.id.slice(0, 8)}
                    </option>
                  ))}
                </select>
              )}
              {executionWorkspaceMode === "reuse_existing" && selectedReusableExecutionWorkspace && (
                <div className="text-[11px] text-foreground/40">
                  Reusing {selectedReusableExecutionWorkspace.name} from {selectedReusableExecutionWorkspace.branchName ?? selectedReusableExecutionWorkspace.cwd ?? "existing execution workspace"}.
                </div>
              )}
            </div>
          </div>
        )}

        {supportsAssigneeOverrides && (
          <div className="px-4 pb-2 shrink-0">
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/40 hover:text-foreground transition-colors"
              onClick={() => setAssigneeOptionsOpen((open) => !open)}
            >
              {assigneeOptionsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {assigneeOptionsTitle}
            </button>
            {assigneeOptionsOpen && (
              <div className="mt-2 rounded-md border border-default-200/40 p-3 bg-muted/20 space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs text-foreground/40">Model</div>
                  <InlineEntitySelector
                    value={assigneeModelOverride}
                    options={modelOverrideOptions}
                    placeholder="Default model"
                    disablePortal
                    noneLabel="Default model"
                    searchPlaceholder="Search models..."
                    emptyMessage="No models found."
                    onChange={setAssigneeModelOverride}
                  />
                </div>
                <div className="space-y-1.5">
                  <div className="text-xs text-foreground/40">Thinking effort</div>
                  <div className="flex items-center gap-1.5 flex-wrap">
                    {thinkingEffortOptions.map((option) => (
                      <button
                        key={option.value || "default"}
                        className={cn(
                          "px-2 py-1 rounded-md text-xs border border-default-200/40 hover:bg-accent/[0.05] transition-colors",
                          assigneeThinkingEffort === option.value && "bg-accent/10 text-accent font-medium"
                        )}
                        onClick={() => setAssigneeThinkingEffort(option.value)}
                      >
                        {option.label}
                      </button>
                    ))}
                  </div>
                </div>
                {assigneeAdapterType === "claude_local" && (
                  <div className="flex items-center justify-between rounded-md border border-default-200/40 px-2 py-1.5">
                    <div className="text-xs text-foreground/40">Enable Chrome (--chrome)</div>
                    <ToggleSwitch
                      checked={assigneeChrome}
                      onCheckedChange={() => setAssigneeChrome((value) => !value)}
                    />
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Description */}
        <div
          className={cn("px-4 pb-2 overflow-y-auto min-h-0 border-t border-default-200/60 pt-3", expanded ? "flex-1" : "")}
          onDragEnter={handleFileDragEnter}
          onDragOver={handleFileDragOver}
          onDragLeave={handleFileDragLeave}
          onDrop={handleFileDrop}
        >
          <div
            className={cn(
              "rounded-md transition-colors",
              isFileDragOver && "bg-accent/20",
            )}
          >
            <MarkdownEditor
              ref={descriptionEditorRef}
              value={description}
              onChange={setDescription}
              placeholder="Add description..."
              bordered={false}
              mentions={mentionOptions}
              contentClassName={cn("text-sm text-foreground/40 pb-12", expanded ? "min-h-[220px]" : "min-h-[120px]")}
              imageUploadHandler={async (file) => {
                const asset = await uploadDescriptionImage.mutateAsync(file);
                return asset.contentPath;
              }}
            />
          </div>
          {stagedFiles.length > 0 ? (
            <div className="mt-4 space-y-3 rounded-lg border border-default-200/70 p-3">
              {stagedDocuments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-foreground/40">Documents</div>
                  <div className="space-y-2">
                    {stagedDocuments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-default-200/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full border border-default-200/40 px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-foreground/40">
                              {file.documentKey}
                            </span>
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-foreground/40">
                            <FileText className="h-3.5 w-3.5" />
                            <span>{file.title || file.file.name}</span>
                            <span>•</span>
                            <span>{formatFileSize(file.file)}</span>
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          isIconOnly
                          size="sm"
                          className="shrink-0 text-foreground/40"
                          onPress={() => removeStagedFile(file.id)}
                          isDisabled={createIssue.isPending}
                          aria-label="Remove document"
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
                  <div className="text-xs font-medium text-foreground/40">Attachments</div>
                  <div className="space-y-2">
                    {stagedAttachments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-default-200/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-foreground/40" />
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-foreground/40">
                            {file.file.type || "application/octet-stream"} • {formatFileSize(file.file)}
                          </div>
                        </div>
                        <Button
                          variant="ghost"
                          isIconOnly
                          size="sm"
                          className="shrink-0 text-foreground/40"
                          onPress={() => removeStagedFile(file.id)}
                          isDisabled={createIssue.isPending}
                          aria-label="Remove attachment"
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
        </div>

        {/* Property chips bar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-default-200/40 flex-wrap shrink-0">
          {/* Status chip */}
          <Popover isOpen={statusOpen} onOpenChange={setStatusOpen}>
            <Popover.Trigger>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors">
                <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
                {currentStatus.label}
              </button>
            </Popover.Trigger>
            <Popover.Content className="w-40 p-0">
              <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5">
                {statuses.map((s) => (
                  <button
                    key={s.value}
                    className={cn(
                      "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg transition-colors",
                      s.value === status
                        ? "bg-accent/[0.08] text-accent font-medium"
                        : "text-foreground hover:bg-default/40"
                    )}
                    onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                  >
                    <CircleDot className={cn("h-3 w-3", s.color)} />
                    {s.label}
                  </button>
                ))}
              </Popover.Dialog>
            </Popover.Content>
          </Popover>

          {/* Priority chip */}
          <Popover isOpen={priorityOpen} onOpenChange={setPriorityOpen}>
            <Popover.Trigger>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors">
                {currentPriority ? (
                  <>
                    <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
                    {currentPriority.label}
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-foreground/40" />
                    Priority
                  </>
                )}
              </button>
            </Popover.Trigger>
            <Popover.Content className="w-40 p-0">
              <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5">
                {priorities.map((p) => (
                  <button
                    key={p.value}
                    className={cn(
                      "flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg transition-colors",
                      p.value === priority
                        ? "bg-accent/[0.08] text-accent font-medium"
                        : "text-foreground hover:bg-default/40"
                    )}
                    onClick={() => { setPriority(p.value); setPriorityOpen(false); }}
                  >
                    <p.icon className={cn("h-3 w-3", p.color)} />
                    {p.label}
                  </button>
                ))}
              </Popover.Dialog>
            </Popover.Content>
          </Popover>

          {/* Labels chip (placeholder) */}
          <button className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors text-foreground/40">
            <Tag className="h-3 w-3" />
            Labels
          </button>

          <input
            ref={stageFileInputRef}
            type="file"
            accept={STAGED_FILE_ACCEPT}
            className="hidden"
            onChange={handleStageFilesPicked}
            multiple
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-default-200/40 px-2 py-1 text-xs hover:bg-accent/[0.05] transition-colors text-foreground/40"
            onClick={() => stageFileInputRef.current?.click()}
            disabled={createIssue.isPending}
          >
            <Paperclip className="h-3 w-3" />
            Upload
          </button>

          {/* More (dates) */}
          <Popover isOpen={moreOpen} onOpenChange={setMoreOpen}>
            <Popover.Trigger>
              <button className="inline-flex items-center justify-center rounded-md border border-default-200/40 p-1 text-xs hover:bg-accent/[0.05] transition-colors text-foreground/40">
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </Popover.Trigger>
            <Popover.Content className="w-44 p-0">
              <Popover.Dialog className="overflow-hidden rounded-xl border border-default-200/60 bg-overlay shadow-lg p-1.5">
                <button className="flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg text-foreground hover:bg-default/40 transition-colors">
                  <Calendar className="h-3 w-3 text-foreground/40" />
                  Start date
                </button>
                <button className="flex items-center gap-2 w-full px-2.5 py-2 text-xs rounded-lg text-foreground hover:bg-default/40 transition-colors">
                  <Calendar className="h-3 w-3 text-foreground/40" />
                  Due date
                </button>
              </Popover.Dialog>
            </Popover.Content>
          </Popover>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-default-200/40 shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-foreground/40"
            onPress={discardDraft}
            isDisabled={createIssue.isPending || !canDiscardDraft}
          >
            Discard Draft
          </Button>
          <div className="flex items-center gap-3">
            <div className="min-h-5 text-right">
              {createIssue.isPending ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-foreground/40">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Creating issue...
                </span>
              ) : createIssue.isError ? (
                <span className="text-xs text-danger">{createIssueErrorMessage}</span>
              ) : null}
            </div>
            <Button
              size="sm"
              className="min-w-[8.5rem] disabled:opacity-100"
              isDisabled={!title.trim() || createIssue.isPending}
              onPress={handleSubmit}
              aria-busy={createIssue.isPending}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{createIssue.isPending ? "Creating..." : "Create Issue"}</span>
              </span>
            </Button>
          </div>
        </div>
      </div>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
