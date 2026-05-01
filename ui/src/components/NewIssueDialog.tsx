import { memo, useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent, type DragEvent, type RefObject } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { pickTextColorForSolidBg } from "@/lib/color-contrast";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { useAdapterCapabilities } from "../adapters/use-adapter-capabilities";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { accessApi } from "../api/access";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { buildCompanyUserInlineOptions, buildMarkdownMentionOptions } from "../lib/company-members";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
import { getRecentProjectIds, trackRecentProject } from "../lib/recent-projects";
import { buildExecutionPolicy } from "../lib/issue-execution-policy";
import { useToastActions } from "../context/ToastContext";
import {
  assigneeValueFromSelection,
  currentUserAssigneeOption,
  parseAssigneeValue,
} from "../lib/assignees";
import {
  Dialog,
  DialogContent,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
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
  ListTree,
  X,
  Eye,
  ShieldCheck,
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
  reviewerValue: string;
  approverValue: string;
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
}

type StagedIssueFile = {
  id: string;
  file: File;
  kind: "document" | "attachment";
  documentKey?: string;
  title?: string | null;
};

import {
  buildAssigneeAdapterOverrides,
  ISSUE_OVERRIDE_ADAPTER_TYPES,
  type IssueModelLane,
} from "../lib/issue-assignee-overrides";

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

const IssueTitleTextarea = memo(function IssueTitleTextarea({
  value,
  pending,
  assigneeValue,
  projectId,
  descriptionEditorRef,
  assigneeSelectorRef,
  projectSelectorRef,
  onChange,
}: {
  value: string;
  pending: boolean;
  assigneeValue: string;
  projectId: string;
  descriptionEditorRef: RefObject<MarkdownEditorRef | null>;
  assigneeSelectorRef: RefObject<HTMLButtonElement | null>;
  projectSelectorRef: RefObject<HTMLButtonElement | null>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <textarea
      className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50"
      placeholder="Issue title"
      rows={1}
      value={draftValue}
      onChange={(e) => {
        const nextValue = e.target.value;
        setDraftValue(nextValue);
        onChange(nextValue);
        e.target.style.height = "auto";
        e.target.style.height = `${e.target.scrollHeight}px`;
      }}
      readOnly={pending}
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
  );
});

const IssueDescriptionEditor = memo(function IssueDescriptionEditor({
  value,
  expanded,
  mentions,
  descriptionEditorRef,
  imageUploadHandler,
  onChange,
}: {
  value: string;
  expanded: boolean;
  mentions: MentionOption[];
  descriptionEditorRef: RefObject<MarkdownEditorRef | null>;
  imageUploadHandler: (file: File) => Promise<string>;
  onChange: (value: string) => void;
}) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <MarkdownEditor
      ref={descriptionEditorRef}
      value={draftValue}
      onChange={(nextValue) => {
        setDraftValue(nextValue);
        onChange(nextValue);
      }}
      placeholder="Add description..."
      bordered={false}
      mentions={mentions}
      contentClassName={cn("text-sm text-muted-foreground pb-12", expanded ? "min-h-[220px]" : "min-h-[120px]")}
      imageUploadHandler={imageUploadHandler}
    />
  );
});

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
  const { pushToast } = useToastActions();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const titleRef = useRef("");
  const descriptionRef = useRef("");
  const [titleHasText, setTitleHasText] = useState(false);
  const [draftHasText, setDraftHasText] = useState(false);
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [reviewerValue, setReviewerValue] = useState("");
  const [approverValue, setApproverValue] = useState("");
  const [showReviewerRow, setShowReviewerRow] = useState(false);
  const [showApproverRow, setShowApproverRow] = useState(false);
  const [participantMenuOpen, setParticipantMenuOpen] = useState(false);
  const [projectId, setProjectId] = useState("");
  const [projectWorkspaceId, setProjectWorkspaceId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelLane, setAssigneeModelLane] = useState<IssueModelLane>("primary");
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
  const initializationKeyRef = useRef<string | null>(null);

  const effectiveCompanyId = dialogCompanyId ?? selectedCompanyId;
  const dialogCompany = companies.find((c) => c.id === effectiveCompanyId) ?? selectedCompany;
  const isSubIssueMode = Boolean(newIssueDefaults.parentId);
  const parentIssueLabel = newIssueDefaults.parentIdentifier
    ?? (newIssueDefaults.parentId ? newIssueDefaults.parentId.slice(0, 8) : "");
  const parentExecutionWorkspaceId = newIssueDefaults.executionWorkspaceId ?? "";
  const parentExecutionWorkspaceLabel = newIssueDefaults.parentExecutionWorkspaceLabel ?? parentExecutionWorkspaceId;

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
  const { data: companyMembers } = useQuery({
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
  const getAdapterCapabilities = useAdapterCapabilities();
  const assigneeAdapterCapabilities = assigneeAdapterType
    ? getAdapterCapabilities(assigneeAdapterType)
    : null;
  const assigneeSupportsCheapLane = Boolean(
    supportsAssigneeOverrides && assigneeAdapterCapabilities?.supportsModelProfiles,
  );

  const { data: assigneeCheapProfiles } = useQuery({
    queryKey: effectiveCompanyId && assigneeAdapterType
      ? queryKeys.agents.adapterModelProfiles(effectiveCompanyId, assigneeAdapterType)
      : ["agents", "none", "adapter-model-profiles", assigneeAdapterType ?? "none"],
    queryFn: () => agentsApi.adapterModelProfiles(effectiveCompanyId!, assigneeAdapterType!),
    enabled: Boolean(effectiveCompanyId) && newIssueOpen && assigneeSupportsCheapLane,
  });
  const assigneeCheapProfile = useMemo(
    () => (assigneeCheapProfiles ?? []).find((profile) => profile.key === "cheap") ?? null,
    [assigneeCheapProfiles],
  );
  const mentionOptions = useMemo<MentionOption[]>(() => {
    return buildMarkdownMentionOptions({
      agents,
      projects: orderedProjects,
      members: companyMembers?.users,
    });
  }, [agents, companyMembers?.users, orderedProjects]);

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
  const uploadDescriptionImageHandler = useCallback(async (file: File) => {
    const asset = await uploadDescriptionImage.mutateAsync(file);
    return asset.contentPath;
  }, [uploadDescriptionImage.mutateAsync]);

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

  const setIssueText = useCallback((nextTitle: string, nextDescription: string) => {
    titleRef.current = nextTitle;
    descriptionRef.current = nextDescription;
    setTitle(nextTitle);
    setDescription(nextDescription);
    setTitleHasText(nextTitle.trim().length > 0);
    setDraftHasText(nextTitle.trim().length > 0 || nextDescription.trim().length > 0);
  }, []);

  const queueDraftSave = useCallback((overrides: { title?: string; description?: string } = {}) => {
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
      projectId,
      projectWorkspaceId,
      assigneeModelLane,
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      executionWorkspaceMode,
      selectedExecutionWorkspaceId,
    });
  }, [
    newIssueOpen,
    scheduleSave,
    status,
    priority,
    assigneeValue,
    reviewerValue,
    approverValue,
    projectId,
    projectWorkspaceId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    executionWorkspaceMode,
    selectedExecutionWorkspaceId,
  ]);

  const handleTitleChange = useCallback((nextTitle: string) => {
    titleRef.current = nextTitle;
    const nextTitleHasText = nextTitle.trim().length > 0;
    const nextDraftHasText = nextTitleHasText || descriptionRef.current.trim().length > 0;
    setTitleHasText((current) => current === nextTitleHasText ? current : nextTitleHasText);
    setDraftHasText((current) => current === nextDraftHasText ? current : nextDraftHasText);
    queueDraftSave({ title: nextTitle });
  }, [queueDraftSave]);

  const handleDescriptionChange = useCallback((nextDescription: string) => {
    descriptionRef.current = nextDescription;
    const nextDraftHasText = titleRef.current.trim().length > 0 || nextDescription.trim().length > 0;
    setDraftHasText((current) => current === nextDraftHasText ? current : nextDraftHasText);
    queueDraftSave({ description: nextDescription });
  }, [queueDraftSave]);

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
    projectId,
    projectWorkspaceId,
    assigneeModelLane,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    executionWorkspaceMode,
    selectedExecutionWorkspaceId,
    newIssueOpen,
    queueDraftSave,
  ]);

  // Restore draft or apply defaults when dialog opens
  useEffect(() => {
    if (!newIssueOpen) {
      initializationKeyRef.current = null;
      return;
    }
    const initializationKey = `${selectedCompanyId ?? ""}:${JSON.stringify(newIssueDefaults)}`;
    if (initializationKeyRef.current === initializationKey) return;
    initializationKeyRef.current = initializationKey;
    setDialogCompanyId(selectedCompanyId);
    executionWorkspaceDefaultProjectId.current = null;

    const draft = loadDraft();
    if (newIssueDefaults.parentId) {
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      const hasExplicitProjectWorkspaceId = newIssueDefaults.projectWorkspaceId !== undefined;
      const defaultProjectWorkspaceId = newIssueDefaults.projectWorkspaceId
        ?? defaultProjectWorkspaceIdForProject(defaultProject);
      const defaultExecutionWorkspaceMode = newIssueDefaults.executionWorkspaceId
        ? "reuse_existing"
        : (newIssueDefaults.executionWorkspaceMode ?? defaultExecutionWorkspaceModeForProject(defaultProject));
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
      setSelectedExecutionWorkspaceId(newIssueDefaults.executionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current = hasExplicitProjectWorkspaceId || defaultProject
        ? defaultProjectId || null
        : null;
    } else if (newIssueDefaults.title) {
      setIssueText(newIssueDefaults.title, newIssueDefaults.description ?? "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(defaultProject));
      setSelectedExecutionWorkspaceId("");
      executionWorkspaceDefaultProjectId.current = defaultProject ? defaultProjectId || null : null;
    } else if (draft && draft.title.trim()) {
      const restoredProjectId = newIssueDefaults.projectId ?? draft.projectId;
      const restoredProject = orderedProjects.find((project) => project.id === restoredProjectId);
      setIssueText(draft.title, draft.description);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId || newIssueDefaults.assigneeUserId
          ? assigneeValueFromSelection(newIssueDefaults)
          : (draft.assigneeValue ?? draft.assigneeId ?? ""),
      );
      setReviewerValue(draft.reviewerValue ?? "");
      setApproverValue(draft.approverValue ?? "");
      setShowReviewerRow(!!(draft.reviewerValue));
      setShowApproverRow(!!(draft.approverValue));
      setProjectId(restoredProjectId);
      setProjectWorkspaceId(draft.projectWorkspaceId ?? defaultProjectWorkspaceIdForProject(restoredProject));
      setAssigneeModelLane(draft.assigneeModelLane ?? "primary");
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setExecutionWorkspaceMode(
        draft.executionWorkspaceMode
          ?? (draft.useIsolatedExecutionWorkspace ? "isolated_workspace" : defaultExecutionWorkspaceModeForProject(restoredProject)),
      );
      setSelectedExecutionWorkspaceId(draft.selectedExecutionWorkspaceId ?? "");
      executionWorkspaceDefaultProjectId.current = draft.projectWorkspaceId || restoredProject
        ? restoredProjectId || null
        : null;
    } else {
      const defaultProjectId = newIssueDefaults.projectId ?? "";
      const defaultProject = orderedProjects.find((project) => project.id === defaultProjectId);
      setIssueText("", "");
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(defaultProjectId);
      setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(defaultProject));
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setReviewerValue("");
      setApproverValue("");
      setShowReviewerRow(false);
      setShowApproverRow(false);
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(defaultProject));
      setSelectedExecutionWorkspaceId("");
      executionWorkspaceDefaultProjectId.current = defaultProject ? defaultProjectId || null : null;
    }
  }, [newIssueOpen, newIssueDefaults, orderedProjects, selectedCompanyId, setIssueText]);

  useEffect(() => {
    if (!supportsAssigneeOverrides) {
      setAssigneeOptionsOpen(false);
      setAssigneeModelLane("primary");
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      return;
    }
    if (!assigneeSupportsCheapLane && assigneeModelLane === "cheap") {
      setAssigneeModelLane("primary");
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
  }, [
    supportsAssigneeOverrides,
    assigneeAdapterType,
    assigneeThinkingEffort,
    assigneeSupportsCheapLane,
    assigneeModelLane,
  ]);

  // Cleanup timer on unmount
  useEffect(() => {
    return () => {
      if (draftTimer.current) clearTimeout(draftTimer.current);
    };
  }, []);

  function reset() {
    setIssueText("", "");
    setStatus("todo");
    setPriority("");
    setAssigneeValue("");
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeOptionsOpen(false);
    setAssigneeModelLane("primary");
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
    initializationKeyRef.current = null;
  }

  function handleCompanyChange(companyId: string) {
    if (isSubIssueMode) return;
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setAssigneeValue("");
    setReviewerValue("");
    setApproverValue("");
    setShowReviewerRow(false);
    setShowApproverRow(false);
    setProjectId("");
    setProjectWorkspaceId("");
    setAssigneeModelLane("primary");
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
    const currentTitle = titleRef.current.trim();
    const currentDescription = descriptionRef.current.trim();
    if (!effectiveCompanyId || !currentTitle || createIssue.isPending) return;
    const effectiveLane = assigneeSupportsCheapLane
      ? assigneeModelLane
      : assigneeModelLane === "cheap"
        ? "primary"
        : assigneeModelLane;
    const assigneeAdapterOverrides = buildAssigneeAdapterOverrides({
      adapterType: assigneeAdapterType,
      lane: effectiveLane,
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
    const executionPolicy = buildExecutionPolicy({
      reviewerValues: reviewerValue ? [reviewerValue] : [],
      approverValues: approverValue ? [approverValue] : [],
    });
    createIssue.mutate({
      companyId: effectiveCompanyId,
      stagedFiles,
      title: currentTitle,
      description: currentDescription || undefined,
      status,
      priority: priority || "medium",
      ...(selectedAssigneeAgentId ? { assigneeAgentId: selectedAssigneeAgentId } : {}),
      ...(selectedAssigneeUserId ? { assigneeUserId: selectedAssigneeUserId } : {}),
      ...(newIssueDefaults.parentId ? { parentId: newIssueDefaults.parentId } : {}),
      ...(newIssueDefaults.goalId ? { goalId: newIssueDefaults.goalId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(projectWorkspaceId ? { projectWorkspaceId } : {}),
      ...(assigneeAdapterOverrides ? { assigneeAdapterOverrides } : {}),
      ...(executionWorkspacePolicy?.enabled ? { executionWorkspacePreference: executionWorkspaceMode } : {}),
      ...(executionWorkspaceMode === "reuse_existing" && selectedExecutionWorkspaceId
        ? { executionWorkspaceId: selectedExecutionWorkspaceId }
        : {}),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
      ...(executionPolicy ? { executionPolicy } : {}),
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

  const hasDraft = draftHasText || stagedFiles.length > 0;
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
  const isUsingParentExecutionWorkspace = isSubIssueMode && parentExecutionWorkspaceId
    ? executionWorkspaceMode === "reuse_existing" && selectedExecutionWorkspaceId === parentExecutionWorkspaceId
    : false;
  const showParentWorkspaceWarning = isSubIssueMode
    && currentProjectSupportsExecutionWorkspace
    && Boolean(parentExecutionWorkspaceId)
    && !isUsingParentExecutionWorkspace;
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
  const recentAssigneeOptionIds = useMemo(
    () => recentAssigneeIds.map((id) => assigneeValueFromSelection({ assigneeAgentId: id })),
    [recentAssigneeIds],
  );
  const recentProjectIds = useMemo(() => getRecentProjectIds(), [newIssueOpen]);
  const assigneeOptions = useMemo<InlineEntityOption[]>(
    () => [
      ...currentUserAssigneeOption(currentUserId),
      ...buildCompanyUserInlineOptions(companyMembers?.users, { excludeUserIds: [currentUserId] }),
      ...sortAgentsByRecency(
        (agents ?? []).filter((agent) => agent.status !== "terminated"),
        recentAssigneeIds,
      ).map((agent) => ({
        id: assigneeValueFromSelection({ assigneeAgentId: agent.id }),
        label: agent.name,
        searchText: `${agent.name} ${agent.role} ${agent.title ?? ""}`,
      })),
    ],
    [agents, companyMembers?.users, currentUserId, recentAssigneeIds],
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
  const savedDraft = useMemo(() => newIssueOpen ? loadDraft() : null, [newIssueOpen]);
  const hasSavedDraft = Boolean(savedDraft?.title.trim() || savedDraft?.description.trim());
  const canDiscardDraft = hasDraft || hasSavedDraft;
  const createIssueErrorMessage =
    createIssue.error instanceof Error ? createIssue.error.message : "Failed to create issue. Try again.";
  const stagedDocuments = stagedFiles.filter((file) => file.kind === "document");
  const stagedAttachments = stagedFiles.filter((file) => file.kind === "attachment");

  const handleProjectChange = useCallback((nextProjectId: string) => {
    if (nextProjectId) trackRecentProject(nextProjectId);
    setProjectId(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    executionWorkspaceDefaultProjectId.current = nextProjectId || null;
    setProjectWorkspaceId(defaultProjectWorkspaceIdForProject(nextProject));
    setExecutionWorkspaceMode(defaultExecutionWorkspaceModeForProject(nextProject));
    setSelectedExecutionWorkspaceId("");
  }, [orderedProjects]);

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
    <Dialog
      open={newIssueOpen}
      onOpenChange={(open) => {
        if (!open && !createIssue.isPending) closeNewIssue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        aria-describedby={undefined}
        className={cn(
          "flex h-[calc(100dvh-2rem)] max-h-[calc(100dvh-2rem)] flex-col gap-0 overflow-hidden p-0 sm:h-auto",
          expanded
            ? "sm:max-w-2xl sm:h-[calc(100dvh-2rem)]"
            : "sm:max-w-lg"
        )}
        onKeyDown={handleKeyDown}
        onEscapeKeyDown={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
          }
        }}
        onPointerDownOutside={(event) => {
          if (createIssue.isPending) {
            event.preventDefault();
            return;
          }
          // Radix Dialog's modal DismissableLayer calls preventDefault() on
          // pointerdown events that originate outside the Dialog DOM tree.
          // Popover portals render at the body level (outside the Dialog), so
          // touch events on popover content get their default prevented — which
          // kills scroll gesture recognition on mobile.  Telling Radix "this
          // event is handled" skips that preventDefault, restoring touch scroll.
          const target = event.detail.originalEvent.target as HTMLElement | null;
          if (target?.closest("[data-radix-popper-content-wrapper]")) {
            event.preventDefault();
          }
        }}
      >
        {/* Header bar */}
        <div className="flex items-center justify-between px-4 py-2.5 border-b border-border shrink-0">
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Popover open={companyOpen} onOpenChange={setCompanyOpen}>
              <PopoverTrigger asChild>
                <button
                  className={cn(
                    "px-1.5 py-0.5 rounded text-xs font-semibold cursor-pointer hover:opacity-80 transition-opacity",
                    !dialogCompany?.brandColor && "bg-muted",
                  )}
                  disabled={isSubIssueMode}
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
              </PopoverTrigger>
              <PopoverContent className="w-48 p-1" align="start">
                {companies.filter((c) => c.status !== "archived").map((c) => (
                  <button
                    key={c.id}
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      c.id === effectiveCompanyId && "bg-accent",
                    )}
                    onClick={() => {
                      handleCompanyChange(c.id);
                      setCompanyOpen(false);
                    }}
                  >
                    <span
                      className={cn(
                        "px-1 py-0.5 rounded text-[10px] font-semibold leading-none",
                        !c.brandColor && "bg-muted",
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
                      {c.name.slice(0, 3).toUpperCase()}
                    </span>
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </PopoverContent>
            </Popover>
            <span className="text-muted-foreground/60">&rsaquo;</span>
            <span>{isSubIssueMode ? "New sub-issue" : "New issue"}</span>
          </div>
          <div className="flex items-center gap-1">
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => setExpanded(!expanded)}
              disabled={createIssue.isPending}
            >
              {expanded ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
            </Button>
            <Button
              variant="ghost"
              size="icon-xs"
              className="text-muted-foreground"
              onClick={() => closeNewIssue()}
              disabled={createIssue.isPending}
            >
              <span className="text-lg leading-none">&times;</span>
            </Button>
          </div>
        </div>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
          {/* Title */}
          <div className="px-4 pt-4 pb-2">
            <IssueTitleTextarea
              value={title}
              pending={createIssue.isPending}
              assigneeValue={assigneeValue}
              projectId={projectId}
              descriptionEditorRef={descriptionEditorRef}
              assigneeSelectorRef={assigneeSelectorRef}
              projectSelectorRef={projectSelectorRef}
              onChange={handleTitleChange}
            />
          </div>

          <div className="px-4 pb-2">
            <div className="overflow-x-auto overscroll-x-contain">
              <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
              <span className="w-6 shrink-0 text-center">For</span>
              <InlineEntitySelector
                ref={assigneeSelectorRef}
                value={assigneeValue}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeOptionIds}
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
                        <AgentIcon icon={currentAssignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                        <span className="truncate">{option.label}</span>
                      </>
                    ) : (
                      <span className="truncate">{option.label}</span>
                    )
                  ) : (
                    <span className="text-muted-foreground">Assignee</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const assignee = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {assignee ? <AgentIcon icon={assignee.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
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
                recentOptionIds={recentProjectIds}
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
                    <span className="text-muted-foreground">Project</span>
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

              {/* Three-dot menu to add Reviewer / Approver rows */}
              <Popover open={participantMenuOpen} onOpenChange={setParticipantMenuOpen}>
                <PopoverTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex items-center justify-center rounded-md p-1 text-muted-foreground hover:bg-accent/50 transition-colors"
                    title="Add reviewer or approver"
                  >
                    <MoreHorizontal className="h-4 w-4" />
                  </button>
                </PopoverTrigger>
                <PopoverContent className="w-44 p-1" align="start">
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showReviewerRow && "bg-accent",
                    )}
                    onClick={() => {
                      setShowReviewerRow((v) => !v);
                      if (showReviewerRow) setReviewerValue("");
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <Eye className="h-3 w-3" />
                    Reviewer
                  </button>
                  <button
                    className={cn(
                      "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                      showApproverRow && "bg-accent",
                    )}
                    onClick={() => {
                      setShowApproverRow((v) => !v);
                      if (showApproverRow) setApproverValue("");
                      setParticipantMenuOpen(false);
                    }}
                  >
                    <ShieldCheck className="h-3 w-3" />
                    Approver
                  </button>
                </PopoverContent>
              </Popover>
              </div>
            </div>

            {/* Reviewer row */}
            {showReviewerRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><Eye className="h-3.5 w-3.5" /></span>
                <InlineEntitySelector
                value={reviewerValue}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeOptionIds}
                placeholder="Reviewer"
                disablePortal
                noneLabel="No reviewer"
                searchPlaceholder="Search reviewers..."
                emptyMessage="No reviewers found."
                onChange={setReviewerValue}
                renderTriggerValue={(option) =>
                  option ? (
                    <>
                      {(() => {
                        const reviewer = parseAssigneeValue(option.id).assigneeAgentId
                          ? (agents ?? []).find((a) => a.id === parseAssigneeValue(option.id).assigneeAgentId)
                          : null;
                        return reviewer ? <AgentIcon icon={reviewer.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null;
                      })()}
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Reviewer</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const reviewer = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {reviewer ? <AgentIcon icon={reviewer.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                />
              </div>
            )}

            {/* Approver row */}
            {showApproverRow && (
              <div className="flex items-center gap-2 text-sm text-muted-foreground mt-1">
                <span className="w-6 shrink-0 flex items-center justify-center"><ShieldCheck className="h-3.5 w-3.5" /></span>
                <InlineEntitySelector
                value={approverValue}
                options={assigneeOptions}
                recentOptionIds={recentAssigneeOptionIds}
                placeholder="Approver"
                disablePortal
                noneLabel="No approver"
                searchPlaceholder="Search approvers..."
                emptyMessage="No approvers found."
                onChange={setApproverValue}
                renderTriggerValue={(option) =>
                  option ? (
                    <>
                      {(() => {
                        const approver = parseAssigneeValue(option.id).assigneeAgentId
                          ? (agents ?? []).find((a) => a.id === parseAssigneeValue(option.id).assigneeAgentId)
                          : null;
                        return approver ? <AgentIcon icon={approver.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null;
                      })()}
                      <span className="truncate">{option.label}</span>
                    </>
                  ) : (
                    <span className="text-muted-foreground">Approver</span>
                  )
                }
                renderOption={(option) => {
                  if (!option.id) return <span className="truncate">{option.label}</span>;
                  const approver = parseAssigneeValue(option.id).assigneeAgentId
                    ? (agents ?? []).find((agent) => agent.id === parseAssigneeValue(option.id).assigneeAgentId)
                    : null;
                  return (
                    <>
                      {approver ? <AgentIcon icon={approver.icon} className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : null}
                      <span className="truncate">{option.label}</span>
                    </>
                  );
                }}
                />
              </div>
            )}
          </div>

          {isSubIssueMode ? (
            <div className="px-4 pb-2">
            <div className="max-w-full rounded-md border border-border bg-muted/30 px-2.5 py-1.5 text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                <ListTree className="h-3.5 w-3.5 shrink-0" />
                <span className="shrink-0">Sub-issue of</span>
                <span className="font-medium text-foreground">{parentIssueLabel}</span>
              </div>
              {newIssueDefaults.parentTitle ? (
                <div className="pl-5 text-foreground/80 truncate">
                  {newIssueDefaults.parentTitle}
                </div>
              ) : null}
            </div>
            </div>
          ) : null}

          {currentProject && currentProjectSupportsExecutionWorkspace && (
            <div className="px-4 py-3 space-y-2">
            <div className="space-y-1.5">
              <div className="text-xs font-medium">Execution workspace</div>
              <div className="text-[11px] text-muted-foreground">
                Control whether this issue runs in the shared workspace, a new isolated workspace, or an existing one.
              </div>
              <select
                className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
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
                  className="w-full rounded border border-border bg-transparent px-2 py-1.5 text-xs outline-none"
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
                <div className="text-[11px] text-muted-foreground">
                  Reusing {selectedReusableExecutionWorkspace.name} from {selectedReusableExecutionWorkspace.branchName ?? selectedReusableExecutionWorkspace.cwd ?? "existing execution workspace"}.
                </div>
              )}
              {showParentWorkspaceWarning ? (
                <div className="rounded-md border border-amber-300/60 bg-amber-50 px-2 py-1.5 text-[11px] text-amber-900 dark:border-amber-800/70 dark:bg-amber-950/30 dark:text-amber-100">
                  Warning: this sub-issue will no longer use the parent issue workspace{parentExecutionWorkspaceLabel ? ` (${parentExecutionWorkspaceLabel})` : ""}.
                </div>
              ) : null}
            </div>
            </div>
          )}

          {supportsAssigneeOverrides && (
            <div className="px-4 pb-2">
            <button
              className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
              onClick={() => setAssigneeOptionsOpen((open) => !open)}
            >
              {assigneeOptionsOpen ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
              {assigneeOptionsTitle}
            </button>
            {assigneeOptionsOpen && (
              <div className="mt-2 rounded-md border border-border p-3 bg-muted/20 space-y-3">
                <div className="space-y-1.5">
                  <div className="text-xs text-muted-foreground">Model lane</div>
                  <div
                    className="flex w-full overflow-hidden rounded-md border border-border"
                    role="radiogroup"
                    aria-label="Model lane"
                  >
                    {(["primary", ...(assigneeSupportsCheapLane ? (["cheap"] as const) : ([] as const)), "custom"] as const).map((lane) => (
                      <button
                        key={lane}
                        type="button"
                        role="radio"
                        aria-checked={assigneeModelLane === lane}
                        className={cn(
                          "flex-1 px-2 py-1 text-xs capitalize transition-colors hover:bg-accent/40",
                          assigneeModelLane === lane && "bg-accent text-foreground",
                        )}
                        onClick={() => setAssigneeModelLane(lane)}
                      >
                        {lane === "primary"
                          ? "Primary"
                          : lane === "cheap"
                            ? "Cheap"
                            : "Custom"}
                      </button>
                    ))}
                  </div>
                  {assigneeModelLane === "cheap" && (
                    <p className="text-[11px] text-muted-foreground">
                      Sends <code>modelProfile: "cheap"</code>{" "}
                      {assigneeCheapProfile?.adapterConfig && typeof (assigneeCheapProfile.adapterConfig as Record<string, unknown>).model === "string"
                        ? <>· adapter default <code>{String((assigneeCheapProfile.adapterConfig as Record<string, unknown>).model)}</code></>
                        : assigneeCheapProfile
                          ? <>· uses the agent's configured cheap profile</>
                          : <>· falls back to the primary model if no cheap profile is configured</>}
                    </p>
                  )}
                  {assigneeModelLane === "primary" && (
                    <p className="text-[11px] text-muted-foreground">Runs on the agent's primary model.</p>
                  )}
                  {assigneeModelLane === "custom" && (
                    <p className="text-[11px] text-muted-foreground">Override the model and effort for this issue only.</p>
                  )}
                </div>
                {assigneeModelLane === "custom" && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-muted-foreground">Model</div>
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
                )}
                {assigneeModelLane === "custom" && (
                  <div className="space-y-1.5">
                    <div className="text-xs text-muted-foreground">Thinking effort</div>
                    <div className="flex items-center gap-1.5 flex-wrap">
                      {thinkingEffortOptions.map((option) => (
                        <button
                          key={option.value || "default"}
                          className={cn(
                            "px-2 py-1 rounded-md text-xs border border-border hover:bg-accent/50 transition-colors",
                            assigneeThinkingEffort === option.value && "bg-accent"
                          )}
                          onClick={() => setAssigneeThinkingEffort(option.value)}
                        >
                          {option.label}
                        </button>
                      ))}
                    </div>
                  </div>
                )}
                {assigneeAdapterType === "claude_local" && assigneeModelLane === "custom" && (
                  <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                    <div className="text-xs text-muted-foreground">Enable Chrome (--chrome)</div>
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
            className="border-t border-border/60 px-4 pb-2 pt-3"
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
              <IssueDescriptionEditor
                value={description}
                expanded={expanded}
                mentions={mentionOptions}
                descriptionEditorRef={descriptionEditorRef}
                imageUploadHandler={uploadDescriptionImageHandler}
                onChange={handleDescriptionChange}
              />
            </div>
            {stagedFiles.length > 0 ? (
              <div className="mt-4 space-y-3 rounded-lg border border-border/70 p-3">
              {stagedDocuments.length > 0 ? (
                <div className="space-y-2">
                  <div className="text-xs font-medium text-muted-foreground">Documents</div>
                  <div className="space-y-2">
                    {stagedDocuments.map((file) => (
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="rounded-full border border-border px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.16em] text-muted-foreground">
                              {file.documentKey}
                            </span>
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
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
                      <div key={file.id} className="flex items-start justify-between gap-3 rounded-md border border-border/70 px-3 py-2">
                        <div className="min-w-0">
                          <div className="flex items-center gap-2">
                            <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                            <span className="truncate text-sm">{file.file.name}</span>
                          </div>
                          <div className="mt-1 text-[11px] text-muted-foreground">
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
          </div>
        </div>

        {/* Property chips bar */}
        <div className="flex items-center gap-1.5 px-4 py-2 border-t border-border flex-wrap shrink-0">
          {/* Status chip */}
          <Popover open={statusOpen} onOpenChange={setStatusOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                <CircleDot className={cn("h-3 w-3", currentStatus.color)} />
                {currentStatus.label}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {statuses.map((s) => (
                <button
                  key={s.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    s.value === status && "bg-accent"
                  )}
                  onClick={() => { setStatus(s.value); setStatusOpen(false); }}
                >
                  <CircleDot className={cn("h-3 w-3", s.color)} />
                  {s.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Priority chip */}
          <Popover open={priorityOpen} onOpenChange={setPriorityOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors">
                {currentPriority ? (
                  <>
                    <currentPriority.icon className={cn("h-3 w-3", currentPriority.color)} />
                    {currentPriority.label}
                  </>
                ) : (
                  <>
                    <Minus className="h-3 w-3 text-muted-foreground" />
                    Priority
                  </>
                )}
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-36 p-1" align="start">
              {priorities.map((p) => (
                <button
                  key={p.value}
                  className={cn(
                    "flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50",
                    p.value === priority && "bg-accent"
                  )}
                  onClick={() => { setPriority(p.value); setPriorityOpen(false); }}
                >
                  <p.icon className={cn("h-3 w-3", p.color)} />
                  {p.label}
                </button>
              ))}
            </PopoverContent>
          </Popover>

          {/* Labels chip — disabled, not wired up yet */}
          {/* <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground">
            <Tag className="h-3 w-3" />
            Labels
          </button> */}

          <input
            ref={stageFileInputRef}
            type="file"
            accept={STAGED_FILE_ACCEPT}
            className="hidden"
            onChange={handleStageFilesPicked}
            multiple
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground"
            onClick={() => stageFileInputRef.current?.click()}
            disabled={createIssue.isPending}
          >
            <Paperclip className="h-3 w-3" />
            Upload
          </button>

          {/* More (dates) */}
          <Popover open={moreOpen} onOpenChange={setMoreOpen}>
            <PopoverTrigger asChild>
              <button className="inline-flex items-center justify-center rounded-md border border-border p-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground">
                <MoreHorizontal className="h-3 w-3" />
              </button>
            </PopoverTrigger>
            <PopoverContent className="w-44 p-1" align="start">
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                Start date
              </button>
              <button className="flex items-center gap-2 w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50 text-muted-foreground">
                <Calendar className="h-3 w-3" />
                Due date
              </button>
            </PopoverContent>
          </Popover>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-4 py-2.5 border-t border-border shrink-0">
          <Button
            variant="ghost"
            size="sm"
            className="text-muted-foreground"
            onClick={discardDraft}
            disabled={createIssue.isPending || !canDiscardDraft}
          >
            Discard Draft
          </Button>
          <div className="flex items-center gap-3">
            <div className="min-h-5 text-right">
              {createIssue.isPending ? (
                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Creating issue...
                </span>
              ) : createIssue.isError ? (
                <span className="text-xs text-destructive">{createIssueErrorMessage}</span>
              ) : null}
            </div>
            <Button
              size="sm"
              className="min-w-[8.5rem] disabled:opacity-100"
              disabled={!titleHasText || createIssue.isPending}
              onClick={handleSubmit}
              aria-busy={createIssue.isPending}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{createIssue.isPending ? "Creating..." : isSubIssueMode ? "Create Sub-Issue" : "Create Issue"}</span>
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
