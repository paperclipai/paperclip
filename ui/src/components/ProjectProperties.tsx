import { useState } from "react";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project } from "@paperclipai/shared";
import { StatusBadge } from "./StatusBadge";
import { cn, formatDate } from "../lib/utils";
import { goalsApi } from "../api/goals";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { useLocale } from "../context/LocaleContext";
import { queryKeys } from "../lib/queryKeys";
import { statusBadge, statusBadgeDefault } from "../lib/status-colors";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Archive, ArchiveRestore, Check, ExternalLink, Github, Loader2, Plus, Trash2, X } from "lucide-react";
import { ChoosePathButton } from "./PathInstructionsModal";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";
import { EnvVarEditor } from "./EnvVarEditor";

const PROJECT_STATUSES = [
  { value: "backlog", labelKey: "projectStatus.backlog" },
  { value: "planned", labelKey: "projectStatus.planned" },
  { value: "in_progress", labelKey: "projectStatus.inProgress" },
  { value: "completed", labelKey: "projectStatus.completed" },
  { value: "cancelled", labelKey: "projectStatus.cancelled" },
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
  | "execution_workspace_base_ref"
  | "execution_workspace_branch_template"
  | "execution_workspace_worktree_parent_dir"
  | "execution_workspace_provision_command"
  | "execution_workspace_teardown_command";

function SaveIndicator({ state, t }: { state: ProjectFieldSaveState; t: (key: string, variables?: Record<string, unknown>) => string }) {
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        {t("common.saving")}
      </span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />
        {t("common.saved")}
      </span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-[11px] text-destructive">
        <AlertCircle className="h-3 w-3" />
        {t("common.failed")}
      </span>
    );
  }
  return null;
}

function FieldLabel({
  label,
  state,
  t,
}: {
  label: string;
  state: ProjectFieldSaveState;
  t: (key: string, variables?: Record<string, unknown>) => string;
}) {
  return (
    <div className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <SaveIndicator state={state} t={t} />
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

function ProjectStatusPicker({
  status,
  onChange,
  t,
}: {
  status: string;
  onChange: (status: string) => void;
  t: (key: string, variables?: Record<string, unknown>) => string;
}) {
  const [open, setOpen] = useState(false);
  const colorClass = statusBadge[status] ?? statusBadgeDefault;
  const currentLabel = PROJECT_STATUSES.find((item) => item.value === status)?.labelKey;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium whitespace-nowrap shrink-0 cursor-pointer hover:opacity-80 transition-opacity",
            colorClass,
          )}
        >
          {currentLabel ? t(currentLabel) : status.replace("_", " ")}
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
            {t(s.labelKey)}
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
  t,
}: {
  project: Project;
  onArchive: (archived: boolean) => void;
  archivePending?: boolean;
  t: (key: string, variables?: Record<string, unknown>) => string;
}) {
  const [confirming, setConfirming] = useState(false);
  const isArchive = !project.archivedAt;
  const action = isArchive ? t("projectProperties.archiveAction") : t("projectProperties.unarchiveAction");

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        {isArchive
          ? t("projectProperties.archiveDescription")
          : t("projectProperties.unarchiveDescription")}
      </p>
      {archivePending ? (
        <Button size="sm" variant="destructive" disabled>
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          {isArchive ? t("projectProperties.archiving") : t("projectProperties.unarchiving")}
        </Button>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive font-medium">
            {t(isArchive ? "projectProperties.archiveConfirm" : "projectProperties.unarchiveConfirm", { name: project.name })}
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onArchive(isArchive);
            }}
          >
            {t("common.confirm")}
          </Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >
            {t("common.cancel")}
          </Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirming(true)}
        >
          {isArchive ? (
            <><Archive className="h-3 w-3 mr-1" />{t("projectProperties.archiveProject")}</>
          ) : (
            <><ArchiveRestore className="h-3 w-3 mr-1" />{t("projectProperties.unarchiveProject")}</>
          )}
        </Button>
      )}
    </div>
  );
}

export function ProjectProperties({ project, onUpdate, onFieldUpdate, getFieldSaveState, onArchive, archivePending }: ProjectPropertiesProps) {
  const { t } = useLocale();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [goalOpen, setGoalOpen] = useState(false);
  const [executionWorkspaceAdvancedOpen, setExecutionWorkspaceAdvancedOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | "repo" | null>(null);
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
  const { data: experimentalSettings } = useQuery({
    queryKey: queryKeys.instance.experimentalSettings,
    queryFn: () => instanceSettingsApi.getExperimental(),
    retry: false,
  });
  const { data: availableSecrets = [] } = useQuery({
    queryKey: selectedCompanyId ? queryKeys.secrets.list(selectedCompanyId) : ["secrets", "none"],
    queryFn: () => secretsApi.list(selectedCompanyId!),
    enabled: Boolean(selectedCompanyId),
  });
  const createSecret = useMutation({
    mutationFn: (input: { name: string; value: string }) => {
      if (!selectedCompanyId) throw new Error(t("projectProperties.selectCompanyForSecrets"));
      return secretsApi.create(selectedCompanyId, input);
    },
    onSuccess: () => {
      if (!selectedCompanyId) return;
      queryClient.invalidateQueries({ queryKey: queryKeys.secrets.list(selectedCompanyId) });
    },
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
  const codebase = project.codebase;
  const primaryCodebaseWorkspace = project.primaryWorkspace ?? null;
  const hasAdditionalLegacyWorkspaces = workspaces.some((workspace) => workspace.id !== primaryCodebaseWorkspace?.id);
  const executionWorkspacePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorkspacesEnabled = executionWorkspacePolicy?.enabled === true;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const executionWorkspaceDefaultMode =
    executionWorkspacePolicy?.defaultMode === "isolated_workspace" ? "isolated_workspace" : "shared_workspace";
  const executionWorkspaceStrategy = executionWorkspacePolicy?.workspaceStrategy ?? {
    type: "git_worktree",
    baseRef: "",
    branchTemplate: "",
    worktreeParentDir: "",
  };

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (project.urlKey !== project.id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    }
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
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });
  const updateWorkspace = useMutation({
    mutationFn: ({ workspaceId, data }: { workspaceId: string; data: Record<string, unknown> }) =>
      projectsApi.updateWorkspace(project.id, workspaceId, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceRepoUrl("");
      setWorkspaceMode(null);
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
      if (primaryCodebaseWorkspace) {
        removeWorkspace.mutate(primaryCodebaseWorkspace.id);
      }
      return;
    }

    const data: Record<string, unknown> = {
      ...(patch.cwd !== undefined ? { cwd: patch.cwd } : {}),
      ...(patch.repoUrl !== undefined ? { repoUrl: patch.repoUrl } : {}),
      ...(deriveSourceType(nextCwd, nextRepoUrl) ? { sourceType: deriveSourceType(nextCwd, nextRepoUrl) } : {}),
      isPrimary: true,
    };

    if (primaryCodebaseWorkspace) {
      updateWorkspace.mutate({ workspaceId: primaryCodebaseWorkspace.id, data });
      return;
    }

    createWorkspace.mutate(data);
  };

  const submitLocalWorkspace = () => {
    const cwd = workspaceCwd.trim();
    if (!cwd) {
      setWorkspaceError(null);
      persistCodebase({ cwd: null });
      return;
    }
    if (!isAbsolutePath(cwd)) {
      setWorkspaceError(t("projectProperties.localFolderAbsolutePath"));
      return;
    }
    setWorkspaceError(null);
    persistCodebase({ cwd });
  };

  const submitRepoWorkspace = () => {
    const repoUrl = workspaceRepoUrl.trim();
    if (!repoUrl) {
      setWorkspaceError(null);
      persistCodebase({ repoUrl: null });
      return;
    }
    if (!looksLikeRepoUrl(repoUrl)) {
      setWorkspaceError(t("projectProperties.repoUrlInvalid"));
      return;
    }
    setWorkspaceError(null);
    persistCodebase({ repoUrl });
  };

  const clearLocalWorkspace = () => {
    const confirmed = window.confirm(
      codebase.repoUrl
        ? t("projectProperties.clearLocalFolderConfirm")
        : t("projectProperties.deleteWorkspaceLocalFolderConfirm"),
    );
    if (!confirmed) return;
    persistCodebase({ cwd: null });
  };

  const clearRepoWorkspace = () => {
    const hasLocalFolder = Boolean(codebase.localFolder);
    const confirmed = window.confirm(
      hasLocalFolder
        ? t("projectProperties.clearRepoConfirm")
        : t("projectProperties.deleteWorkspaceRepoConfirm"),
    );
    if (!confirmed) return;
    if (primaryCodebaseWorkspace && hasLocalFolder) {
      updateWorkspace.mutate({
        workspaceId: primaryCodebaseWorkspace.id,
        data: { repoUrl: null, repoRef: null, defaultRef: null, sourceType: deriveSourceType(codebase.localFolder, null) },
      });
      return;
    }
    persistCodebase({ repoUrl: null });
  };

  const runtimeServiceStatusLabels: Record<string, string> = {
    starting: t("projectProperties.runtimeServiceStatus.starting"),
    running: t("projectProperties.runtimeServiceStatus.running"),
    stopped: t("projectProperties.runtimeServiceStatus.stopped"),
    failed: t("projectProperties.runtimeServiceStatus.failed"),
  };
  const runtimeServiceLifecycleLabels: Record<string, string> = {
    shared: t("projectProperties.runtimeServiceLifecycle.shared"),
    isolated: t("projectProperties.runtimeServiceLifecycle.isolated"),
    ephemeral: t("projectProperties.runtimeServiceLifecycle.ephemeral"),
  };

  return (
    <div>
      <div className="space-y-1 pb-4">
        <PropertyRow label={<FieldLabel label={t("projectProperties.name")} state={fieldState("name")} t={t} />}>
          {onUpdate || onFieldUpdate ? (
            <DraftInput
              value={project.name}
              onCommit={(name) => commitField("name", { name })}
              immediate
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none"
              placeholder={t("projectProperties.projectNamePlaceholder")}
            />
          ) : (
            <span className="text-sm">{project.name}</span>
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label={t("common.description")} state={fieldState("description")} t={t} />}
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
              placeholder={t("projectProperties.descriptionPlaceholder")}
              multiline
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {project.description?.trim() || t("projectProperties.noDescription")}
            </p>
          )}
        </PropertyRow>
        <PropertyRow label={<FieldLabel label={t("common.status")} state={fieldState("status")} t={t} />}>
          {onUpdate || onFieldUpdate ? (
            <ProjectStatusPicker
              status={project.status}
              onChange={(status) => commitField("status", { status })}
              t={t}
            />
          ) : (
            <StatusBadge status={project.status} />
          )}
        </PropertyRow>
        {project.leadAgentId && (
          <PropertyRow label={t("projectProperties.lead")}>
            <span className="text-sm font-mono">{project.leadAgentId.slice(0, 8)}</span>
          </PropertyRow>
        )}
        <PropertyRow
          label={<FieldLabel label={t("projectProperties.goals")} state={fieldState("goals")} t={t} />}
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
                      aria-label={t("projectProperties.removeGoal", { title: goal.title })}
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
                  {t("projectProperties.goal")}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-56 p-1" align="start">
                {availableGoals.length === 0 ? (
                  <div className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t("projectProperties.allGoalsLinked")}
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
          label={<FieldLabel label={t("projectProperties.env")} state={fieldState("env")} t={t} />}
          alignStart
          valueClassName="space-y-2"
        >
          <div className="space-y-2">
            <EnvVarEditor
              value={project.env ?? {}}
              secrets={availableSecrets}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={(env) => commitField("env", { env: env ?? null })}
            />
            <p className="text-[11px] text-muted-foreground">
              {t("projectProperties.envHint")}
            </p>
          </div>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label={t("common.created")} state="idle" t={t} />}>
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label={t("common.updated")} state="idle" t={t} />}>
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
        {project.targetDate && (
          <PropertyRow label={<FieldLabel label={t("projectProperties.targetDate")} state="idle" t={t} />}>
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      <Separator className="my-4" />

      <div className="space-y-1 py-4">
        <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t("projectProperties.codebase")}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                  aria-label={t("projectProperties.codebaseHelpAria")}
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {t("projectProperties.codebaseHelp")}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-2 rounded-md border border-border/70 p-3">
            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("projectProperties.repo")}</div>
              {codebase.repoUrl ? (
                <div className="flex items-center justify-between gap-2">
                  {isSafeExternalUrl(codebase.repoUrl) ? (
                    <a
                      href={codebase.repoUrl}
                      target="_blank"
                      rel="noreferrer"
                      className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground hover:underline"
                    >
                      <Github className="h-3 w-3 shrink-0" />
                      <span className="break-all min-w-0">{formatRepoUrl(codebase.repoUrl)}</span>
                      <ExternalLink className="h-3 w-3 shrink-0" />
                    </a>
                  ) : (
                    <div className="inline-flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <Github className="h-3 w-3 shrink-0" />
                      <span className="break-all min-w-0">{codebase.repoUrl}</span>
                    </div>
                  )}
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="xs"
                      className="h-6 px-2"
                      onClick={() => {
                        setWorkspaceMode("repo");
                        setWorkspaceRepoUrl(codebase.repoUrl ?? "");
                        setWorkspaceError(null);
                      }}
                    >
                      {t("projectProperties.changeRepo")}
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={clearRepoWorkspace}
                      aria-label={t("projectProperties.clearRepo")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs text-muted-foreground">{t("projectProperties.notSet")}</div>
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    onClick={() => {
                      setWorkspaceMode("repo");
                      setWorkspaceRepoUrl(codebase.repoUrl ?? "");
                      setWorkspaceError(null);
                    }}
                  >
                    {t("projectProperties.setRepo")}
                  </Button>
                </div>
              )}
            </div>

            <div className="space-y-1">
              <div className="text-[11px] uppercase tracking-wide text-muted-foreground">{t("projectProperties.localFolder")}</div>
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 space-y-1">
                  <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                    {codebase.effectiveLocalFolder}
                  </div>
                  {codebase.origin === "managed_checkout" && (
                    <div className="text-[11px] text-muted-foreground">{t("projectProperties.paperclipManagedFolder")}</div>
                  )}
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="outline"
                    size="xs"
                    className="h-6 px-2"
                    onClick={() => {
                      setWorkspaceMode("local");
                      setWorkspaceCwd(codebase.localFolder ?? "");
                      setWorkspaceError(null);
                    }}
                  >
                    {codebase.localFolder ? t("projectProperties.changeLocalFolder") : t("projectProperties.setLocalFolder")}
                  </Button>
                  {codebase.localFolder ? (
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={clearLocalWorkspace}
                      aria-label={t("projectProperties.clearLocalFolder")}
                    >
                      <Trash2 className="h-3 w-3" />
                    </Button>
                  ) : null}
                </div>
              </div>
            </div>

            {hasAdditionalLegacyWorkspaces && (
              <div className="text-[11px] text-muted-foreground">
                {t("projectProperties.additionalLegacyWorkspaces")}
              </div>
            )}

            {primaryCodebaseWorkspace?.runtimeServices && primaryCodebaseWorkspace.runtimeServices.length > 0 ? (
              <div className="space-y-1">
                {primaryCodebaseWorkspace.runtimeServices.map((service) => (
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
                          {runtimeServiceStatusLabels[service.status] ?? service.status}
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
                          service.command ?? t("projectProperties.noUrl")
                        )}
                      </div>
                    </div>
                    <div className="text-[10px] text-muted-foreground whitespace-nowrap">
                      {runtimeServiceLifecycleLabels[service.lifecycle] ?? service.lifecycle}
                    </div>
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {workspaceMode === "local" && (
            <div className="space-y-1.5 rounded-md border border-border p-2">
              <div className="flex items-center gap-2">
                <input
                  className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                  value={workspaceCwd}
                  onChange={(e) => setWorkspaceCwd(e.target.value)}
                  placeholder={t("projectProperties.localPathPlaceholder")}
                />
                <ChoosePathButton />
              </div>
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!workspaceCwd.trim() && !primaryCodebaseWorkspace) || createWorkspace.isPending || updateWorkspace.isPending}
                  onClick={submitLocalWorkspace}
                >
                  {t("common.save")}
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
                  {t("common.cancel")}
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
                placeholder={t("projectProperties.repoUrlPlaceholder")}
              />
              <div className="flex items-center gap-2">
                <Button
                  variant="outline"
                  size="xs"
                  className="h-6 px-2"
                  disabled={(!workspaceRepoUrl.trim() && !primaryCodebaseWorkspace) || createWorkspace.isPending || updateWorkspace.isPending}
                  onClick={submitRepoWorkspace}
                >
                  {t("common.save")}
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
                  {t("common.cancel")}
                </Button>
              </div>
            </div>
          )}
          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
          {createWorkspace.isError && (
            <p className="text-xs text-destructive">{t("projectProperties.failedToSaveWorkspace")}</p>
          )}
          {removeWorkspace.isError && (
            <p className="text-xs text-destructive">{t("projectProperties.failedToDeleteWorkspace")}</p>
          )}
          {updateWorkspace.isError && (
            <p className="text-xs text-destructive">{t("projectProperties.failedToUpdateWorkspace")}</p>
          )}
        </div>

        {isolatedWorkspacesEnabled ? (
          <>
            <Separator className="my-4" />

            <div className="py-1.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("projectProperties.executionWorkspaces")}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-[10px] text-muted-foreground hover:text-foreground"
                      aria-label={t("projectProperties.executionWorkspacesHelpAria")}
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">
                    {t("projectProperties.executionWorkspacesHelp")}
                  </TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{t("projectProperties.enableIsolatedIssueCheckouts")}</span>
                      <SaveIndicator state={fieldState("execution_workspace_enabled")} t={t} />
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {t("projectProperties.enableIsolatedIssueCheckoutsHint")}
                    </div>
                  </div>
                  {onUpdate || onFieldUpdate ? (
                    <ToggleSwitch
                      checked={executionWorkspacesEnabled}
                      onCheckedChange={() =>
                        commitField(
                          "execution_workspace_enabled",
                          updateExecutionWorkspacePolicy({ enabled: !executionWorkspacesEnabled })!,
                        )}
                    />
                  ) : (
                    <span className="text-xs text-muted-foreground">
                      {executionWorkspacesEnabled ? t("projectProperties.enabled") : t("projectProperties.disabled")}
                    </span>
                  )}
                </div>

                {executionWorkspacesEnabled ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span>{t("projectProperties.defaultToIsolatedCheckout")}</span>
                          <SaveIndicator state={fieldState("execution_workspace_default_mode")} t={t} />
                        </div>
                        <div className="text-[11px] text-muted-foreground">
                          {t("projectProperties.defaultToIsolatedCheckoutHint")}
                        </div>
                      </div>
                      <ToggleSwitch
                        checked={executionWorkspaceDefaultMode === "isolated_workspace"}
                        onCheckedChange={() =>
                          commitField(
                            "execution_workspace_default_mode",
                            updateExecutionWorkspacePolicy({
                              defaultMode:
                                executionWorkspaceDefaultMode === "isolated_workspace"
                                  ? "shared_workspace"
                                  : "isolated_workspace",
                            })!,
                          )}
                      />
                    </div>

                    <div className="border-t border-border/60 pt-2">
                      <button
                        type="button"
                        className="flex w-full items-center gap-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
                        onClick={() => setExecutionWorkspaceAdvancedOpen((open) => !open)}
                      >
                        {executionWorkspaceAdvancedOpen
                          ? t("projectProperties.hideAdvancedCheckoutSettings")
                          : t("projectProperties.showAdvancedCheckoutSettings")}
                      </button>
                    </div>

                    {executionWorkspaceAdvancedOpen ? (
                      <div className="space-y-3">
                        <div className="text-xs text-muted-foreground">
                          {t("projectProperties.hostManagedImplementation")}: <span className="text-foreground">{t("projectProperties.gitWorktree")}</span>
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{t("projectProperties.baseRef")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_base_ref")} t={t} />
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
                              <span>{t("projectProperties.branchTemplate")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_branch_template")} t={t} />
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
                              <span>{t("projectProperties.worktreeParentDir")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_worktree_parent_dir")} t={t} />
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
                              <span>{t("projectProperties.provisionCommand")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_provision_command")} t={t} />
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
                              <span>{t("projectProperties.teardownCommand")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_teardown_command")} t={t} />
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
                          {t("projectProperties.provisionTeardownHint")}
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
              {t("projectProperties.dangerZone")}
            </div>
            <ArchiveDangerZone
              project={project}
              onArchive={onArchive}
              archivePending={archivePending}
              t={t}
            />
          </div>
        </>
      )}
    </div>
  );
}
