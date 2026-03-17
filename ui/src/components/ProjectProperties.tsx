import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate } from "../lib/utils";
import { goalsApi } from "../api/goals";
import { projectsApi } from "../api/projects";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import {
  getWorkspaceExecutionWarning,
  getWorkspaceHealthLabel,
  getWorkspaceHealthTone,
  hasWorkspaceLocalFolder,
} from "../lib/workspace-health";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Check, ExternalLink, Github, Loader2, Plus, Trash2, X } from "lucide-react";
import { ChoosePathButton } from "./PathInstructionsModal";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";

const PROJECT_STATUSES = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

// TODO(issue-worktree-support): re-enable this UI once the workflow is ready to ship.
const SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI = false;

interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
}

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";
export type ProjectConfigFieldKey =
  | "name"
  | "description"
  | "status"
  | "goals"
  | "execution_workspace_enabled"
  | "execution_workspace_default_mode"
  | "execution_workspace_base_ref"
  | "execution_workspace_branch_template"
  | "execution_workspace_worktree_parent_dir"
  | "execution_workspace_provision_command"
  | "execution_workspace_teardown_command";

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

function SaveIndicator({ state }: { state: ProjectFieldSaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
        <AlertCircle className="h-3 w-3" />
        Failed
      </span>
    );
  }
  return null;
}

function FieldLabel({
  label,
  state,
}: {
  label: string;
  state: ProjectFieldSaveState;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SaveIndicator state={state} />
    </div>
  );
}

function PropertyRow({
  label,
  children,
  alignStart = false,
  valueClassName = "",
}: {
  label: React.ReactNode;
  children: React.ReactNode;
  alignStart?: boolean;
  valueClassName?: string;
}) {
  return (
    <div className={cn("flex gap-3 py-1.5", alignStart ? "items-start" : "items-center")}>
      <div className="shrink-0 w-20">{label}</div>
      <div className={cn("min-w-0 flex-1", alignStart ? "pt-0.5" : "flex items-center gap-1.5", valueClassName)}>
        {children}
      </div>
    </div>
  );
}

function workspaceHealthBadgeClassName(tone: "healthy" | "warning" | "muted") {
  if (tone === "healthy") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (tone === "warning") return "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted text-muted-foreground";
}

function ProjectStatusPicker({ status, onChange }: { status: string; onChange: (status: string) => void }) {
  const [open, setOpen] = useState(false);
  const colorClass = statusBadge[status] ?? statusBadgeDefault;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer hover:opacity-80 transition-opacity",
            colorClass,
          )}
        >
          {status.replace("_", " ")}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-40 p-1" align="start">
        {PROJECT_STATUSES.map((s) => (
          <Button
            key={s.value}
            variant="ghost"
            size="sm"
            className={cn("w-full justify-start gap-2 text-xs", s.value === status && "bg-accent")}
            onClick={() => {
              onChange(s.value);
              setOpen(false);
            }}
          >
            {s.label}
          </Button>
        ))}
      </PopoverContent>
    </Popover>
  );
}

export function ProjectProperties({ project, onUpdate, onFieldUpdate, getFieldSaveState }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [executionWorkspaceAdvancedOpen, setExecutionWorkspaceAdvancedOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "repo" | null>(null);
  const [workspaceTargetId, setWorkspaceTargetId] = useState<string | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    if (onFieldUpdate) {
      onFieldUpdate(field, data);
      return;
    }
    onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState => getFieldSaveState?.(field) ?? "idle";

  const { data: allGoals } = useQuery({
    queryKey: queryKeys.goals.list(selectedCompanyId!),
    queryFn: () => goalsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId,
  });

  const linkedGoalIds = project.goalIds.length > 0
    ? project.goalIds
    : project.goalId
      ? [project.goalId]
      : [];

  const linkedGoals = project.goals.length > 0
    ? project.goals
    : linkedGoalIds.map((id) => ({
        id,
        title: allGoals?.find((g) => g.id === id)?.title ?? id.slice(0, 8),
      }));

  const availableGoals = (allGoals ?? []).filter((g) => !linkedGoalIds.includes(g.id));
  const workspaces = project.workspaces ?? [];
  const executionWorkspacePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorkspacesEnabled = executionWorkspacePolicy?.enabled === true;
  const executionWorkspaceDefaultMode =
    executionWorkspacePolicy?.defaultMode === "isolated" ? "isolated" : "project_primary";
  const executionWorkspaceStrategy = executionWorkspacePolicy?.workspaceStrategy ?? {
    type: "git_worktree",
    baseRef: "",
    branchTemplate: "",
    worktreeParentDir: "",
  };

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(selectedCompanyId) });
    }
  };

  const createWorkspace = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.createWorkspace(project.id, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceTargetId(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: invalidateProject,
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, workspaceId, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceTargetId(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeGoal = (goalId: string) => {
    if (!onUpdate && !onFieldUpdate) return;
    commitField("goals", { goalIds: linkedGoalIds.filter((id) => id !== goalId) });
  };

  const addGoal = (goalId: string) => {
    if ((!onUpdate && !onFieldUpdate) || linkedGoalIds.includes(goalId)) return;
    commitField("goals", { goalIds: [...linkedGoalIds, goalId] });
    setGoalOpen(false);
  };

  const updateExecutionWorkspacePolicy = (patch: Record<string, unknown>) => {
    if (!onUpdate && !onFieldUpdate) return;
    return {
      executionWorkspacePolicy: {
        enabled: executionWorkspacesEnabled,
        defaultMode: executionWorkspaceDefaultMode,
        allowIssueOverride: executionWorkspacePolicy?.allowIssueOverride ?? true,
        ...executionWorkspacePolicy,
        ...patch,
      },
    };
  };

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const isGitHubRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      const host = parsed.hostname.toLowerCase();
      if (host !== "github.com" && host !== "www.github.com") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const deriveWorkspaceNameFromPath = (value: string) => {
    const normalized = value.trim().replace(/[\\/]+$/, "");
    const segments = normalized.split(/[\\/]/).filter(Boolean);
    return segments[segments.length - 1] ?? "Local folder";
  };

  const deriveWorkspaceNameFromRepo = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      const repo = segments[segments.length - 1]?.replace(/\.git$/i, "") ?? "";
      return repo || "GitHub repo";
    } catch {
      return "GitHub repo";
    }
  };

  const formatGitHubRepo = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 2) return value;
      const owner = segments[0];
      const repo = segments[1]?.replace(/\.git$/i, "");
      if (!owner || !repo) return value;
      return `${owner}/${repo}`;
    } catch {
      return value;
    }
  };

  const submitLocalWorkspace = () => {
    const cwd = workspaceCwd.trim();
    if (!isAbsolutePath(cwd)) {
      setWorkspaceError("Local folder must be a full absolute path.");
      return;
    }
    setWorkspaceError(null);
    if (workspaceTargetId) {
      updateWorkspace.mutate({
        workspaceId: workspaceTargetId,
        data: { cwd },
      });
      return;
    }
    createWorkspace.mutate({
      name: deriveWorkspaceNameFromPath(cwd),
      cwd,
    });
  };

  const submitRepoWorkspace = () => {
    const repoUrl = workspaceRepoUrl.trim();
    if (!isGitHubRepoUrl(repoUrl)) {
      setWorkspaceError("Repo workspace must use a valid GitHub repo URL.");
      return;
    }
    setWorkspaceError(null);
    if (workspaceTargetId) {
      updateWorkspace.mutate({
        workspaceId: workspaceTargetId,
        data: { repoUrl },
      });
      return;
    }
    createWorkspace.mutate({
      name: deriveWorkspaceNameFromRepo(repoUrl),
      cwd: REPO_ONLY_CWD_SENTINEL,
      repoUrl,
    });
  };

  const beginWorkspaceAction = (mode: "local" | "repo", workspaceId: string | null = null) => {
    setWorkspaceMode(mode);
    setWorkspaceTargetId(workspaceId);
    setWorkspaceError(null);
    setWorkspaceCwd("");
    setWorkspaceRepoUrl("");
  };

  const cancelWorkspaceAction = () => {
    setWorkspaceMode(null);
    setWorkspaceTargetId(null);
    setWorkspaceCwd("");
    setWorkspaceRepoUrl("");
    setWorkspaceError(null);
  };

  const workspaceMutationPending = createWorkspace.isPending || updateWorkspace.isPending;

  const clearLocalWorkspace = (workspace: Project["workspaces"][number]) => {
    const confirmed = window.confirm(
      workspace.repoUrl
        ? "Clear local folder from this workspace?"
        : "Delete this workspace local folder?",
    );
    if (!confirmed) return;
    if (workspace.repoUrl) {
      updateWorkspace.mutate({
        workspaceId: workspace.id,
        data: { cwd: null },
      });
      return;
    }
    removeWorkspace.mutate(workspace.id);
  };

  const clearRepoWorkspace = (workspace: Project["workspaces"][number]) => {
    const hasLocalFolder = Boolean(workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL);
    const confirmed = window.confirm(
      hasLocalFolder
        ? "Clear GitHub repo from this workspace?"
        : "Delete this workspace repo?",
    );
    if (!confirmed) return;
    if (hasLocalFolder) {
      updateWorkspace.mutate({
        workspaceId: workspace.id,
        data: { repoUrl: null, repoRef: null },
      });
      return;
    }
    removeWorkspace.mutate(workspace.id);
  };

  const setPrimaryWorkspace = (workspace: Project["workspaces"][number]) => {
    if (workspace.isPrimary) return;
    updateWorkspace.mutate({
      workspaceId: workspace.id,
      data: { isPrimary: true },
    });
  };

  return (
    <div>
      <div className="space-y-1 pb-4">
        <PropertyRow label={<FieldLabel label="Name" state={fieldState("name")} />}>
          {onUpdate || onFieldUpdate ? (
            <DraftInput
              value={project.name}
              onCommit={(name) => commitField("name", { name })}
              immediate
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none"
              placeholder="Project name"
            />
          ) : (
            <span className="text-sm">{project.name}</span>
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label="Description" state={fieldState("description")} />}
          alignStart
          valueClassName="space-y-0.5"
        >
          {onUpdate || onFieldUpdate ? (
            <InlineEditor
              value={project.description ?? ""}
              onSave={(description) => commitField("description", { description })}
              as="p"
              className="text-sm text-muted-foreground"
              placeholder="Add a description..."
              multiline
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {project.description?.trim() || "No description"}
            </p>
          )}
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Status" state={fieldState("status")} />}>
          {onUpdate || onFieldUpdate ? (
            <ProjectStatusPicker
              status={project.status}
              onChange={(status) => commitField("status", { status })}
            />
          ) : (
            <StatusBadge status={project.status} />
          )}
        </PropertyRow>
        {project.leadAgentId && (
          <PropertyRow label="Lead">
            <span className="text-sm font-mono">{project.leadAgentId.slice(0, 8)}</span>
          </PropertyRow>
        )}
        <PropertyRow
          label={<FieldLabel label="Goals" state={fieldState("goals")} />}
          alignStart
          valueClassName="space-y-2"
        >
          {linkedGoals.length === 0 ? (
            <span className="text-sm text-muted-foreground">None</span>
          ) : (
            <div className="flex flex-wrap gap-1.5">
              {linkedGoals.map((goal) => (
                <span
                  key={goal.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                >
                  <Link to={`/goals/${goal.id}`} className="hover:underline max-w-[220px] truncate">
                    {goal.title}
                  </Link>
                  {(onUpdate || onFieldUpdate) && (
                    <button
                      className="text-muted-foreground hover:text-foreground"
                      type="button"
                      onClick={() => removeGoal(goal.id)}
                      aria-label={`Remove goal ${goal.title}`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                  )}
                </span>
              ))}
            </div>
          )}
          {(onUpdate || onFieldUpdate) && (
            <Popover open={goalOpen} onOpenChange={setGoalOpen}>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 w-fit px-2"
                  disabled={availableGoals.length === 0}
                >
                  <Plus className="h-3 w-3 mr-1" />
                  Goal
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="start">
                {availableGoals.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    All goals linked.
                  </div>
                ) : (
                  availableGoals.map((goal) => (
                    <button
                      key={goal.id}
                      className="flex items-center w-full px-2 py-1.5 text-xs rounded hover:bg-accent/50"
                      onClick={() => addGoal(goal.id)}
                    >
                      {goal.title}
                    </button>
                  ))
                )}
              </PopoverContent>
            </Popover>
          )}
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Created" state="idle" />}>
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label="Updated" state="idle" />}>
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
        {project.targetDate && (
          <PropertyRow label={<FieldLabel label="Target Date" state="idle" />}>
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      <Separator className="my-4" />

      <div className="space-y-1 py-4">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Workspaces</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label="Workspaces help"
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Workspaces give your agents hints about where the work is
              </TooltipContent>
            </Tooltip>
          </div>
          {workspaces.length === 0 ? (
            <p className="rounded-md border border-dashed border-border px-3 py-2 text-sm text-muted-foreground">
              No workspace configured.
            </p>
          ) : (
            <div className="space-y-1">
              {workspaces.map((workspace) => {
                const healthTone = getWorkspaceHealthTone(workspace);
                const executionWarning = getWorkspaceExecutionWarning(workspace.isPrimary ? workspace : null);
                return (
                  <div key={workspace.id} className="space-y-2 rounded-md border border-border/70 px-2 py-2">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs font-medium">{workspace.name}</span>
                      {workspace.isPrimary ? (
                        <Badge variant="outline" className="border-sky-500/30 bg-sky-500/10 text-[10px] text-sky-700 dark:text-sky-300">
                          Primary
                        </Badge>
                      ) : null}
                      <Badge
                        variant="outline"
                        className={cn("text-[10px]", workspaceHealthBadgeClassName(healthTone))}
                      >
                        {getWorkspaceHealthLabel(workspace)}
                      </Badge>
                      {workspace.repoUrl ? (
                        <Badge variant="outline" className="text-[10px]">
                          GitHub linked
                        </Badge>
                      ) : null}
                      {!workspace.isPrimary ? (
                        <Button
                          variant="outline"
                          size="xs"
                          className="ml-auto h-5 px-1.5 text-[10px]"
                          disabled={updateWorkspace.isPending}
                          onClick={() => setPrimaryWorkspace(workspace)}
                        >
                          {updateWorkspace.isPending ? (
                            <>
                              <Loader2 className="mr-1 h-3 w-3 animate-spin" />
                              Saving
                            </>
                          ) : (
                            "Make primary"
                          )}
                        </Button>
                      ) : null}
                    </div>
                    {workspace.cwd && workspace.cwd !== REPO_ONLY_CWD_SENTINEL ? (
                      <div className="flex items-center justify-between gap-2 py-1">
                        <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{workspace.cwd}</span>
                        <Button
                          variant="ghost"
                          size="icon-xs"
                          onClick={() => clearLocalWorkspace(workspace)}
                          aria-label="Delete local folder"
                        >
                          <Trash2 className="h-3 w-3" />
                        </Button>
                      </div>
                    ) : (
                      <p className="text-xs text-muted-foreground">
                        {workspace.repoUrl ? "No local folder attached." : "No local folder configured."}
                      </p>
                    )}
                  {workspace.repoUrl ? (
                    <div className="flex items-center justify-between gap-2 py-1">
                      <a
                        href={workspace.repoUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                      >
                        <Github className="h-3 w-3 shrink-0" />
                        <span className="truncate">{formatGitHubRepo(workspace.repoUrl)}</span>
                        <ExternalLink className="h-3 w-3 shrink-0" />
                      </a>
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => clearRepoWorkspace(workspace)}
                        aria-label="Delete workspace repo"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    </div>
                  ) : null}
                  {workspace.runtimeServices && workspace.runtimeServices.length > 0 ? (
                    <div className="space-y-1 pl-2">
                      {workspace.runtimeServices.map((service) => (
                        <div
                          key={service.id}
                          className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1"
                        >
                          <div className="min-w-0 space-y-0.5">
                            <div className="flex items-center gap-2">
                              <span className="text-[11px] font-medium">{service.serviceName}</span>
                              <span
                                className={cn(
                                  "rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wide",
                                  service.status === "running"
                                    ? "bg-green-500/15 text-green-700 dark:text-green-300"
                                    : service.status === "failed"
                                      ? "bg-red-500/15 text-red-700 dark:text-red-300"
                                      : "bg-muted text-muted-foreground",
                                )}
                              >
                                {service.status}
                              </span>
                            </div>
                            <div className="text-[11px] text-muted-foreground">
                              {service.url ? (
                                <a
                                  href={service.url}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="hover:text-foreground hover:underline"
                                >
                                  {service.url}
                                </a>
                              ) : (
                                service.command ?? "No URL"
                              )}
                            </div>
                          </div>
                          <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                            {service.lifecycle}
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                    {workspace.isPrimary && executionWarning ? (
                      <div className="flex items-start gap-2 rounded-md border border-amber-500/20 bg-amber-500/5 px-2 py-1.5 text-xs text-amber-800 dark:text-amber-200">
                        <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
                        <span>{executionWarning}</span>
                      </div>
                    ) : null}
                    {!workspace.isPrimary && !hasWorkspaceLocalFolder(workspace) && workspace.repoUrl ? (
                      <p className="text-xs text-muted-foreground">
                        Repo reference only. It will not be used as the primary local execution target.
                      </p>
                    ) : null}
                    {!hasWorkspaceLocalFolder(workspace) ? (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          className="h-6 px-2"
                          disabled={workspaceMutationPending}
                          onClick={() => beginWorkspaceAction("local", workspace.id)}
                        >
                          Attach local folder
                        </Button>
                      </div>
                    ) : null}
                    {!workspace.repoUrl ? (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="xs"
                          className="h-6 px-2"
                          disabled={workspaceMutationPending}
                          onClick={() => beginWorkspaceAction("repo", workspace.id)}
                        >
                          Attach GitHub repo
                        </Button>
                      </div>
                    ) : null}
                    {workspaceMode === "local" && workspaceTargetId === workspace.id ? (
                      <div className="space-y-1.5 rounded-md border border-border p-2">
                        <div className="flex items-center gap-2">
                          <input
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            value={workspaceCwd}
                            onChange={(e) => setWorkspaceCwd(e.target.value)}
                            placeholder="/absolute/path/to/workspace"
                          />
                          <ChoosePathButton />
                        </div>
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="xs"
                            className="h-6 px-2"
                            disabled={!workspaceCwd.trim() || workspaceMutationPending}
                            onClick={submitLocalWorkspace}
                          >
                            Attach
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-6 px-2"
                            onClick={cancelWorkspaceAction}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}
                    {workspaceMode === "repo" && workspaceTargetId === workspace.id ? (
                      <div className="space-y-1.5 rounded-md border border-border p-2">
                        <input
                          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                          value={workspaceRepoUrl}
                          onChange={(e) => setWorkspaceRepoUrl(e.target.value)}
                          placeholder="https://github.com/org/repo"
                        />
                        <div className="flex items-center gap-2">
                          <Button
                            variant="outline"
                            size="xs"
                            className="h-6 px-2"
                            disabled={!workspaceRepoUrl.trim() || workspaceMutationPending}
                            onClick={submitRepoWorkspace}
                          >
                            Attach
                          </Button>
                          <Button
                            variant="ghost"
                            size="xs"
                            className="h-6 px-2"
                            onClick={cancelWorkspaceAction}
                          >
                            Cancel
                          </Button>
                        </div>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
          <div className="flex flex-col items-start gap-2">
            <Button
              variant="outline"
              size="xs"
              className="h-7 px-2.5"
              onClick={() => beginWorkspaceAction("local")}
            >
              Add workspace local folder
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="h-7 px-2.5"
              onClick={() => beginWorkspaceAction("repo")}
            >
              Add workspace repo
            </Button>
          </div>
          {workspaceMode === "local" && workspaceTargetId === null && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                  value={workspaceCwd}
                  onChange={(e) => setWorkspaceCwd(e.target.value)}
                  placeholder="/absolute/path/to/workspace"
                />
                <ChoosePathButton />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={!workspaceCwd.trim() || workspaceMutationPending}
                  onClick={submitLocalWorkspace}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={cancelWorkspaceAction}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {workspaceMode === "repo" && workspaceTargetId === null && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                value={workspaceRepoUrl}
                onChange={(e) => setWorkspaceRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={!workspaceRepoUrl.trim() || workspaceMutationPending}
                  onClick={submitRepoWorkspace}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={cancelWorkspaceAction}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
          {createWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to save workspace.</p>
          )}
          {removeWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to delete workspace.</p>
          )}
          {updateWorkspace.isError && (
            <p className="text-xs text-destructive">Failed to update workspace.</p>
          )}
        </div>

        {SHOW_EXPERIMENTAL_ISSUE_WORKTREE_UI && (
          <>
        <Separator className="my-4" />

        <div className="py-1.5 space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>Execution Workspaces</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label="Execution workspaces help"
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                Project-owned defaults for isolated issue checkouts and execution workspace behavior.
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-3">
            <div className="flex items-center justify-between gap-3">
              <div className="space-y-0.5">
                <div className="flex items-center gap-2 text-sm font-medium">
                  <span>Enable isolated issue checkouts</span>
                  <SaveIndicator state={fieldState("execution_workspace_enabled")} />
                </div>
                <div className="text-xs text-muted-foreground">
                  Let issues choose between the project’s primary checkout and an isolated execution workspace.
                </div>
              </div>
              {onUpdate || onFieldUpdate ? (
                <button
                  className={cn(
                    "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                    executionWorkspacesEnabled ? "bg-green-600" : "bg-muted",
                  )}
                  type="button"
                  onClick={() =>
                    commitField(
                      "execution_workspace_enabled",
                      updateExecutionWorkspacePolicy({ enabled: !executionWorkspacesEnabled })!,
                    )}
                >
                  <span
                    className={cn(
                      "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                      executionWorkspacesEnabled ? "translate-x-4.5" : "translate-x-0.5",
                    )}
                  />
                </button>
              ) : (
                <span className="text-xs text-muted-foreground">
                  {executionWorkspacesEnabled ? "Enabled" : "Disabled"}
                </span>
              )}
            </div>

            {executionWorkspacesEnabled && (
              <>
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm">
                      <span>New issues default to isolated checkout</span>
                      <SaveIndicator state={fieldState("execution_workspace_default_mode")} />
                    </div>
                    <div className="text-[11px] text-muted-foreground">
                      If disabled, new issues stay on the project’s primary checkout unless someone opts in.
                    </div>
                  </div>
                  <button
                    className={cn(
                      "relative inline-flex h-5 w-9 items-center rounded-full transition-colors",
                      executionWorkspaceDefaultMode === "isolated" ? "bg-green-600" : "bg-muted",
                    )}
                    type="button"
                    onClick={() =>
                      commitField(
                        "execution_workspace_default_mode",
                        updateExecutionWorkspacePolicy({
                          defaultMode: executionWorkspaceDefaultMode === "isolated" ? "project_primary" : "isolated",
                        })!,
                      )}
                  >
                    <span
                      className={cn(
                        "inline-block h-3.5 w-3.5 rounded-full bg-white transition-transform",
                        executionWorkspaceDefaultMode === "isolated" ? "translate-x-4.5" : "translate-x-0.5",
                      )}
                    />
                  </button>
                </div>

                <div className="border-t border-border/60 pt-2">
                  <button
                    type="button"
                    className="flex items-center gap-2 w-full py-1 text-xs font-medium text-muted-foreground hover:text-foreground transition-colors"
                    onClick={() => setExecutionWorkspaceAdvancedOpen((open) => !open)}
                  >
                    {executionWorkspaceAdvancedOpen ? "Hide advanced checkout settings" : "Show advanced checkout settings"}
                  </button>
                </div>

                {executionWorkspaceAdvancedOpen && (
                  <div className="space-y-3">
                    <div className="text-xs text-muted-foreground">
                      Host-managed implementation: <span className="text-foreground">Git worktree</span>
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Base ref</span>
                          <SaveIndicator state={fieldState("execution_workspace_base_ref")} />
                        </label>
                      </div>
                      <DraftInput
                        value={executionWorkspaceStrategy.baseRef ?? ""}
                        onCommit={(value) =>
                          commitField("execution_workspace_base_ref", {
                            ...updateExecutionWorkspacePolicy({
                              workspaceStrategy: {
                                ...executionWorkspaceStrategy,
                                type: "git_worktree",
                                baseRef: value || null,
                              },
                            })!,
                          })}
                        immediate
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder="origin/main"
                      />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Branch template</span>
                          <SaveIndicator state={fieldState("execution_workspace_branch_template")} />
                        </label>
                      </div>
                      <DraftInput
                        value={executionWorkspaceStrategy.branchTemplate ?? ""}
                        onCommit={(value) =>
                          commitField("execution_workspace_branch_template", {
                            ...updateExecutionWorkspacePolicy({
                              workspaceStrategy: {
                                ...executionWorkspaceStrategy,
                                type: "git_worktree",
                                branchTemplate: value || null,
                              },
                            })!,
                          })}
                        immediate
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder="{{issue.identifier}}-{{slug}}"
                      />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Worktree parent dir</span>
                          <SaveIndicator state={fieldState("execution_workspace_worktree_parent_dir")} />
                        </label>
                      </div>
                      <DraftInput
                        value={executionWorkspaceStrategy.worktreeParentDir ?? ""}
                        onCommit={(value) =>
                          commitField("execution_workspace_worktree_parent_dir", {
                            ...updateExecutionWorkspacePolicy({
                              workspaceStrategy: {
                                ...executionWorkspaceStrategy,
                                type: "git_worktree",
                                worktreeParentDir: value || null,
                              },
                            })!,
                          })}
                        immediate
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder=".paperclip/worktrees"
                      />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Provision command</span>
                          <SaveIndicator state={fieldState("execution_workspace_provision_command")} />
                        </label>
                      </div>
                      <DraftInput
                        value={executionWorkspaceStrategy.provisionCommand ?? ""}
                        onCommit={(value) =>
                          commitField("execution_workspace_provision_command", {
                            ...updateExecutionWorkspacePolicy({
                              workspaceStrategy: {
                                ...executionWorkspaceStrategy,
                                type: "git_worktree",
                                provisionCommand: value || null,
                              },
                            })!,
                          })}
                        immediate
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder="bash ./scripts/provision-worktree.sh"
                      />
                    </div>
                    <div>
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span>Teardown command</span>
                          <SaveIndicator state={fieldState("execution_workspace_teardown_command")} />
                        </label>
                      </div>
                      <DraftInput
                        value={executionWorkspaceStrategy.teardownCommand ?? ""}
                        onCommit={(value) =>
                          commitField("execution_workspace_teardown_command", {
                            ...updateExecutionWorkspacePolicy({
                              workspaceStrategy: {
                                ...executionWorkspaceStrategy,
                                type: "git_worktree",
                                teardownCommand: value || null,
                              },
                            })!,
                          })}
                        immediate
                        className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                        placeholder="bash ./scripts/teardown-worktree.sh"
                      />
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Provision runs inside the derived worktree before agent execution. Teardown is stored here for
                      future cleanup flows.
                    </p>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
          </>
        )}

      </div>
    </div>
  );
}
