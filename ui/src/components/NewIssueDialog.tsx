import { useState, useEffect, useRef, useCallback, useMemo, type ChangeEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useDialog } from "../context/DialogContext";
import { useCompany } from "../context/CompanyContext";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { agentsApi } from "../api/agents";
import { authApi } from "../api/auth";
import { assetsApi } from "../api/assets";
import { queryKeys } from "../lib/queryKeys";
import { useProjectOrder } from "../hooks/useProjectOrder";
import { getRecentAssigneeIds, sortAgentsByRecency, trackRecentAssignee } from "../lib/recent-assignees";
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
  Loader2,
} from "lucide-react";
import { cn } from "../lib/utils";
import { extractProviderIdWithFallback } from "../lib/model-utils";
import { issueStatusText, issueStatusTextDefault, priorityColor, priorityColorDefault } from "../lib/status-colors";
import { MarkdownEditor, type MarkdownEditorRef, type MentionOption } from "./MarkdownEditor";
import { AgentIcon } from "./AgentIconPicker";
import { InlineEntitySelector, type InlineEntityOption } from "./InlineEntitySelector";

const DRAFT_KEY = "paperclip:issue-draft";
const DEBOUNCE_MS = 800;
// TODO(issue-worktree-support): re-enable this UI once the workflow is ready to ship.
const SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = false;

/** Return black or white hex based on background luminance (WCAG perceptual weights). */
function getContrastTextColor(hexColor: string): string {
  const hex = hexColor.replace("#", "");
  const r = parseInt(hex.substring(0, 2), 16);
  const g = parseInt(hex.substring(2, 4), 16);
  const b = parseInt(hex.substring(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > 0.5 ? "#000000" : "#ffffff";
}

interface IssueDraft {
  title: string;
  description: string;
  status: string;
  priority: string;
  assigneeValue: string;
  assigneeId?: string;
  projectId: string;
  assigneeModelOverride: string;
  assigneeThinkingEffort: string;
  assigneeChrome: boolean;
  useIsolatedExecutionWorkspace: boolean;
}

const ISSUE_OVERRIDE_ADAPTER_TYPES = new Set(["claude_local", "codex_local", "opencode_local"]);

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
  ],
  opencode_local: [
    { value: "", label: "Default" },
    { value: "minimal", label: "Minimal" },
    { value: "low", label: "Low" },
    { value: "medium", label: "Medium" },
    { value: "high", label: "High" },
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

export function NewIssueDialog() {
  const { newIssueOpen, newIssueDefaults, closeNewIssue } = useDialog();
  const { companies, selectedCompanyId, selectedCompany } = useCompany();
  const queryClient = useQueryClient();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [status, setStatus] = useState("todo");
  const [priority, setPriority] = useState("");
  const [assigneeValue, setAssigneeValue] = useState("");
  const [projectId, setProjectId] = useState("");
  const [assigneeOptionsOpen, setAssigneeOptionsOpen] = useState(false);
  const [assigneeModelOverride, setAssigneeModelOverride] = useState("");
  const [assigneeThinkingEffort, setAssigneeThinkingEffort] = useState("");
  const [assigneeChrome, setAssigneeChrome] = useState(false);
  const [useIsolatedExecutionWorkspace, setUseIsolatedExecutionWorkspace] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [dialogCompanyId, setDialogCompanyId] = useState<string | null>(null);
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
  const attachInputRef = useRef<HTMLInputElement | null>(null);
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
  const { data: session } = useQuery({
    queryKey: queryKeys.auth.session,
    queryFn: () => authApi.getSession(),
  });
  const currentUserId = session?.user?.id ?? session?.session?.userId ?? null;
  const { orderedProjects } = useProjectOrder({
    projects: projects ?? [],
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
    mutationFn: ({ companyId, ...data }: { companyId: string } & Record<string, unknown>) =>
      issuesApi.create(companyId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: queryKeys.issues.list(effectiveCompanyId!) });
      if (draftTimer.current) clearTimeout(draftTimer.current);
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
      assigneeModelOverride,
      assigneeThinkingEffort,
      assigneeChrome,
      useIsolatedExecutionWorkspace,
    });
  }, [
    title,
    description,
    status,
    priority,
    assigneeValue,
    projectId,
    assigneeModelOverride,
    assigneeThinkingEffort,
    assigneeChrome,
    useIsolatedExecutionWorkspace,
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
      setProjectId(newIssueDefaults.projectId ?? "");
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setUseIsolatedExecutionWorkspace(false);
    } else if (draft && draft.title.trim()) {
      setTitle(draft.title);
      setDescription(draft.description);
      setStatus(draft.status || "todo");
      setPriority(draft.priority);
      setAssigneeValue(
        newIssueDefaults.assigneeAgentId || newIssueDefaults.assigneeUserId
          ? assigneeValueFromSelection(newIssueDefaults)
          : (draft.assigneeValue ?? draft.assigneeId ?? ""),
      );
      setProjectId(newIssueDefaults.projectId ?? draft.projectId);
      setAssigneeModelOverride(draft.assigneeModelOverride ?? "");
      setAssigneeThinkingEffort(draft.assigneeThinkingEffort ?? "");
      setAssigneeChrome(draft.assigneeChrome ?? false);
      setUseIsolatedExecutionWorkspace(draft.useIsolatedExecutionWorkspace ?? false);
    } else {
      setStatus(newIssueDefaults.status ?? "todo");
      setPriority(newIssueDefaults.priority ?? "");
      setProjectId(newIssueDefaults.projectId ?? "");
      setAssigneeValue(assigneeValueFromSelection(newIssueDefaults));
      setAssigneeModelOverride("");
      setAssigneeThinkingEffort("");
      setAssigneeChrome(false);
      setUseIsolatedExecutionWorkspace(false);
    }
  }, [newIssueOpen, newIssueDefaults]);

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
    setAssigneeOptionsOpen(false);
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setUseIsolatedExecutionWorkspace(false);
    setExpanded(false);
    setDialogCompanyId(null);
    setCompanyOpen(false);
    executionWorkspaceDefaultProjectId.current = null;
  }

  function handleCompanyChange(companyId: string) {
    if (companyId === effectiveCompanyId) return;
    setDialogCompanyId(companyId);
    setAssigneeValue("");
    setProjectId("");
    setAssigneeModelOverride("");
    setAssigneeThinkingEffort("");
    setAssigneeChrome(false);
    setUseIsolatedExecutionWorkspace(false);
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
    const executionWorkspacePolicy = SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI
      ? selectedProject?.executionWorkspacePolicy
      : null;
    const executionWorkspaceSettings = executionWorkspacePolicy?.enabled
      ? {
          mode: useIsolatedExecutionWorkspace ? "isolated" : "project_primary",
        }
      : null;
    createIssue.mutate({
      companyId: effectiveCompanyId,
      title: title.trim(),
      description: description.trim() || undefined,
      status,
      priority: priority || "medium",
      ...(selectedAssigneeAgentId ? { assigneeAgentId: selectedAssigneeAgentId } : {}),
      ...(selectedAssigneeUserId ? { assigneeUserId: selectedAssigneeUserId } : {}),
      ...(projectId ? { projectId } : {}),
      ...(assigneeAdapterOverrides ? { assigneeAdapterOverrides } : {}),
      ...(executionWorkspaceSettings ? { executionWorkspaceSettings } : {}),
    });
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleSubmit();
    }
  }

  async function handleAttachImage(evt: ChangeEvent<HTMLInputElement>) {
    const file = evt.target.files?.[0];
    if (!file) return;
    try {
      const asset = await uploadDescriptionImage.mutateAsync(file);
      const name = file.name || "image";
      setDescription((prev) => {
        const suffix = `![${name}](${asset.contentPath})`;
        return prev ? `${prev}\n\n${suffix}` : suffix;
      });
    } finally {
      if (attachInputRef.current) attachInputRef.current.value = "";
    }
  }

  const hasDraft = title.trim().length > 0 || description.trim().length > 0;
  const currentStatus = statuses.find((s) => s.value === status) ?? statuses[1]!;
  const currentPriority = priorities.find((p) => p.value === priority);
  const currentAssignee = selectedAssigneeAgentId
    ? (agents ?? []).find((a) => a.id === selectedAssigneeAgentId)
    : null;
  const currentProject = orderedProjects.find((project) => project.id === projectId);
  const currentProjectExecutionWorkspacePolicy = SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI
    ? currentProject?.executionWorkspacePolicy ?? null
    : null;
  const currentProjectSupportsExecutionWorkspace = Boolean(currentProjectExecutionWorkspacePolicy?.enabled);
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

  const handleProjectChange = useCallback((nextProjectId: string) => {
    setProjectId(nextProjectId);
    const nextProject = orderedProjects.find((project) => project.id === nextProjectId);
    const policy = SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI ? nextProject?.executionWorkspacePolicy : null;
    executionWorkspaceDefaultProjectId.current = nextProjectId || null;
    setUseIsolatedExecutionWorkspace(Boolean(policy?.enabled && policy.defaultMode === "isolated"));
  }, [orderedProjects]);

  useEffect(() => {
    if (!newIssueOpen || !projectId || executionWorkspaceDefaultProjectId.current === projectId) {
      return;
    }
    const project = orderedProjects.find((entry) => entry.id === projectId);
    if (!project) return;
    executionWorkspaceDefaultProjectId.current = projectId;
    setUseIsolatedExecutionWorkspace(
      Boolean(
        SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI &&
        project.executionWorkspacePolicy?.enabled &&
        project.executionWorkspacePolicy.defaultMode === "isolated",
      ),
    );
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
          "p-0 gap-0 flex flex-col max-h-[calc(100dvh-2rem)]",
          expanded
            ? "sm:max-w-2xl h-[calc(100dvh-2rem)]"
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
                  style={
                    dialogCompany?.brandColor
                      ? {
                          backgroundColor: dialogCompany.brandColor,
                          color: getContrastTextColor(dialogCompany.brandColor),
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
                              color: getContrastTextColor(c.brandColor),
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
            <span>New issue</span>
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

        {/* Title */}
        <div className="px-4 pt-4 pb-2 shrink-0">
          <textarea
            className="w-full text-lg font-semibold bg-transparent outline-none resize-none overflow-hidden placeholder:text-muted-foreground/50"
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
            <div className="inline-flex items-center gap-2 text-sm text-muted-foreground flex-wrap sm:flex-nowrap sm:min-w-max">
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
            </div>
          </div>
        </div>

        {currentProjectSupportsExecutionWorkspace && (
          <div className="px-4 pb-2 shrink-0">
            <div className="flex items-center justify-between rounded-md border border-border px-3 py-2">
              <div className="space-y-0.5">
                <div className="text-xs font-medium">Use isolated issue checkout</div>
                <div className="text-[11px] text-muted-foreground">
                  Create an issue-specific execution workspace instead of using the project's primary checkout.
                </div>
              </div>
              <button
                className={cn(
                  "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                  useIsolatedExecutionWorkspace ? "bg-green-600" : "bg-muted",
                )}
                onClick={() => setUseIsolatedExecutionWorkspace((value) => !value)}
                type="button"
              >
                <span
                  className={cn(
                    "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                    useIsolatedExecutionWorkspace ? "translate-x-4.5" : "translate-x-0.5",
                  )}
                />
              </button>
            </div>
          </div>
        )}

        {supportsAssigneeOverrides && (
          <div className="px-4 pb-2 shrink-0">
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
                {assigneeAdapterType === "claude_local" && (
                  <div className="flex items-center justify-between rounded-md border border-border px-2 py-1.5">
                    <div className="text-xs text-muted-foreground">Enable Chrome (--chrome)</div>
                    <button
                      className={cn(
                        "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                        assigneeChrome ? "bg-green-600" : "bg-muted"
                      )}
                      onClick={() => setAssigneeChrome((value) => !value)}
                    >
                      <span
                        className={cn(
                          "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                          assigneeChrome ? "translate-x-4.5" : "translate-x-0.5"
                        )}
                      />
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        {/* Description */}
        <div className={cn("px-4 pb-2 overflow-y-auto min-h-0 border-t border-border/60 pt-3", expanded ? "flex-1" : "")}>
          <MarkdownEditor
            ref={descriptionEditorRef}
            value={description}
            onChange={setDescription}
            placeholder="Add description..."
            bordered={false}
            mentions={mentionOptions}
            contentClassName={cn("text-sm text-muted-foreground pb-12", expanded ? "min-h-[220px]" : "min-h-[120px]")}
            imageUploadHandler={async (file) => {
              const asset = await uploadDescriptionImage.mutateAsync(file);
              return asset.contentPath;
            }}
          />
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

          {/* Labels chip (placeholder) */}
          <button className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground">
            <Tag className="h-3 w-3" />
            Labels
          </button>

          {/* Attach image chip */}
          <input
            ref={attachInputRef}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif"
            className="hidden"
            onChange={handleAttachImage}
          />
          <button
            className="inline-flex items-center gap-1.5 rounded-md border border-border px-2 py-1 text-xs hover:bg-accent/50 transition-colors text-muted-foreground"
            onClick={() => attachInputRef.current?.click()}
            disabled={uploadDescriptionImage.isPending}
          >
            <Paperclip className="h-3 w-3" />
            {uploadDescriptionImage.isPending ? "Uploading..." : "Image"}
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
              disabled={!title.trim() || createIssue.isPending}
              onClick={handleSubmit}
              aria-busy={createIssue.isPending}
            >
              <span className="inline-flex items-center justify-center gap-1.5">
                {createIssue.isPending ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : null}
                <span>{createIssue.isPending ? "Creating..." : "Create Issue"}</span>
              </span>
            </Button>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
