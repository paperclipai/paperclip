import { useState } from "react";
import { environmentDisplayLabel, filterManagedSandboxSelectableEnvironments } from "@/lib/managed-sandbox-environment";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, SharedWorktreeConcurrency } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate } from "../lib/utils";
import { environmentsApi } from "../api/environments";
import { goalsApi } from "../api/goals";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Archive, ArchiveRestore, Check, ExternalLink, Loader2, Plus, Trash2, X } from "lucide-react";
import { GithubIcon } from "@/components/icons/github-icon";
import { ChoosePathButton } from "./PathInstructionsModal";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";
import { Badge } from "@/components/ui/badge";

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
  onFieldUpdate?: (field: ProjectConfigFieldKey, data: Record<string, unknown>) => void;
  getFieldSaveState?: (field: ProjectConfigFieldKey) => ProjectFieldSaveState;
  onArchive?: (archived: boolean) => void;
  archivePending?: boolean;
}

export type ProjectFieldSaveState = "idle" | "saving" | "saved" | "error";
export type ProjectConfigFieldKey =
  | "name"
  | "description"
  | "status"
  | "goals"
  | "env"
  | "execution_workspace_enabled"
  | "execution_workspace_default_mode"
  | "execution_workspace_shared_concurrency"
  | "execution_workspace_environment"
  | "execution_workspace_base_ref"
  | "execution_workspace_branch_template"
  | "execution_workspace_worktree_parent_dir"
  | "execution_workspace_provision_command"
  | "execution_workspace_runtime_provision_command"
  | "execution_workspace_teardown_command";

const SHARED_WORKSPACE_CONCURRENCY_OPTIONS: {
  value: SharedWorktreeConcurrency;
  label: string;
  help: string;
}[] = [
  {
    value: "auto",
    label: "Auto",
    help: "Concurrent runs on local/SSH runners; runs take turns in cloud environments.",
  },
  {
    value: "serialize",
    label: "Serialize",
    help: "Runs always take turns in the shared project worktree.",
  },
  {
    value: "allow",
    label: "Allow",
    help: "Runs never wait for the worktree; concurrent edits are possible.",
  },
];

function SaveIndicator({ state }: { state: ProjectFieldSaveState }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Saving
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />
        Saved
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-destructive">
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
    <div className={cn("flex gap-3 py-1.5 items-start")}>
      <div className="shrink-0 w-20 mt-0.5">{label}</div>
      <div className={cn("min-w-0 flex-1", alignStart ? "pt-0.5" : "flex items-center gap-1.5 flex-wrap", valueClassName)}>
        {children}
      </div>
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

function ArchiveDangerZone({
  project,
  onArchive,
  archivePending,
}: {
  project: Project;
  onArchive: (archived: boolean) => void;
  archivePending?: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  const isArchive = !project.archivedAt;
  const action = isArchive ? "Archive" : "Unarchive";

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        {isArchive
          ? "Archive this project to hide it from the sidebar and project selectors."
          : "Unarchive this project to restore it in the sidebar and project selectors."}
      </p>
      {archivePending ? (
        <Button size="sm" variant="destructive" disabled>
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          {isArchive ? "Archiving..." : "Unarchiving..."}
        </Button>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive font-medium">
            {action} &ldquo;{project.name}&rdquo;?
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onArchive(isArchive);
            }}
          >
            Confirm
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            Cancel
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirming(true)}
        >
          {isArchive ? (
            <><Archive className="h-3 w-3 mr-1" />{action} project</>
          ) : (
            <><ArchiveRestore className="h-3 w-3 mr-1" />{action} project</>
          )}
        </Button>
      )}
    </div>
  );
}

export function ProjectProperties({ project, onUpdate, onFieldUpdate, getFieldSaveState, onArchive, archivePending }: ProjectPropertiesProps) {
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [executionWorktreeAdvancedOpen, setExecutionWorktreeAdvancedOpen] = useState(false);
  const [worktreeMode, setWorktreeMode] = useState<"local" | "repo" | null>(null);
  const [worktreeCwd, setWorktreeCwd] = useState("");
  const [worktreeRepoUrl, setWorktreeRepoUrl] = useState("");
  const [worktreeError, setWorktreeError] = useState<string | null>(null);

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
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const environmentsEnabled = experimentalSettings?.enableEnvironments === true;
  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const { data: userSecretDefinitions = [] } = useQuery({
    queryKey: selectedCompanyId
      ? queryKeys.secrets.userDefinitions(selectedCompanyId)
      : ["user-secret-definitions", "none"],
    queryFn: () => secretsApi.listUserSecretDefinitions(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
    retry: false,
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error("Select an organization to create secrets");
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
  });
  const { data: environments } = useQuery({
    queryKey: queryKeys.environments.list(selectedCompanyId!),
    queryFn: () => environmentsApi.list(selectedCompanyId!),
    enabled: !!selectedCompanyId && environmentsEnabled,
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
  const worktrees = project.workspaces ?? [];
  const codebase = project.codebase;
  const primaryCodebaseWorktree = project.primaryWorkspace ?? null;
  const hasAdditionalLegacyWorktrees = worktrees.some((worktree) => worktree.id !== primaryCodebaseWorktree?.id);
  const executionWorktreePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorktreesEnabled = executionWorktreePolicy?.enabled === true;
  const isolatedWorktreesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const executionWorktreeDefaultMode =
    executionWorktreePolicy?.defaultMode === "isolated_workspace" ? "isolated_workspace" : "shared_workspace";
  // Absent/unset round-trips as "auto" — we only write a value once the user picks one.
  const executionWorkspaceSharedConcurrency: SharedWorktreeConcurrency =
    executionWorktreePolicy?.sharedWorkspaceConcurrency ?? "auto";
  const executionWorktreeEnvironmentId = executionWorktreePolicy?.environmentId ?? "";
  const executionWorktreeStrategy = executionWorktreePolicy?.workspaceStrategy ?? {
    type: "git_worktree",
    baseRef: "",
    branchTemplate: "",
    worktreeParentDir: "",
  };
  // Defense in depth alongside the server's managed-sandbox-only read
  // filter: a cached environments list may still carry the local row.
  const managedSandboxOnly = experimentalSettings?.enableManagedSandboxOnly === true;
  // The gate for the host-path surfaces below. It fails closed whenever the
  // policy is unknown — in flight and also on a failed read: an unresolved
  // policy reads as "not managed", which would show the local folder the policy
  // exists to hide.
  const hideHostPaths = experimentalSettings === undefined || managedSandboxOnly;
  const runSelectableEnvironments = filterManagedSandboxSelectableEnvironments(
    environments ?? [],
    managedSandboxOnly,
  ).filter((environment) => {
    if (environment.driver === "local" || environment.driver === "ssh") return true;
    if (environment.driver !== "sandbox") return false;
    const provider = typeof environment.config?.provider === "string" ? environment.config.provider : null;
    return provider !== null && provider !== "fake";
  });
  const showExecutionWorktreeEnvironmentControl = environmentsEnabled && runSelectableEnvironments.length > 1;

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (project.urlKey !== project.id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    }
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId) });
    }
  };

  const createWorktree = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.createWorkspace(project.id, data),
    onSuccess: () => {
      setWorktreeCwd("");
      setWorktreeRepoUrl("");
      setWorktreeMode(null);
      setWorktreeError(null);
      invalidateProject();
    },
  });

  const removeWorktree = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, worktreeCwd),
    onSuccess: () => {
      setWorktreeCwd("");
      setWorktreeRepoUrl("");
      setWorktreeMode(null);
      setWorktreeError(null);
      invalidateProject();
    },
  });
  const updateWorktree = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, worktreeCwd, data),
    onSuccess: () => {
      setWorktreeCwd("");
      setWorktreeRepoUrl("");
      setWorktreeMode(null);
      setWorktreeError(null);
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

  const updateExecutionWorktreePolicy = (patch: Record<string, unknown>) => {
    if (!onUpdate && !onFieldUpdate) return;
    return {
      executionWorkspacePolicy: {
        enabled: executionWorktreesEnabled,
        defaultMode: executionWorktreeDefaultMode,
        allowIssueOverride: executionWorktreePolicy?.allowIssueOverride ?? true,
        ...executionWorktreePolicy,
        ...patch,
      },
    };
  };

  const isAbsolutePath = (value: string) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);

  const looksLikeRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      if (parsed.protocol !== "https:") return false;
      const segments = parsed.pathname.split("/").filter(Boolean);
      return segments.length >= 2;
    } catch {
      return false;
    }
  };

  const isSafeExternalUrl = (value: string | null | undefined) => {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
    }
  };

  const formatRepoUrl = (value: string) => {
    try {
      const parsed = new URL(value);
      const segments = parsed.pathname.split("/").filter(Boolean);
      if (segments.length < 2) return parsed.host;
      const owner = segments[0];
      const repo = segments[1]?.replace(/\.git$/i, "");
      if (!owner || !repo) return parsed.host;
      return `${parsed.host}/${owner}/${repo}`;
    } catch {
      return value;
    }
  };

  const deriveSourceType = (cwd: string | null, repoUrl: string | null) => {
    if (repoUrl) return "git_repo";
    if (cwd) return "local_path";
    return undefined;
  };

  const persistCodebase = (patch: { cwd?: string | null; repoUrl?: string | null }) => {
    const nextCwd = patch.cwd !== undefined ? patch.cwd : codebase.localFolder;
    const nextRepoUrl = patch.repoUrl !== undefined ? patch.repoUrl : codebase.repoUrl;
    if (!nextCwd && !nextRepoUrl) {
      if (primaryCodebaseWorktree) {
        removeWorktree.mutate(primaryCodebaseWorktree.id);
      }
      return;
    }

    const data: Record<string, unknown> = {
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
      ...(deriveSourceType(nextCwd, nextRepoUrl) ? { sourceType: deriveSourceType(nextCwd, nextRepoUrl) } : {}),
      isPrimary: true,
    };

    if (primaryCodebaseWorktree) {
      updateWorktree.mutate({ workspaceId: primaryCodebaseWorktree.id, data });
      return;
    }

    createWorktree.mutate(data);
  };

  const submitLocalWorktree = () => {
    const cwd = worktreeCwd.trim();
    if (!cwd) {
      setWorktreeError(null);
      persistCodebase({ cwd: null });
      return;
    }
    if (!isAbsolutePath(cwd)) {
      setWorktreeError("Local folder must be a full absolute path.");
      return;
    }
    setWorktreeError(null);
    persistCodebase({ cwd });
  };

  const submitRepoWorktree = () => {
    const repoUrl = worktreeRepoUrl.trim();
    if (!repoUrl) {
      setWorktreeError(null);
      persistCodebase({ repoUrl: null });
      return;
    }
    if (!looksLikeRepoUrl(repoUrl)) {
      setWorktreeError("Repo must use a valid GitHub or GitHub Enterprise repo URL.");
      return;
    }
    setWorktreeError(null);
    persistCodebase({ repoUrl });
  };

  const clearLocalWorktree = () => {
    const confirmed = window.confirm(
      codebase.repoUrl
        ? "Clear local folder from this worktree?"
        : "Delete this worktree local folder?",
    );
    if (!confirmed) return;
    persistCodebase({ cwd: null });
  };

  const clearRepoWorktree = () => {
    const hasLocalFolder = Boolean(codebase.localFolder);
    const confirmed = window.confirm(
      hasLocalFolder
        ? "Clear repo from this worktree?"
        : "Delete this worktree repo?",
    );
    if (!confirmed) return;
    if (primaryCodebaseWorktree && hasLocalFolder) {
      updateWorktree.mutate({
        workspaceId: primaryCodebaseWorktree.id,
        data: { repoUrl: null, repoRef: null, defaultRef: null, sourceType: deriveSourceType(codebase.localFolder, null) },
      });
      return;
    }
    persistCodebase({ repoUrl: null });
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
              nullable
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
          {linkedGoals.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {linkedGoals.map((goal) => (
                <span
                  key={goal.id}
                  className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs"
                >
                  <Link to={`/goals/${goal.id}`} className="hover:underline break-words min-w-0">
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
                  className={cn("h-6 w-fit px-2", linkedGoals.length > 0 && "ml-1")}
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
        <PropertyRow
          label={<FieldLabel label="Env" state={fieldState("env")} />}
          alignStart
          valueClassName="space-y-2"
        >
          <div className="space-y-2">
            <EnvironmentVariablesEditor
              value={project.env ?? {}}
              secrets={availableSecrets}
              userSecretDefinitions={userSecretDefinitions}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={(env) => commitField("env", { env: env ?? null })}
            />
            <p className="text-(length:--text-micro) text-muted-foreground">
              Applied to all runs for tasks in this project. Project values override agent env on key conflicts.
            </p>
          </div>
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
            <span>Codebase</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                  aria-label="Codebase help"
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {hideHostPaths
                  ? "Repo identifies the source of truth. Agents check it out in the platform-managed environment."
                  : "Repo identifies the source of truth. Local folder is the default place agents write code."}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-2 rounded-md border border-border/70 p-3">
            <div className="space-y-1">
              <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">Repo</div>
              {codebase.repoUrl ? (
                <div className="flex items-center justify-between gap-2">
                  {isSafeExternalUrl(codebase.repoUrl) ? (
                    <a
                      href={codebase.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <GithubIcon className="h-3 w-3 shrink-0" />
                      <span className="break-all min-w-0">{formatRepoUrl(codebase.repoUrl)}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <GithubIcon className="h-3 w-3 shrink-0" />
                      <span className="break-all min-w-0">{codebase.repoUrl}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2"
                      onClick={() => {
                        setWorktreeMode("repo");
                        setWorktreeRepoUrl(codebase.repoUrl ?? "");
                        setWorktreeError(null);
                      }}
                    >
                      Change repo
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={clearRepoWorktree}
                      aria-label="Clear repo"
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">Not set.</div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    onClick={() => {
                      setWorktreeMode("repo");
                      setWorktreeRepoUrl(codebase.repoUrl ?? "");
                      setWorktreeError(null);
                    }}
                  >
                    Set repo
                  </Button>
                </div>
              )}
            </div>

            {/*
              The local folder is an absolute path on the execution host. Under
              the managed-sandbox-only policy every agent runs in the
              platform-managed environment, so the path, the folder controls,
              and the edit panel below all disappear. A managed checkout keeps
              its one-line label so the codebase still reads as accounted for,
              but never renders the path itself.
            */}
            {hideHostPaths ? (
              codebase.origin === "managed_checkout" ? (
                <div className="text-(length:--text-micro) text-muted-foreground">Paperclip-managed folder.</div>
              ) : null
            ) : (
              <div className="space-y-1">
                <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">Local folder</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {codebase.effectiveLocalFolder}
                    </div>
                    {codebase.origin === "managed_checkout" && (
                      <div className="text-(length:--text-micro) text-muted-foreground">Paperclip-managed folder.</div>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2"
                      onClick={() => {
                        setWorktreeMode("local");
                        setWorktreeCwd(codebase.localFolder ?? "");
                        setWorktreeError(null);
                      }}
                    >
                      {codebase.localFolder ? "Change local folder" : "Set local folder"}
                    </Button>
                    {codebase.localFolder ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={clearLocalWorktree}
                        aria-label="Clear local folder"
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {hasAdditionalLegacyWorktrees && (
              <div className="text-(length:--text-micro) text-muted-foreground">
                Additional legacy worktree records exist on this project. Paperclip is using the primary worktree as the codebase view.
              </div>
            )}

            {primaryCodebaseWorktree?.runtimeServices && primaryCodebaseWorktree.runtimeServices.length > 0 ? (
              <div className="space-y-1">
                {primaryCodebaseWorktree.runtimeServices.map((service) => (
                  <div
                    key={service.id}
                    className="flex items-center justify-between gap-2 rounded-md border border-border/60 px-2 py-1"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex items-center gap-2">
                        <span className="text-(length:--text-micro) font-medium">{service.serviceName}</span>
                        <Badge variant="ghost"
                          className={cn(
                            "px-1.5 text-(length:--text-nano) uppercase tracking-wide",
                            service.status === "running"
                              ? "bg-green-500/15 text-green-700 dark:text-green-300"
                              : service.status === "failed"
                                ? "bg-red-500/15 text-red-700 dark:text-red-300"
                                : "bg-muted text-muted-foreground",
                          )}
                        >
                          {service.status}
                        </Badge>
                      </div>
                      <div className="text-(length:--text-micro) text-muted-foreground">
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
                      {service.exposure && service.exposure.state !== "removed" ? (
                        <div
                          className={cn(
                            "text-(length:--text-nano)",
                            service.exposure.state === "failed" || service.exposure.state === "cleanup_pending"
                              ? "text-destructive"
                              : "text-muted-foreground",
                          )}
                        >
                          HTTPS {service.exposure.state.replace("_", " ")}
                        </div>
                      ) : null}
                    </div>
                    <div className="text-(length:--text-nano) text-muted-foreground whitespace-nowrap">
                      {service.lifecycle}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {!hideHostPaths && worktreeMode === "local" && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                  value={worktreeCwd}
                  onChange={(e) => setWorktreeCwd(e.target.value)}
                  placeholder="/absolute/path/to/workspace"
                />
                <ChoosePathButton />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!worktreeCwd.trim() && !primaryCodebaseWorktree) || createWorktree.isPending || updateWorktree.isPending}
                  onClick={submitLocalWorktree}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorktreeMode(null);
                    setWorktreeCwd("");
                    setWorktreeError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {worktreeMode === "repo" && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <input
                className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                value={worktreeRepoUrl}
                onChange={(e) => setWorktreeRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!worktreeRepoUrl.trim() && !primaryCodebaseWorktree) || createWorktree.isPending || updateWorktree.isPending}
                  onClick={submitRepoWorktree}
                >
                  Save
                </Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorktreeMode(null);
                    setWorktreeRepoUrl("");
                    setWorktreeError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}
          {worktreeError && (
            <p className="text-xs text-destructive">{worktreeError}</p>
          )}
          {createWorktree.isError && (
            <p className="text-xs text-destructive">Failed to save worktree.</p>
          )}
          {removeWorktree.isError && (
            <p className="text-xs text-destructive">Failed to delete worktree.</p>
          )}
          {updateWorktree.isError && (
            <p className="text-xs text-destructive">Failed to update worktree.</p>
          )}
        </div>

        {isolatedWorktreesEnabled ? (
          <>
            <Separator className="my-4" />

            <div className="py-1.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>Execution Worktrees</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                      aria-label="Execution worktrees help"
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    Project-owned defaults for isolated task checkouts and execution worktree behavior.
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>Enable isolated task checkouts</span>
                      <SaveIndicator state={fieldState("execution_workspace_enabled")} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      Let tasks choose between the project's primary checkout and an isolated execution workspace.
                    </div>
                  </div>
                  {onUpdate || onFieldUpdate ? (
                    <ToggleSwitch
                      checked={executionWorktreesEnabled}
                      onCheckedChange={() =>
                        commitField(
                          "execution_workspace_enabled",
                          updateExecutionWorktreePolicy({ enabled: !executionWorktreesEnabled })!,
                        )}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {executionWorktreesEnabled ? "Enabled" : "Disabled"}
                    </span>
                  )}
                </div>

                {executionWorktreesEnabled ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span>New tasks default to isolated checkout</span>
                          <SaveIndicator state={fieldState("execution_workspace_default_mode")} />
                        </div>
                        <div className="text-(length:--text-micro) text-muted-foreground">
                          If disabled, new tasks stay on the project's primary checkout unless someone opts in.
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={executionWorktreeDefaultMode === "isolated_workspace"}
                        onCheckedChange={() =>
                          commitField(
                            "execution_workspace_default_mode",
                            updateExecutionWorktreePolicy({
                              defaultMode:
                                executionWorktreeDefaultMode === "isolated_workspace"
                                  ? "shared_workspace"
                                  : "isolated_workspace",
                            })!,
                          )}
                      />
                    </div>

                    <div className="space-y-0.5">
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-sm">
                          <span>Shared worktree concurrency</span>
                          <SaveIndicator state={fieldState("execution_workspace_shared_concurrency")} />
                        </label>
                      </div>
                      {onUpdate || onFieldUpdate ? (
                        <select
                          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                          aria-label="Shared worktree concurrency"
                          value={executionWorkspaceSharedConcurrency}
                          onChange={(e) =>
                            commitField(
                              "execution_workspace_shared_concurrency",
                              updateExecutionWorktreePolicy({
                                sharedWorkspaceConcurrency: e.target.value as SharedWorktreeConcurrency,
                              })!,
                            )}
                        >
                          {SHARED_WORKSPACE_CONCURRENCY_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                              {option.label}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <div className="text-xs">
                          {SHARED_WORKSPACE_CONCURRENCY_OPTIONS.find(
                            (option) => option.value === executionWorkspaceSharedConcurrency,
                          )?.label}
                        </div>
                      )}
                      <p className="text-(length:--text-micro) text-muted-foreground">
                        {SHARED_WORKSPACE_CONCURRENCY_OPTIONS.find(
                          (option) => option.value === executionWorkspaceSharedConcurrency,
                        )?.help}
                      </p>
                    </div>

                    <div className="border-t border-border/60 pt-2">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => setExecutionWorktreeAdvancedOpen((open) => !open)}
                      >
                        {executionWorktreeAdvancedOpen
                          ? "Hide advanced checkout settings"
                          : "Show advanced checkout settings"}
                      </button>
                    </div>

                    {executionWorktreeAdvancedOpen ? (
                      <div className="space-y-3">
                        <div className="text-xs text-muted-foreground">
                          Host-managed implementation: <span className="text-foreground">Git worktree</span>
                        </div>
                        {showExecutionWorktreeEnvironmentControl ? (
                          <div>
                            <div className="mb-1 flex items-center gap-1.5">
                              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>Environment</span>
                                <SaveIndicator state={fieldState("execution_workspace_environment")} />
                              </label>
                            </div>
                            <select
                              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                              value={executionWorktreeEnvironmentId}
                              onChange={(e) =>
                                commitField(
                                  "execution_workspace_environment",
                                  updateExecutionWorktreePolicy({
                                    environmentId: e.target.value || null,
                                  })!,
                                )}
                            >
                              <option value="">No environment</option>
                              {runSelectableEnvironments.map((environment) => (
                                <option key={environment.id} value={environment.id}>
                                  {environmentDisplayLabel(environment)}
                                </option>
                              ))}
                            </select>
                          </div>
                        ) : null}
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Base ref</span>
                              <SaveIndicator state={fieldState("execution_workspace_base_ref")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorktreeStrategy.baseRef ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_base_ref", {
                                ...updateExecutionWorktreePolicy({
                                  workspaceStrategy: {
                                    ...executionWorktreeStrategy,
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
                            value={executionWorktreeStrategy.branchTemplate ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_branch_template", {
                                ...updateExecutionWorktreePolicy({
                                  workspaceStrategy: {
                                    ...executionWorktreeStrategy,
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
                            value={executionWorktreeStrategy.worktreeParentDir ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_worktree_parent_dir", {
                                ...updateExecutionWorktreePolicy({
                                  workspaceStrategy: {
                                    ...executionWorktreeStrategy,
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
                            value={executionWorktreeStrategy.provisionCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_provision_command", {
                                ...updateExecutionWorktreePolicy({
                                  workspaceStrategy: {
                                    ...executionWorktreeStrategy,
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
                              <span>Runtime provision command</span>
                              <SaveIndicator state={fieldState("execution_workspace_runtime_provision_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorktreeStrategy.runtimeProvisionCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_runtime_provision_command", {
                                ...updateExecutionWorktreePolicy({
                                  workspaceStrategy: {
                                    ...executionWorktreeStrategy,
                                    type: "git_worktree",
                                    runtimeProvisionCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/provision-worktree-runtime.sh"
                          />
                          <p className="mt-1 text-xs text-muted-foreground">
                            Runs once before the first runtime-service start (heavy setup, e.g. DB seed). Leave empty to keep eager provisioning.
                          </p>
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>Teardown command</span>
                              <SaveIndicator state={fieldState("execution_workspace_teardown_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorktreeStrategy.teardownCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_teardown_command", {
                                ...updateExecutionWorktreePolicy({
                                  workspaceStrategy: {
                                    ...executionWorktreeStrategy,
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
                        <p className="text-(length:--text-micro) text-muted-foreground">
                          Provision runs inside the derived worktree before agent execution. Teardown is stored here for
                          future cleanup flows.
                        </p>
                      </div>
                    ) : null}
                  </div>
                ) : null}
              </div>
            </div>
          </>
        ) : null}

      </div>

      {onArchive && (
        <>
          <Separator className="my-4" />
          <div className="space-y-4 py-4">
            <div className="text-xs font-medium text-destructive uppercase tracking-wide">
              Danger Zone
            </div>
            <ArchiveDangerZone
              project={project}
              onArchive={onArchive}
              archivePending={archivePending}
            />
          </div>
        </>
      )}
    </div>
  );
}
