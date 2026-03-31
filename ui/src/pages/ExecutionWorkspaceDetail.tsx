import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace, Project, ProjectWorkspace } from "@penclipai/shared";
import { ArrowLeft, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CopyText } from "../components/CopyText";
import { ExecutionWorkspaceCloseDialog } from "../components/ExecutionWorkspaceCloseDialog";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { humanizeEnumValue, translateStatusLabel } from "../lib/i18n-labels";
import { queryKeys } from "../lib/queryKeys";
import { displaySeededName } from "../lib/seeded-display";
import { cn, formatDateTime, issueUrl, projectRouteRef, projectWorkspaceUrl } from "../lib/utils";
type WorkspaceFormState = {
  name: string;
  cwd: string;
  repoUrl: string;
  baseRef: string;
  branchName: string;
  providerRef: string;
  provisionCommand: string;
  teardownCommand: string;
  cleanupCommand: string;
  inheritRuntime: boolean;
  workspaceRuntime: string;
};

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function readText(value: string | null | undefined) {
  return value ?? "";
}

function formatJson(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseWorkspaceRuntimeJson(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, value: null as Record<string, unknown> | null };

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: "Workspace runtime JSON must be a JSON object.",
      };
    }
    return { ok: true as const, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : "Invalid JSON.",
    };
  }
}

function formStateFromWorkspace(workspace: ExecutionWorkspace): WorkspaceFormState {
  return {
    name: workspace.name,
    cwd: readText(workspace.cwd),
    repoUrl: readText(workspace.repoUrl),
    baseRef: readText(workspace.baseRef),
    branchName: readText(workspace.branchName),
    providerRef: readText(workspace.providerRef),
    provisionCommand: readText(workspace.config?.provisionCommand),
    teardownCommand: readText(workspace.config?.teardownCommand),
    cleanupCommand: readText(workspace.config?.cleanupCommand),
    inheritRuntime: !workspace.config?.workspaceRuntime,
    workspaceRuntime: formatJson(workspace.config?.workspaceRuntime),
  };
}

function buildWorkspacePatch(initialState: WorkspaceFormState, nextState: WorkspaceFormState) {
  const patch: Record<string, unknown> = {};
  const configPatch: Record<string, unknown> = {};

  const maybeAssign = (
    key: keyof Pick<WorkspaceFormState, "name" | "cwd" | "repoUrl" | "baseRef" | "branchName" | "providerRef">,
  ) => {
    if (initialState[key] === nextState[key]) return;
    patch[key] = key === "name" ? (normalizeText(nextState[key]) ?? initialState.name) : normalizeText(nextState[key]);
  };

  maybeAssign("name");
  maybeAssign("cwd");
  maybeAssign("repoUrl");
  maybeAssign("baseRef");
  maybeAssign("branchName");
  maybeAssign("providerRef");

  const maybeAssignConfigText = (key: keyof Pick<WorkspaceFormState, "provisionCommand" | "teardownCommand" | "cleanupCommand">) => {
    if (initialState[key] === nextState[key]) return;
    configPatch[key] = normalizeText(nextState[key]);
  };

  maybeAssignConfigText("provisionCommand");
  maybeAssignConfigText("teardownCommand");
  maybeAssignConfigText("cleanupCommand");

  if (initialState.inheritRuntime !== nextState.inheritRuntime || initialState.workspaceRuntime !== nextState.workspaceRuntime) {
    const parsed = parseWorkspaceRuntimeJson(nextState.workspaceRuntime);
    if (!parsed.ok) throw new Error(parsed.error);
    configPatch.workspaceRuntime = nextState.inheritRuntime ? null : parsed.value;
  }

  if (Object.keys(configPatch).length > 0) {
    patch.config = configPatch;
  }

  return patch;
}

function validateForm(form: WorkspaceFormState) {
  const repoUrl = normalizeText(form.repoUrl);
  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return "Repo URL must be a valid URL.";
    }
  }

  if (!form.inheritRuntime) {
    const runtimeJson = parseWorkspaceRuntimeJson(form.workspaceRuntime);
    if (!runtimeJson.ok) {
      return runtimeJson.error;
    }
  }

  return null;
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <label className="space-y-1.5">
      <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between sm:gap-3">
        <span className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{label}</span>
        {hint ? <span className="text-[11px] leading-relaxed text-muted-foreground sm:text-right">{hint}</span> : null}
      </div>
      {children}
    </label>
  );
}

function DetailRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1.5 py-1.5 sm:flex-row sm:items-start sm:gap-3">
      <div className="shrink-0 text-xs text-muted-foreground sm:w-32">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

function StatusPill({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground", className)}>
      {children}
    </div>
  );
}

function MonoValue({ value, copy, copiedLabel }: { value: string; copy?: boolean; copiedLabel?: string }) {
  return (
    <div className="inline-flex max-w-full items-start gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      {copy ? (
        <CopyText text={value} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={copiedLabel ?? "Copied"}>
          <Copy className="h-3.5 w-3.5" />
        </CopyText>
      ) : null}
    </div>
  );
}

function WorkspaceLink({
  project,
  workspace,
}: {
  project: Project;
  workspace: ProjectWorkspace;
}) {
  return <Link to={projectWorkspaceUrl(project, workspace.id)} className="hover:underline">{workspace.name}</Link>;
}

export function ExecutionWorkspaceDetail() {
  const { t } = useTranslation();
  const { workspaceId } = useParams<{ workspaceId: string }>();
  const queryClient = useQueryClient();
  const { setBreadcrumbs } = useBreadcrumbs();
  const { selectedCompanyId, setSelectedCompanyId } = useCompany();
  const [form, setForm] = useState<WorkspaceFormState | null>(null);
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);

  const workspaceQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.detail(workspaceId!),
    queryFn: () => executionWorkspacesApi.get(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const workspace = workspaceQuery.data ?? null;
  const projectQuery = useQuery({
    queryKey: workspace ? [...queryKeys.projects.detail(workspace.projectId), workspace.companyId] : ["projects", "detail", "__pending__"],
    queryFn: () => projectsApi.get(workspace!.projectId, workspace!.companyId),
    enabled: Boolean(workspace?.projectId),
  });
  const project = projectQuery.data ?? null;

  const sourceIssueQuery = useQuery({
    queryKey: workspace?.sourceIssueId ? queryKeys.issues.detail(workspace.sourceIssueId) : ["issues", "detail", "__none__"],
    queryFn: () => issuesApi.get(workspace!.sourceIssueId!),
    enabled: Boolean(workspace?.sourceIssueId),
  });
  const sourceIssue = sourceIssueQuery.data ?? null;

  const derivedWorkspaceQuery = useQuery({
    queryKey: workspace?.derivedFromExecutionWorkspaceId
      ? queryKeys.executionWorkspaces.detail(workspace.derivedFromExecutionWorkspaceId)
      : ["execution-workspaces", "detail", "__none__"],
    queryFn: () => executionWorkspacesApi.get(workspace!.derivedFromExecutionWorkspaceId!),
    enabled: Boolean(workspace?.derivedFromExecutionWorkspaceId),
  });
  const derivedWorkspace = derivedWorkspaceQuery.data ?? null;
  const linkedIssuesQuery = useQuery({
    queryKey: workspace
      ? queryKeys.issues.listByExecutionWorkspace(workspace.companyId, workspace.id)
      : ["issues", "__execution-workspace__", "__none__"],
    queryFn: () => issuesApi.list(workspace!.companyId, { executionWorkspaceId: workspace!.id }),
    enabled: Boolean(workspace?.companyId),
  });
  const linkedIssues = linkedIssuesQuery.data ?? [];

  const linkedProjectWorkspace = useMemo(
    () => project?.workspaces.find((item) => item.id === workspace?.projectWorkspaceId) ?? null,
    [project, workspace?.projectWorkspaceId],
  );
  const inheritedRuntimeConfig = linkedProjectWorkspace?.runtimeConfig?.workspaceRuntime ?? null;
  const effectiveRuntimeConfig = workspace?.config?.workspaceRuntime ?? inheritedRuntimeConfig;
  const runtimeConfigSource =
    workspace?.config?.workspaceRuntime
      ? "execution_workspace"
      : inheritedRuntimeConfig
        ? "project_workspace"
        : "none";

  const initialState = useMemo(() => (workspace ? formStateFromWorkspace(workspace) : null), [workspace]);
  const isDirty = Boolean(form && initialState && JSON.stringify(form) !== JSON.stringify(initialState));
  const projectRef = project ? projectRouteRef(project) : workspace?.projectId ?? "";

  useEffect(() => {
    if (!workspace?.companyId || workspace.companyId === selectedCompanyId) return;
    setSelectedCompanyId(workspace.companyId, { source: "route_sync" });
  }, [workspace?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!workspace) return;
    setForm(formStateFromWorkspace(workspace));
    setErrorMessage(null);
  }, [workspace]);

  useEffect(() => {
    if (!workspace) return;
    const crumbs = [
      { label: t("Projects", { defaultValue: "Projects" }), href: "/projects" },
      ...(project ? [{ label: displaySeededName(project.name), href: `/projects/${projectRef}` }] : []),
      ...(project ? [{ label: t("Workspaces", { defaultValue: "Workspaces" }), href: `/projects/${projectRef}/workspaces` }] : []),
      { label: workspace.name },
    ];
    setBreadcrumbs(crumbs);
  }, [project, projectRef, setBreadcrumbs, t, workspace]);

  const updateWorkspace = useMutation({
    mutationFn: (patch: Record<string, unknown>) => executionWorkspacesApi.update(workspace!.id, patch),
    onSuccess: (nextWorkspace) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(nextWorkspace.id), nextWorkspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(nextWorkspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(nextWorkspace.id) });
      if (project) {
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
      }
      if (sourceIssue) {
        queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
      }
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("Failed to save execution workspace.", { defaultValue: "Failed to save execution workspace." }),
      );
    },
  });
  const workspaceOperationsQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.workspaceOperations(workspaceId!),
    queryFn: () => executionWorkspacesApi.listWorkspaceOperations(workspaceId!),
    enabled: Boolean(workspaceId),
  });
  const controlRuntimeServices = useMutation({
    mutationFn: (action: "start" | "stop" | "restart") =>
      executionWorkspacesApi.controlRuntimeServices(workspace!.id, action),
    onSuccess: (result, action) => {
      queryClient.setQueryData(queryKeys.executionWorkspaces.detail(result.workspace.id), result.workspace);
      queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(result.workspace.id) });
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(result.workspace.projectId) });
      setErrorMessage(null);
      setRuntimeActionMessage(
        action === "stop"
          ? t("Runtime services stopped.", { defaultValue: "Runtime services stopped." })
          : action === "restart"
            ? t("Runtime services restarted.", { defaultValue: "Runtime services restarted." })
            : t("Runtime services started.", { defaultValue: "Runtime services started." }),
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setErrorMessage(
        error instanceof Error
          ? error.message
          : t("Failed to control runtime services.", { defaultValue: "Failed to control runtime services." }),
      );
    },
  });

  if (workspaceQuery.isLoading) {
    return <p className="text-sm text-muted-foreground">{t("Loading workspace...", { defaultValue: "Loading workspace..." })}</p>;
  }
  if (workspaceQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {workspaceQuery.error instanceof Error
          ? workspaceQuery.error.message
          : t("Failed to load workspace", { defaultValue: "Failed to load workspace" })}
      </p>
    );
  }
  if (!workspace || !form || !initialState) return null;

  const saveChanges = () => {
    const validationError = validateForm(form);
    if (validationError) {
      setErrorMessage(t(validationError, { defaultValue: validationError }));
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = buildWorkspacePatch(initialState, form);
    } catch (error) {
      setErrorMessage(
        error instanceof Error
          ? t(error.message, { defaultValue: error.message })
          : t("Failed to build workspace update.", { defaultValue: "Failed to build workspace update." }),
      );
      return;
    }

    if (Object.keys(patch).length === 0) return;
    updateWorkspace.mutate(patch);
  };

  const statusLabel = translateStatusLabel(t, workspace.status);
  const modeLabel = t(`executionWorkspace.mode.${workspace.mode}`, {
    defaultValue: humanizeEnumValue(workspace.mode),
  });
  const providerTypeLabel = t(`executionWorkspace.providerType.${workspace.providerType}`, {
    defaultValue: humanizeEnumValue(workspace.providerType),
  });
  const noneLabel = t("common.none", { defaultValue: "None" });
  const copiedLabel = t("Copied", { defaultValue: "Copied" });
  const cleanupLabel = workspace.cleanupEligibleAt
    ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
    : t("executionWorkspace.cleanupNotScheduled");

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to={project ? `/projects/${projectRef}/workspaces` : "/projects"}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              {t("Back to all workspaces", { defaultValue: "Back to all workspaces" })}
            </Link>
          </Button>
          <StatusPill>{modeLabel}</StatusPill>
          <StatusPill>{providerTypeLabel}</StatusPill>
          <StatusPill className={workspace.status === "active" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : undefined}>
            {statusLabel}
          </StatusPill>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.95fr)]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    {t("Execution workspace", { defaultValue: "Execution workspace" })}
                  </div>
                  <h1 className="text-2xl font-semibold">{workspace.name}</h1>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    {t(
                      "Configure the concrete runtime workspace that Paperclip CN reuses for this issue flow. These settings stay attached to the execution workspace so future runs can keep local paths, repo refs, provisioning, teardown, and runtime-service behavior in sync with the actual workspace being reused.",
                      {
                        defaultValue:
                          "Configure the concrete runtime workspace that Paperclip CN reuses for this issue flow. These settings stay attached to the execution workspace so future runs can keep local paths, repo refs, provisioning, teardown, and runtime-service behavior in sync with the actual workspace being reused.",
                      },
                    )}
                  </p>
                </div>
                <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => setCloseDialogOpen(true)}
                    disabled={workspace.status === "archived"}
                  >
                    {workspace.status === "cleanup_failed"
                      ? t("Retry close", { defaultValue: "Retry close" })
                      : t("Close workspace", { defaultValue: "Close workspace" })}
                  </Button>
                </div>
              </div>

              <Separator className="my-5" />

              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("Workspace name", { defaultValue: "Workspace name" })}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.name}
                    onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                    placeholder={t("Execution workspace name", { defaultValue: "Execution workspace name" })}
                  />
                </Field>
                <Field
                  label={t("Branch name", { defaultValue: "Branch name" })}
                  hint={t("Useful for isolated worktrees", { defaultValue: "Useful for isolated worktrees" })}
                >
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.branchName}
                    onChange={(event) => setForm((current) => current ? { ...current, branchName: event.target.value } : current)}
                    placeholder="PAP-946-workspace"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label={t("Working directory", { defaultValue: "Working directory" })}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cwd}
                    onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                    placeholder="/absolute/path/to/workspace"
                  />
                </Field>
                <Field label={t("Provider path / ref", { defaultValue: "Provider path / ref" })}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.providerRef}
                    onChange={(event) => setForm((current) => current ? { ...current, providerRef: event.target.value } : current)}
                    placeholder={t("/path/to/worktree or provider ref", { defaultValue: "/path/to/worktree or provider ref" })}
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label={t("Repo URL", { defaultValue: "Repo URL" })}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.repoUrl}
                    onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                    placeholder="https://github.com/org/repo"
                  />
                </Field>
                <Field label={t("Base ref", { defaultValue: "Base ref" })}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.baseRef}
                    onChange={(event) => setForm((current) => current ? { ...current, baseRef: event.target.value } : current)}
                    placeholder="origin/main"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field
                  label={t("Provision command", { defaultValue: "Provision command" })}
                  hint={t("Runs when Paperclip CN prepares this execution workspace", {
                    defaultValue: "Runs when Paperclip CN prepares this execution workspace",
                  })}
                >
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.provisionCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, provisionCommand: event.target.value } : current)}
                    placeholder="bash ./scripts/provision-worktree.sh"
                  />
                </Field>
                <Field
                  label={t("Teardown command", { defaultValue: "Teardown command" })}
                  hint={t("Runs when the execution workspace is archived or cleaned up", {
                    defaultValue: "Runs when the execution workspace is archived or cleaned up",
                  })}
                >
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.teardownCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, teardownCommand: event.target.value } : current)}
                    placeholder="bash ./scripts/teardown-worktree.sh"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4">
                <Field
                  label={t("Cleanup command", { defaultValue: "Cleanup command" })}
                  hint={t("Workspace-specific cleanup before teardown", {
                    defaultValue: "Workspace-specific cleanup before teardown",
                  })}
                >
                  <textarea
                    className="min-h-24 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cleanupCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, cleanupCommand: event.target.value } : current)}
                    placeholder="pkill -f vite || true"
                  />
                </Field>

                <div className="rounded-xl border border-dashed border-border/70 bg-muted/20 px-3 py-3">
                  <div className="flex flex-col gap-3 sm:flex-row sm:flex-wrap sm:items-center sm:justify-between">
                    <div>
                      <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                        {t("Runtime config source", { defaultValue: "Runtime config source" })}
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {runtimeConfigSource === "execution_workspace"
                          ? t("This execution workspace currently overrides the project workspace runtime config.", {
                              defaultValue: "This execution workspace currently overrides the project workspace runtime config.",
                            })
                          : runtimeConfigSource === "project_workspace"
                            ? t("This execution workspace is inheriting the project workspace runtime config.", {
                                defaultValue: "This execution workspace is inheriting the project workspace runtime config.",
                              })
                            : t("No runtime config is currently defined on this execution workspace or its project workspace.", {
                                defaultValue: "No runtime config is currently defined on this execution workspace or its project workspace.",
                              })}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      className="w-full sm:w-auto"
                      size="sm"
                      disabled={!linkedProjectWorkspace?.runtimeConfig?.workspaceRuntime}
                      onClick={() =>
                        setForm((current) => current ? {
                          ...current,
                          inheritRuntime: true,
                          workspaceRuntime: "",
                        } : current)
                      }
                    >
                      {t("Reset to inherit", { defaultValue: "Reset to inherit" })}
                    </Button>
                  </div>
                </div>

                <Field
                  label={t("Runtime services JSON", { defaultValue: "Runtime services JSON" })}
                  hint={t(
                    "Concrete workspace runtime settings for this execution workspace. Leave this inheriting unless you need a one-off override. If you are missing the right commands, ask your CEO to set them up for you.",
                    {
                      defaultValue:
                        "Concrete workspace runtime settings for this execution workspace. Leave this inheriting unless you need a one-off override. If you are missing the right commands, ask your CEO to set them up for you.",
                    },
                  )}
                >
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      id="inherit-runtime-config"
                      type="checkbox"
                      checked={form.inheritRuntime}
                      onChange={(event) =>
                        setForm((current) => current ? { ...current, inheritRuntime: event.target.checked } : current)
                      }
                    />
                    <label htmlFor="inherit-runtime-config">
                      {t("Inherit project workspace runtime config", {
                        defaultValue: "Inherit project workspace runtime config",
                      })}
                    </label>
                  </div>
                  <textarea
                    className="min-h-48 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none disabled:cursor-not-allowed disabled:opacity-60"
                    value={form.workspaceRuntime}
                    onChange={(event) => setForm((current) => current ? { ...current, workspaceRuntime: event.target.value } : current)}
                    disabled={form.inheritRuntime}
                    placeholder={'{\n  "services": [\n    {\n      "name": "web",\n      "command": "pnpm dev",\n      "port": 3100\n    }\n  ]\n}'}
                  />
                </Field>
              </div>

              <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
                <Button className="w-full sm:w-auto" disabled={!isDirty || updateWorkspace.isPending} onClick={saveChanges}>
                  {updateWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                  {t("Save changes", { defaultValue: "Save changes" })}
                </Button>
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={!isDirty || updateWorkspace.isPending}
                  onClick={() => {
                    setForm(initialState);
                    setErrorMessage(null);
                    setRuntimeActionMessage(null);
                  }}
                >
                  {t("Reset", { defaultValue: "Reset" })}
                </Button>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                {!errorMessage && runtimeActionMessage ? <p className="text-sm text-muted-foreground">{runtimeActionMessage}</p> : null}
                {!errorMessage && !isDirty ? (
                  <p className="text-sm text-muted-foreground">{t("No unsaved changes.", { defaultValue: "No unsaved changes." })}</p>
                ) : null}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("Linked objects", { defaultValue: "Linked objects" })}</div>
                <h2 className="text-lg font-semibold">{t("Workspace context", { defaultValue: "Workspace context" })}</h2>
              </div>
              <Separator className="my-4" />
              <DetailRow label={t("Project", { defaultValue: "Project" })}>
                {project ? <Link to={`/projects/${projectRef}`} className="hover:underline">{displaySeededName(project.name)}</Link> : <MonoValue value={workspace.projectId} copiedLabel={copiedLabel} />}
              </DetailRow>
              <DetailRow label={t("Project workspace", { defaultValue: "Project workspace" })}>
                {project && linkedProjectWorkspace ? (
                  <WorkspaceLink project={project} workspace={linkedProjectWorkspace} />
                ) : workspace.projectWorkspaceId ? (
                  <MonoValue value={workspace.projectWorkspaceId} copiedLabel={copiedLabel} />
                ) : (
                  noneLabel
                )}
              </DetailRow>
              <DetailRow label={t("Source issue", { defaultValue: "Source issue" })}>
                {sourceIssue ? (
                  <Link to={issueUrl(sourceIssue)} className="hover:underline">
                    {sourceIssue.identifier ?? sourceIssue.id} · {sourceIssue.title}
                  </Link>
                ) : workspace.sourceIssueId ? (
                  <MonoValue value={workspace.sourceIssueId} copiedLabel={copiedLabel} />
                ) : (
                  noneLabel
                )}
              </DetailRow>
              <DetailRow label={t("Derived from", { defaultValue: "Derived from" })}>
                {derivedWorkspace ? (
                  <Link to={`/execution-workspaces/${derivedWorkspace.id}`} className="hover:underline">
                    {derivedWorkspace.name}
                  </Link>
                ) : workspace.derivedFromExecutionWorkspaceId ? (
                  <MonoValue value={workspace.derivedFromExecutionWorkspaceId} copiedLabel={copiedLabel} />
                ) : (
                  noneLabel
                )}
              </DetailRow>
              <DetailRow label={t("Workspace ID", { defaultValue: "Workspace ID" })}>
                <MonoValue value={workspace.id} copiedLabel={copiedLabel} />
              </DetailRow>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("Paths and refs", { defaultValue: "Paths and refs" })}</div>
                <h2 className="text-lg font-semibold">{t("Concrete location", { defaultValue: "Concrete location" })}</h2>
              </div>
              <Separator className="my-4" />
              <DetailRow label={t("Working dir", { defaultValue: "Working dir" })}>
                {workspace.cwd ? <MonoValue value={workspace.cwd} copy copiedLabel={copiedLabel} /> : noneLabel}
              </DetailRow>
              <DetailRow label={t("Provider ref", { defaultValue: "Provider ref" })}>
                {workspace.providerRef ? <MonoValue value={workspace.providerRef} copy copiedLabel={copiedLabel} /> : noneLabel}
              </DetailRow>
              <DetailRow label={t("Repo URL", { defaultValue: "Repo URL" })}>
                {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                  <div className="inline-flex max-w-full items-start gap-2">
                    <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all hover:underline">
                      {workspace.repoUrl}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                    <CopyText text={workspace.repoUrl} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel={copiedLabel}>
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                ) : workspace.repoUrl ? (
                  <MonoValue value={workspace.repoUrl} copy copiedLabel={copiedLabel} />
                ) : (
                  noneLabel
                )}
              </DetailRow>
              <DetailRow label={t("Base ref", { defaultValue: "Base ref" })}>
                {workspace.baseRef ? <MonoValue value={workspace.baseRef} copy copiedLabel={copiedLabel} /> : noneLabel}
              </DetailRow>
              <DetailRow label={t("Branch", { defaultValue: "Branch" })}>
                {workspace.branchName ? <MonoValue value={workspace.branchName} copy copiedLabel={copiedLabel} /> : noneLabel}
              </DetailRow>
              <DetailRow label={t("Opened", { defaultValue: "Opened" })}>{formatDateTime(workspace.openedAt)}</DetailRow>
              <DetailRow label={t("Last used", { defaultValue: "Last used" })}>{formatDateTime(workspace.lastUsedAt)}</DetailRow>
              <DetailRow label={t("Cleanup", { defaultValue: "Cleanup" })}>
                {cleanupLabel}
              </DetailRow>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("Runtime services", { defaultValue: "Runtime services" })}</div>
                  <h2 className="text-lg font-semibold">{t("Attached services", { defaultValue: "Attached services" })}</h2>
                  <p className="text-sm text-muted-foreground">
                    {t("Source", { defaultValue: "Source" })}: {runtimeConfigSource === "execution_workspace"
                      ? t("execution workspace override", { defaultValue: "execution workspace override" })
                      : runtimeConfigSource === "project_workspace"
                        ? t("project workspace default", { defaultValue: "project workspace default" })
                        : noneLabel}
                  </p>
                </div>
                <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap">
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={controlRuntimeServices.isPending || !effectiveRuntimeConfig || !workspace.cwd}
                    onClick={() => controlRuntimeServices.mutate("start")}
                  >
                    {controlRuntimeServices.isPending ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : null}
                    {t("Start", { defaultValue: "Start" })}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={controlRuntimeServices.isPending || !effectiveRuntimeConfig || !workspace.cwd}
                    onClick={() => controlRuntimeServices.mutate("restart")}
                  >
                    {t("Restart", { defaultValue: "Restart" })}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={controlRuntimeServices.isPending || (workspace.runtimeServices?.length ?? 0) === 0}
                    onClick={() => controlRuntimeServices.mutate("stop")}
                  >
                    {t("Stop", { defaultValue: "Stop" })}
                  </Button>
                </div>
              </div>
              <Separator className="my-4" />
              {workspace.runtimeServices && workspace.runtimeServices.length > 0 ? (
                <div className="space-y-3">
                  {workspace.runtimeServices.map((service) => (
                    <div key={service.id} className="rounded-xl border border-border/80 bg-background px-3 py-2">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-medium">{service.serviceName}</div>
                          <div className="text-xs text-muted-foreground">
                            {t(service.status, { defaultValue: humanizeEnumValue(service.status) })} · {t(service.lifecycle, {
                              defaultValue: humanizeEnumValue(service.lifecycle),
                            })}
                          </div>
                          <div className="space-y-1 text-xs text-muted-foreground">
                            {service.url ? (
                              <a href={service.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                                {service.url}
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                            {service.port ? <div>{t("Port {{value}}", { value: service.port, defaultValue: `Port ${service.port}` })}</div> : null}
                            {service.command ? <MonoValue value={service.command} copy copiedLabel={copiedLabel} /> : null}
                            {service.cwd ? <MonoValue value={service.cwd} copy copiedLabel={copiedLabel} /> : null}
                          </div>
                        </div>
                        <StatusPill className="self-start">{t(service.healthStatus, { defaultValue: humanizeEnumValue(service.healthStatus) })}</StatusPill>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {effectiveRuntimeConfig
                    ? t("No runtime services are currently running for this execution workspace.", {
                        defaultValue: "No runtime services are currently running for this execution workspace.",
                      })
                    : t("No runtime config is defined for this execution workspace yet.", {
                        defaultValue: "No runtime config is defined for this execution workspace yet.",
                      })}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("Recent operations", { defaultValue: "Recent operations" })}</div>
                <h2 className="text-lg font-semibold">{t("Runtime and cleanup logs", { defaultValue: "Runtime and cleanup logs" })}</h2>
              </div>
              <Separator className="my-4" />
              {workspaceOperationsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">{t("Loading workspace operations...", { defaultValue: "Loading workspace operations..." })}</p>
              ) : workspaceOperationsQuery.error ? (
                <p className="text-sm text-destructive">
                  {workspaceOperationsQuery.error instanceof Error
                    ? workspaceOperationsQuery.error.message
                    : t("Failed to load workspace operations.", { defaultValue: "Failed to load workspace operations." })}
                </p>
              ) : workspaceOperationsQuery.data && workspaceOperationsQuery.data.length > 0 ? (
                <div className="space-y-3">
                  {workspaceOperationsQuery.data.slice(0, 6).map((operation) => (
                    <div key={operation.id} className="rounded-xl border border-border/80 bg-background px-3 py-2">
                      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                        <div className="space-y-1">
                          <div className="text-sm font-medium">{operation.command ?? operation.phase}</div>
                          <div className="text-xs text-muted-foreground">
                            {formatDateTime(operation.startedAt)}
                            {operation.finishedAt ? ` → ${formatDateTime(operation.finishedAt)}` : ""}
                          </div>
                          {operation.stderrExcerpt ? (
                            <div className="whitespace-pre-wrap break-words text-xs text-destructive">{operation.stderrExcerpt}</div>
                          ) : operation.stdoutExcerpt ? (
                            <div className="whitespace-pre-wrap break-words text-xs text-muted-foreground">{operation.stdoutExcerpt}</div>
                          ) : null}
                        </div>
                        <StatusPill className="self-start">{t(operation.status, { defaultValue: humanizeEnumValue(operation.status) })}</StatusPill>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {t("No workspace operations have been recorded yet.", { defaultValue: "No workspace operations have been recorded yet." })}
                </p>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("Linked issues", { defaultValue: "Linked issues" })}</div>
              <h2 className="text-lg font-semibold">{t("Issues using this workspace", { defaultValue: "Issues using this workspace" })}</h2>
              <p className="text-sm text-muted-foreground">
                {t(
                  "Any issue attached to this execution workspace appears here so you can review the full session context before reusing or closing it.",
                  {
                    defaultValue:
                      "Any issue attached to this execution workspace appears here so you can review the full session context before reusing or closing it.",
                  },
                )}
              </p>
            </div>
            <StatusPill>{t("{{count}} linked", { count: linkedIssues.length, defaultValue: `${linkedIssues.length} linked` })}</StatusPill>
          </div>
          <Separator className="my-4" />
          {linkedIssuesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">{t("Loading linked issues...", { defaultValue: "Loading linked issues..." })}</p>
          ) : linkedIssuesQuery.error ? (
            <p className="text-sm text-destructive">
              {linkedIssuesQuery.error instanceof Error
                ? linkedIssuesQuery.error.message
                : t("Failed to load linked issues.", { defaultValue: "Failed to load linked issues." })}
            </p>
          ) : linkedIssues.length > 0 ? (
            <div className="-mx-1 flex gap-3 overflow-x-auto px-1 pb-1">
              {linkedIssues.map((issue) => (
                <Link
                  key={issue.id}
                  to={issueUrl(issue)}
                  className="min-w-72 rounded-xl border border-border/80 bg-background px-4 py-3 transition-colors hover:bg-accent/20"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0 space-y-1">
                      <div className="font-mono text-xs text-muted-foreground">
                        {issue.identifier ?? issue.id.slice(0, 8)}
                      </div>
                      <div className="line-clamp-2 text-sm font-medium">{issue.title}</div>
                    </div>
                    <StatusPill className="shrink-0">{translateStatusLabel(t, issue.status)}</StatusPill>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="uppercase tracking-[0.16em]">{t(issue.priority, { defaultValue: humanizeEnumValue(issue.priority) })}</span>
                    <span>{formatDateTime(issue.updatedAt)}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              {t("No issues are currently linked to this execution workspace.", {
                defaultValue: "No issues are currently linked to this execution workspace.",
              })}
            </p>
          )}
        </div>
      </div>
      <ExecutionWorkspaceCloseDialog
        workspaceId={workspace.id}
        workspaceName={workspace.name}
        currentStatus={workspace.status}
        open={closeDialogOpen}
        onOpenChange={setCloseDialogOpen}
        onClosed={(nextWorkspace) => {
          queryClient.setQueryData(queryKeys.executionWorkspaces.detail(nextWorkspace.id), nextWorkspace);
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.closeReadiness(nextWorkspace.id) });
          queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.workspaceOperations(nextWorkspace.id) });
          if (project) {
            queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
            queryClient.invalidateQueries({ queryKey: queryKeys.executionWorkspaces.list(project.companyId, { projectId: project.id }) });
          }
          if (sourceIssue) {
            queryClient.invalidateQueries({ queryKey: queryKeys.issues.detail(sourceIssue.id) });
          }
        }}
      />
    </>
  );
}
