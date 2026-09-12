import { t, useTranslation } from "@/i18n";
import { useState, type ReactNode } from "react";
import { environmentDisplayLabel, filterManagedSandboxSelectableEnvironments } from "@/lib/managed-sandbox-environment";
import { Link } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Project, SharedWorkspaceConcurrency } from "@paperclipai/shared";
import { ProjectRepositories } from "./ProjectRepositories";
import { cn, formatDate } from "../lib/utils";
import { environmentsApi } from "../api/environments";
import { instanceSettingsApi } from "../api/instanceSettings";
import { projectsApi } from "../api/projects";
import { secretsApi } from "../api/secrets";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { AlertCircle, Archive, ArchiveRestore, Check, ExternalLink, Loader2, Trash2 } from "lucide-react";
import { ChoosePathButton } from "./PathInstructionsModal";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { DraftInput } from "./agent-config-primitives";
import { InlineEditor } from "./InlineEditor";
import { EnvironmentVariablesEditor } from "./environment-variables-editor";
import { Badge } from "@/components/ui/badge";

interface ProjectPropertiesProps {
  project: Project;
  repositories?: ReactNode;
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
  value: SharedWorkspaceConcurrency;
  label: string;
  help: string;
}[] = [
  {
    value: "auto",
    get ["label"]() { return t("localizationProjects.ui_Auto"); },
    get help() { return t("localizationProjects.concurrency_auto"); },
  },
  {
    value: "serialize",
    get ["label"]() { return t("localizationProjects.ui_Serialize"); },
    get help() { return t("localizationProjects.concurrency_serialize"); },
  },
  {
    value: "allow",
    get ["label"]() { return t("localizationProjects.ui_Allow"); },
    get help() { return t("localizationProjects.concurrency_allow"); },
  },
];

function SaveIndicator({ state }: { state: ProjectFieldSaveState }) {
  const { t } = useTranslation();
  if (state === "saving") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />{t("localizationProjects.ui_Saving")}</span>
    );
  }
  if (state === "saved") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-green-600 dark:text-green-400">
        <Check className="h-3 w-3" />{t("pages.companySettings.saved")}</span>
    );
  }
  if (state === "error") {
    return (
      <span className="inline-flex items-center gap-1 text-(length:--text-micro) text-destructive">
        <AlertCircle className="h-3 w-3" />{t("localizationProjects.ui_Failed")}</span>
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
  useTranslation();
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
  useTranslation();
  return (
    <div className={cn("flex gap-3 py-1.5 items-start")}>
      <div className="shrink-0 w-20 mt-0.5">{label}</div>
      <div className={cn("min-w-0 flex-1", alignStart ? "pt-0.5" : "flex items-center gap-1.5 flex-wrap", valueClassName)}>
        {children}
      </div>
    </div>
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
  const { t } = useTranslation();
  const [confirming, setConfirming] = useState(false);
  const isArchive = !project.archivedAt;
  const action = isArchive ? t("localizationProjects.archiveProject") : t("localizationProjects.unarchiveProject");

  return (
    <div className="space-y-3 rounded-md border border-destructive/40 bg-destructive/5 px-4 py-4">
      <p className="text-sm text-muted-foreground">
        {isArchive
          ? t("localizationProjects.ui_Archive_this_project_to_hide_it_from_the_sidebar_and_project_selectors_")
          : t("localizationProjects.ui_Unarchive_this_project_to_restore_it_in_the_sidebar_and_project_selectors_")}
      </p>
      {archivePending ? (
        <Button size="sm" variant="destructive" disabled>
          <Loader2 className="h-3 w-3 animate-spin mr-1" />
          {isArchive ? t("pages.companySettings.archiving") : t("localizationProjects.ui_Unarchiving_")}
        </Button>
      ) : confirming ? (
        <div className="flex items-center gap-2">
          <span className="text-sm text-destructive font-medium">
            {isArchive ? t("localizationProjects.confirmArchiveProject", { name: project.name }) : t("localizationProjects.confirmUnarchiveProject", { name: project.name })}
          </span>
          <Button
            size="sm"
            variant="destructive"
            onClick={() => {
              setConfirming(false);
              onArchive(isArchive);
            }}
          >{t("localizationProjects.ui_Confirm")}</Button>
          <Button
            size="sm"
            variant="outline"
            onClick={() => setConfirming(false)}
          >{t("localizationProjects.ui_Cancel")}</Button>
        </div>
      ) : (
        <Button
          size="sm"
          variant="destructive"
          onClick={() => setConfirming(true)}
        >
          {isArchive ? (
            <><Archive className="h-3 w-3 mr-1" />{action}</>
          ) : (
            <><ArchiveRestore className="h-3 w-3 mr-1" />{action}</>
          )}
        </Button>
      )}
    </div>
  );
}

export function ProjectProperties({ project, repositories, onUpdate, onFieldUpdate, getFieldSaveState, onArchive, archivePending }: ProjectPropertiesProps) {
  const { t } = useTranslation();
  const { selectedCompanyId } = useCompany();
  const queryClient = useQueryClient();
  const [executionWorkspaceAdvancedOpen, setExecutionWorkspaceAdvancedOpen] = useState(false);
  const [workspaceMode, setWorkspaceMode] = useState<"local" | null>(null);
  const [workspaceCwd, setWorkspaceCwd] = useState("");
  const [workspaceError, setWorkspaceError] = useState<string | null>(null);

  const commitField = (field: ProjectConfigFieldKey, data: Record<string, unknown>) => {
    if (onFieldUpdate) {
      onFieldUpdate(field, data);
      return;
    }
    onUpdate?.(data);
  };
  const fieldState = (field: ProjectConfigFieldKey): ProjectFieldSaveState => getFieldSaveState?.(field) ?? "idle";

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
      if (!selectedCompanyId) throw new Error(t("localizationProjects.error_Select_an_organization_to_create_secrets"));
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

  const workspaces = project.workspaces ?? [];
  const codebase = project.codebase;
  const primaryCodebaseWorkspace = project.primaryWorkspace ?? null;
  const hasAdditionalLegacyWorkspaces = workspaces.some((workspace) => workspace.id !== primaryCodebaseWorkspace?.id && !workspace.metadata?.githubRepositoryId);
  const executionWorkspacePolicy = project.executionWorkspacePolicy ?? null;
  const executionWorkspacesEnabled = executionWorkspacePolicy?.enabled === true;
  const isolatedWorkspacesEnabled = experimentalSettings?.enableIsolatedWorkspaces === true;
  const executionWorkspaceDefaultMode =
    executionWorkspacePolicy?.defaultMode === "isolated_workspace" ? "isolated_workspace" : "shared_workspace";
  // Absent/unset round-trips as "auto" — we only write a value once the user picks one.
  const executionWorkspaceSharedConcurrency: SharedWorkspaceConcurrency =
    executionWorkspacePolicy?.sharedWorkspaceConcurrency ?? "auto";
  const executionWorkspaceEnvironmentId = executionWorkspacePolicy?.environmentId ?? "";
  const executionWorkspaceStrategy = executionWorkspacePolicy?.workspaceStrategy ?? {
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
  const showExecutionWorkspaceEnvironmentControl = environmentsEnabled && runSelectableEnvironments.length > 1;

  const invalidateProject = () => {
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    if (project.urlKey !== project.id) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    }
    if (selectedCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.all(selectedCompanyId) });
    }
  };

  const createWorkspace = useMutation({
    mutationFn: (data: Record<string, unknown>) => projectsApi.createWorkspace(project.id, data),
    onSuccess: () => {
      setWorkspaceCwd("");
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

  const removeWorkspace = useMutation({
    mutationFn: (workspaceId: string) => projectsApi.removeWorkspace(project.id, workspaceId),
    onSuccess: () => {
      setWorkspaceCwd("");
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
      setWorkspaceMode(null);
      setWorkspaceError(null);
      invalidateProject();
    },
  });

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

  const isSafeExternalUrl = (value: string | null | undefined) => {
    if (!value) return false;
    try {
      const parsed = new URL(value);
      return parsed.protocol === "http:" || parsed.protocol === "https:";
    } catch {
      return false;
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
      setWorkspaceError(t("localizationProjects.error_Local_folder_must_be_a_full_absolute_path_"));
      return;
    }
    setWorkspaceError(null);
    persistCodebase({ cwd });
  };

  const clearLocalWorkspace = () => {
    const confirmed = window.confirm(
      codebase.repoUrl
        ? t("localizationProjects.error_Clear_local_folder_from_this_workspace_")
        : t("localizationProjects.error_Delete_this_workspace_local_folder_"),
    );
    if (!confirmed) return;
    persistCodebase({ cwd: null });
  };

  return (
    <div>
      <div className="space-y-1 pb-4">
        <PropertyRow label={<FieldLabel label={t("localizationProjects.ui_Name")} state={fieldState("name")} />}>
          {onUpdate || onFieldUpdate ? (
            <DraftInput
              value={project.name}
              onCommit={(name) => commitField("name", { name })}
              immediate
              className="w-full rounded border border-border bg-transparent px-2 py-1 text-sm outline-none"
              placeholder={t("localizationFilters.operators.project.label")}
            />
          ) : (
            <span className="text-sm">{project.name}</span>
          )}
        </PropertyRow>
        <PropertyRow
          label={<FieldLabel label={t("localizationProjects.ui_Description")} state={fieldState("description")} />}
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
              placeholder={t("localizationIssueDetail.ui_Add_a_description")}
              multiline
            />
          ) : (
            <p className="text-sm text-muted-foreground">
              {project.description?.trim() || t("localizationProjects.ui_No_description")}
            </p>
          )}
        </PropertyRow>
        {repositories ?? <ProjectRepositories key={project.id} project={project} />}
        <PropertyRow
          label={<FieldLabel label={t("localizationRoutineHistory.env")} state={fieldState("env")} />}
          alignStart
          valueClassName="space-y-2"
        >
          <div className="space-y-2">
            <EnvironmentVariablesEditor
              footerHint={null}
              value={project.env ?? {}}
              secrets={availableSecrets}
              userSecretDefinitions={userSecretDefinitions}
              onCreateSecret={async (name, value) => {
                const created = await createSecret.mutateAsync({ name, value });
                return created;
              }}
              onChange={(env) => commitField("env", { env: env ?? null })}
            />

          </div>
        </PropertyRow>
        <PropertyRow label={<FieldLabel label={t("localizationProjects.ui_Updated")} state="idle" />}>
          <span className="text-sm">{formatDate(project.updatedAt)}</span>
        </PropertyRow>
        {project.targetDate && (
          <PropertyRow label={<FieldLabel label={t("localizationProjects.ui_Target_Date")} state="idle" />}>
            <span className="text-sm">{formatDate(project.targetDate)}</span>
          </PropertyRow>
        )}
      </div>

      <Separator className="my-4" />

      <div className="space-y-1 py-4">
        {(!hideHostPaths || (primaryCodebaseWorkspace?.runtimeServices?.length ?? 0) > 0) && <div className="space-y-2">
          <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span>{t("localizationProjects.ui_Codebase")}</span>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  type="button"
                  className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                  aria-label={t("localizationProjects.ui_Codebase_help")}
                >
                  ?
                </button>
              </TooltipTrigger>
              <TooltipContent side="top">
                {hideHostPaths
                  ? t("localizationProjects.ui_Repo_identifies_the_source_of_truth_Agents_check_it_out_in_the_platform_managed_environment_")
                  : t("localizationProjects.ui_Repo_identifies_the_source_of_truth_Local_folder_is_the_default_place_agents_write_code_")}
              </TooltipContent>
            </Tooltip>
          </div>
          <div className="space-y-2 rounded-md border border-border/70 p-3">
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
                <div className="text-(length:--text-micro) text-muted-foreground">{t("localizationProjects.ui_Paperclip_managed_folder_")}</div>
              ) : null
            ) : (
              <div className="space-y-1">
                <div className="text-(length:--text-micro) uppercase tracking-wide text-muted-foreground">{t("localizationProjects.ui_Local_folder")}</div>
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 space-y-1">
                    <div className="min-w-0 break-all font-mono text-xs text-muted-foreground">
                      {codebase.effectiveLocalFolder}
                    </div>
                    {codebase.origin === "managed_checkout" && (
                      <div className="text-(length:--text-micro) text-muted-foreground">{t("localizationProjects.ui_Paperclip_managed_folder_")}</div>
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
                      {codebase.localFolder ? t("localizationProjects.ui_Change_local_folder") : t("localizationProjects.ui_Set_local_folder")}
                    </Button>
                    {codebase.localFolder ? (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={clearLocalWorkspace}
                        aria-label={t("localizationProjects.ui_Clear_local_folder")}
                      >
                        <Trash2 className="h-3 w-3" />
                      </Button>
                    ) : null}
                  </div>
                </div>
              </div>
            )}

            {hasAdditionalLegacyWorkspaces && (
              <div className="text-(length:--text-micro) text-muted-foreground">{t("localizationProjects.ui_Additional_legacy_workspace_records_exist_on_this_project_Paperclip_is_using_the_primary_workspace_a")}</div>
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
                          {t(`status.${service.status}`, { defaultValue: service.status })}
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
                          service.command ?? t("localizationProjects.ui_No_URL")
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
          {!hideHostPaths && workspaceMode === "local" && (
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
                  disabled={(!workspaceCwd.trim() && !primaryCodebaseWorkspace) || createWorkspace.isPending || updateWorkspace.isPending}
                  onClick={submitLocalWorkspace}
                >{t("localizationProjects.ui_Save")}</Button>
                <Button
                  variant="ghost"
                  size="xs"
                  className="h-6 px-2"
                  onClick={() => {
                    setWorkspaceMode(null);
                    setWorkspaceCwd("");
                    setWorkspaceError(null);
                  }}
                >{t("localizationProjects.ui_Cancel")}</Button>
              </div>
            </div>
          )}
          {workspaceError && (
            <p className="text-xs text-destructive">{workspaceError}</p>
          )}
          {createWorkspace.isError && (
            <p className="text-xs text-destructive">{t("workspaces.errors.save")}</p>
          )}
          {removeWorkspace.isError && (
            <p className="text-xs text-destructive">{t("localizationProjects.ui_Failed_to_delete_workspace_")}</p>
          )}
          {updateWorkspace.isError && (
            <p className="text-xs text-destructive">{t("workspaces.errors.update")}</p>
          )}
        </div>}

        {isolatedWorkspacesEnabled ? (
          <>
            <Separator className="my-4" />

            <div className="py-1.5 space-y-2">
              <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <span>{t("localizationProjects.ui_Execution_Workspaces")}</span>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <button
                      type="button"
                      className="inline-flex h-4 w-4 items-center justify-center rounded-full border border-border text-(length:--text-nano) text-muted-foreground hover:text-foreground"
                      aria-label={t("localizationProjects.ui_Execution_workspaces_help")}
                    >
                      ?
                    </button>
                  </TooltipTrigger>
                  <TooltipContent side="top">{t("localizationProjects.ui_Project_owned_defaults_for_isolated_task_checkouts_and_execution_workspace_behavior_")}</TooltipContent>
                </Tooltip>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="space-y-0.5">
                    <div className="flex items-center gap-2 text-sm font-medium">
                      <span>{t("localizationProjects.ui_Enable_isolated_task_checkouts")}</span>
                      <SaveIndicator state={fieldState("execution_workspace_enabled")} />
                    </div>
                    <div className="text-xs text-muted-foreground">{t("localizationProjects.ui_Let_tasks_choose_between_the_project_s_primary_checkout_and_an_isolated_execution_workspace_")}</div>
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
                      {executionWorkspacesEnabled ? t("localizationProjects.ui_Enabled") : t("pages.secrets.status.disabled")}
                    </span>
                  )}
                </div>

                {executionWorkspacesEnabled ? (
                  <div className="space-y-3">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5">
                        <div className="flex items-center gap-2 text-sm">
                          <span>{t("localizationProjects.ui_New_tasks_default_to_isolated_checkout")}</span>
                          <SaveIndicator state={fieldState("execution_workspace_default_mode")} />
                        </div>
                        <div className="text-(length:--text-micro) text-muted-foreground">{t("localizationProjects.ui_If_disabled_new_tasks_stay_on_the_project_s_primary_checkout_unless_someone_opts_in_")}</div>
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

                    <div className="space-y-0.5">
                      <div className="mb-1 flex items-center gap-1.5">
                        <label className="flex items-center gap-2 text-sm">
                          <span>{t("localizationProjects.ui_Shared_workspace_concurrency")}</span>
                          <SaveIndicator state={fieldState("execution_workspace_shared_concurrency")} />
                        </label>
                      </div>
                      {onUpdate || onFieldUpdate ? (
                        <select
                          className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                          aria-label={t("localizationProjects.ui_Shared_workspace_concurrency")}
                          value={executionWorkspaceSharedConcurrency}
                          onChange={(e) =>
                            commitField(
                              "execution_workspace_shared_concurrency",
                              updateExecutionWorkspacePolicy({
                                sharedWorkspaceConcurrency: e.target.value as SharedWorkspaceConcurrency,
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
                        onClick={() => setExecutionWorkspaceAdvancedOpen((open) => !open)}
                      >
                        {executionWorkspaceAdvancedOpen
                          ? t("localizationProjects.ui_Hide_advanced_checkout_settings")
                          : t("localizationProjects.ui_Show_advanced_checkout_settings")}
                      </button>
                    </div>

                    {executionWorkspaceAdvancedOpen ? (
                      <div className="space-y-3">
                        <div className="text-xs text-muted-foreground">{t("localizationProjects.ui_Host_managed_implementation_")}<span className="text-foreground">{t("localizationCommonChrome.gitWorktree")}</span>
                        </div>
                        {showExecutionWorkspaceEnvironmentControl ? (
                          <div>
                            <div className="mb-1 flex items-center gap-1.5">
                              <label className="flex items-center gap-2 text-xs text-muted-foreground">
                                <span>{t("localizationProjects.ui_Environment")}</span>
                                <SaveIndicator state={fieldState("execution_workspace_environment")} />
                              </label>
                            </div>
                            <select
                              className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs outline-none"
                              value={executionWorkspaceEnvironmentId}
                              onChange={(e) =>
                                commitField(
                                  "execution_workspace_environment",
                                  updateExecutionWorkspacePolicy({
                                    environmentId: e.target.value || null,
                                  })!,
                                )}
                            >
                              <option value="">{t("localizationProjects.ui_No_environment")}</option>
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
                              <span>{t("workspaces.fields.baseRef")}</span>
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
                              <span>{t("localizationProjects.ui_Branch_template")}</span>
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
                              <span>{t("localizationProjects.ui_Worktree_parent_dir")}</span>
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
                              <span>{t("workspaces.fields.provisionCommand")}</span>
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
                              <span>{t("workspaces.fields.runtimeProvisionCommand")}</span>
                              <SaveIndicator state={fieldState("execution_workspace_runtime_provision_command")} />
                            </label>
                          </div>
                          <DraftInput
                            value={executionWorkspaceStrategy.runtimeProvisionCommand ?? ""}
                            onCommit={(value) =>
                              commitField("execution_workspace_runtime_provision_command", {
                                ...updateExecutionWorkspacePolicy({
                                  workspaceStrategy: {
                                    ...executionWorkspaceStrategy,
                                    type: "git_worktree",
                                    runtimeProvisionCommand: value || null,
                                  },
                                })!,
                              })}
                            immediate
                            className="w-full rounded border border-border bg-transparent px-2 py-1 text-xs font-mono outline-none"
                            placeholder="bash ./scripts/provision-worktree-runtime.sh"
                          />
                          <p className="mt-1 text-xs text-muted-foreground">{t("localizationProjects.ui_Runs_once_before_the_first_runtime_service_start_heavy_setup_e_g_DB_seed_Leave_empty_to_keep_eager_p")}</p>
                        </div>
                        <div>
                          <div className="mb-1 flex items-center gap-1.5">
                            <label className="flex items-center gap-2 text-xs text-muted-foreground">
                              <span>{t("workspaces.fields.teardownCommand")}</span>
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
                        <p className="text-(length:--text-micro) text-muted-foreground">{t("localizationProjects.ui_Provision_runs_inside_the_derived_worktree_before_agent_execution_Teardown_is_stored_here_for_future")}</p>
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
            <div className="text-xs font-medium text-destructive uppercase tracking-wide">{t("pages.companySettings.dangerZone")}</div>
            <ArchiveDangerZone
              project={project}
              onArchive={onArchive}
              archivePending={archivePending}
            />
          </div>
        </>
      )}
        <PropertyRow label={<FieldLabel label={t("localizationProjects.ui_Created")} state="idle" />}>
          <span className="text-sm">{formatDate(project.createdAt)}</span>
        </PropertyRow>
    </div>
  );
}
