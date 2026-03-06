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
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { ExternalLink, Github, Plus, Trash2, X } from "lucide-react";
import { ChoosePathButton } from "./PathInstructionsModal";

const PROJECT_STATUSES = [
  { value: "backlog", label: "Backlog" },
  { value: "planned", label: "Planned" },
  { value: "in_progress", label: "In Progress" },
  { value: "completed", label: "Completed" },
  { value: "cancelled", label: "Cancelled" },
];

interface ProjectPropertiesProps {
  project: Project;
  onUpdate?: (data: Record<string, unknown>) => void;
}

const REPO_ONLY_CWD_SENTINEL = "/__paperclip_repo_only__";

function PropertyRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-3 py-1.5">
      <span className="text-xs text-muted-foreground shrink-0 w-20">{label}</span>
      <div className="flex items-center gap-1.5 min-w-0">{children}</div>
    </div>
  );
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

export function ProjectProperties({ project, onUpdate }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "repo" | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [workspaceRepoUrl, setWorkspaceRepoUrl] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

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
    onSuccess: invalidateProject,
  });

  const removeGoal = (goalId: string) => {
    if (!onUpdate) return;
    onUpdate({ goalIds: linkedGoalIds.filter((id) => id !== goalId) });
  };

  const addGoal = (goalId: string) => {
    if (!onUpdate || linkedGoalIds.includes(goalId)) return;
    onUpdate({ goalIds: [...linkedGoalIds, goalId] });
    setGoalOpen(false);
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
    createWorkspace.mutate({
      name: deriveWorkspaceNameFromRepo(repoUrl),
      cwd: REPO_ONLY_CWD_SENTINEL,
      repoUrl,
    });
  };

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

  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <PropertyRow label="Status">
          {onUpdate ? (
            <ProjectStatusPicker
              status={project.status}
              onChange={(status) => onUpdate({ status })}
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
        <div className="py-1.5">
          <div className="flex items-start justify-between gap-2">
            <span className="text-xs text-muted-foreground">Goals</span>
            <div className="flex flex-col items-end gap-1.5">
              {linkedGoals.length === 0 ? (
                <span className="text-sm text-muted-foreground">None</span>
              ) : (
                <div className="flex flex-wrap justify-end gap-1.5 max-w-[220px]">
                  {linkedGoals.map((goal) => (
                    <span
                      key={goal.id}
                      className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                    >
                      <Link to={`/goals/${goal.id}`} className="hover:underline max-w-[140px] truncate">
                        {goal.title}
                      </Link>
                      {onUpdate && (
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
              {onUpdate && (
                <Popover open={goalOpen} onOpenChange={setGoalOpen}>
                  <PopoverTrigger asChild>
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2"
                      disabled={availableGoals.length === 0}
                    >
                      <Plus className="h-3 w-3 mr-1" />
                      Goal
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent className="w-56 p-1" align="end">
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
            </div>
          </div>
        </div>
        {project.targetDate && (
          <PropertyRow label="Target Date">
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      <Separator />

      <div className="space-y-1">
        <div className="py-1.5 space-y-2">
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
              {workspaces.map((workspace) => (
                <div key={workspace.id} className="space-y-1">
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
                  ) : null}
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
                </div>
              ))}
            </div>
          )}
          <div className="flex flex-col items-start gap-2">
            <Button
              variant="outline"
              size="xs"
              className="h-7 px-2.5"
              onClick={() => {
                setWorkspaceMode("local");
                setWorkspaceError(null);
              }}
            >
              Add workspace local folder
            </Button>
            <Button
              variant="outline"
              size="xs"
              className="h-7 px-2.5"
              onClick={() => {
                setWorkspaceMode("repo");
                setWorkspaceError(null);
              }}
            >
              Add workspace repo
            </Button>
          </div>
          {workspaceMode === "local" && (
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
                  disabled={!workspaceCwd.trim() || createWorkspace.isPending}
                  onClick={submitLocalWorkspace}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorkspaceMode(null);
                    setWorkspaceCwd("");
                    setWorkspaceError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {workspaceMode === "repo" && (
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
                  disabled={!workspaceRepoUrl.trim() || createWorkspace.isPending}
                  onClick={submitRepoWorkspace}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorkspaceMode(null);
                    setWorkspaceRepoUrl("");
                    setWorkspaceError(null);
                  }}
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

        <Separator />

        <PropertyRow label="Created">
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label="Updated">
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
      </div>
    </div>
  );
}
