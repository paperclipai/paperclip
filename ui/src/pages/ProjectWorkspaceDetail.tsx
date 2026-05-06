import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { Link, useNavigate, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { isUuidLike, type ProjectWorkspace } from "@paperclipai/shared";
import { ArrowLeft, Check, ExternalLink, Loader2, Sparkles } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ChoosePathButton } from "../components/PathInstructionsModal";
import { projectsApi } from "../api/projects";
import {
  buildWorkspaceRuntimeControlSections,
  WorkspaceRuntimeControls,
  type WorkspaceRuntimeControlRequest,
} from "../components/WorkspaceRuntimeControls";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
import { projectRouteRef, projectWorkspaceUrl } from "../lib/utils";

type WorkspaceFormState = {
  name: string;
  sourceType: ProjectWorkspaceSourceType;
  cwd: string;
  repoUrl: string;
  repoRef: string;
  defaultRef: string;
  visibility: ProjectWorkspaceVisibility;
  setupCommand: string;
  cleanupCommand: string;
  remoteProvider: string;
  remoteWorkspaceRef: string;
  sharedWorkspaceKey: string;
  runtimeConfig: string;
};

type ProjectWorkspaceSourceType = ProjectWorkspace["sourceType"];
type ProjectWorkspaceVisibility = ProjectWorkspace["visibility"];

const SOURCE_TYPE_VALUES: ReadonlyArray<ProjectWorkspaceSourceType> = [
  "local_path",
  "non_git_path",
  "git_repo",
  "remote_managed",
];

const VISIBILITY_VALUES: ReadonlyArray<ProjectWorkspaceVisibility> = ["default", "advanced"];

function isSafeExternalUrl(value: string | null | undefined) {
  if (!value) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function isAbsolutePath(value: string) {
  return value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value);
}

function readText(value: string | null | undefined) {
  return value ?? "";
}

function formatJson(value: Record<string, unknown> | null | undefined) {
  if (!value || Object.keys(value).length === 0) return "";
  return JSON.stringify(value, null, 2);
}

function formStateFromWorkspace(workspace: ProjectWorkspace): WorkspaceFormState {
  return {
    name: workspace.name,
    sourceType: workspace.sourceType,
    cwd: readText(workspace.cwd),
    repoUrl: readText(workspace.repoUrl),
    repoRef: readText(workspace.repoRef),
    defaultRef: readText(workspace.defaultRef),
    visibility: workspace.visibility,
    setupCommand: readText(workspace.setupCommand),
    cleanupCommand: readText(workspace.cleanupCommand),
    remoteProvider: readText(workspace.remoteProvider),
    remoteWorkspaceRef: readText(workspace.remoteWorkspaceRef),
    sharedWorkspaceKey: readText(workspace.sharedWorkspaceKey),
    runtimeConfig: formatJson(workspace.runtimeConfig?.workspaceRuntime),
  };
}

function normalizeText(value: string) {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function parseRuntimeConfigJson(value: string, errors: { jsonObject: string; invalidJson: string }) {
  const trimmed = value.trim();
  if (!trimmed) return { ok: true as const, value: null as Record<string, unknown> | null };

  try {
    const parsed = JSON.parse(trimmed);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        ok: false as const,
        error: errors.jsonObject,
      };
    }
    return { ok: true as const, value: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false as const,
      error: error instanceof Error ? error.message : errors.invalidJson,
    };
  }
}

function buildWorkspacePatch(
  initialState: WorkspaceFormState,
  nextState: WorkspaceFormState,
  jsonErrors: { jsonObject: string; invalidJson: string },
) {
  const patch: Record<string, unknown> = {};
  const maybeAssign = (key: keyof WorkspaceFormState, transform?: (value: string) => unknown) => {
    const initialValue = initialState[key];
    const nextValue = nextState[key];
    if (initialValue === nextValue) return;
    patch[key] = transform ? transform(nextValue) : nextValue;
  };

  maybeAssign("name", normalizeText);
  maybeAssign("sourceType");
  maybeAssign("cwd", normalizeText);
  maybeAssign("repoUrl", normalizeText);
  maybeAssign("repoRef", normalizeText);
  maybeAssign("defaultRef", normalizeText);
  maybeAssign("visibility");
  maybeAssign("setupCommand", normalizeText);
  maybeAssign("cleanupCommand", normalizeText);
  maybeAssign("remoteProvider", normalizeText);
  maybeAssign("remoteWorkspaceRef", normalizeText);
  maybeAssign("sharedWorkspaceKey", normalizeText);
  if (initialState.runtimeConfig !== nextState.runtimeConfig) {
    const parsed = parseRuntimeConfigJson(nextState.runtimeConfig, jsonErrors);
    if (!parsed.ok) throw new Error(parsed.error);
    patch.runtimeConfig = {
      workspaceRuntime: parsed.value,
    };
  }

  return patch;
}

function validateWorkspaceForm(
  form: WorkspaceFormState,
  errors: {
    remoteRequiresRef: string;
    requiresPathOrRepo: string;
    pathMustBeAbsolute: string;
    repoUrlInvalid: string;
    jsonObject: string;
    invalidJson: string;
  },
) {
  const cwd = normalizeText(form.cwd);
  const repoUrl = normalizeText(form.repoUrl);
  const remoteWorkspaceRef = normalizeText(form.remoteWorkspaceRef);

  if (form.sourceType === "remote_managed") {
    if (!remoteWorkspaceRef && !repoUrl) {
      return errors.remoteRequiresRef;
    }
  } else if (!cwd && !repoUrl) {
    return errors.requiresPathOrRepo;
  }

  if (cwd && (form.sourceType === "local_path" || form.sourceType === "non_git_path") && !isAbsolutePath(cwd)) {
    return errors.pathMustBeAbsolute;
  }

  if (repoUrl) {
    try {
      new URL(repoUrl);
    } catch {
      return errors.repoUrlInvalid;
    }
  }

  const runtimeConfig = parseRuntimeConfigJson(form.runtimeConfig, {
    jsonObject: errors.jsonObject,
    invalidJson: errors.invalidJson,
  });
  if (!runtimeConfig.ok) {
    return runtimeConfig.error;
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
      <div className="shrink-0 text-xs text-muted-foreground sm:w-28">{label}</div>
      <div className="min-w-0 flex-1 text-sm">{children}</div>
    </div>
  );
}

export function ProjectWorkspaceDetail() {
  const { t } = useTranslation("common");
  const { companyPrefix, projectId, workspaceId } = useParams<{
    companyPrefix?: string;
    projectId: string;
    workspaceId: string;
  }>();
  const { companies, selectedCompanyId, setSelectedCompanyId } = useCompany();
  const { setBreadcrumbs } = useBreadcrumbs();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [form, setForm] = useState<WorkspaceFormState | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [runtimeActionMessage, setRuntimeActionMessage] = useState<string | null>(null);
  const routeProjectRef = projectId ?? "";
  const routeWorkspaceId = workspaceId ?? "";

  const routeCompanyId = useMemo(() => {
    if (!companyPrefix) return null;
    const requestedPrefix = companyPrefix.toUpperCase();
    return companies.find((company) => company.issuePrefix.toUpperCase() === requestedPrefix)?.id ?? null;
  }, [companies, companyPrefix]);

  const lookupCompanyId = routeCompanyId ?? selectedCompanyId ?? undefined;
  const canFetchProject = routeProjectRef.length > 0 && (isUuidLike(routeProjectRef) || Boolean(lookupCompanyId));
  const projectQuery = useQuery({
    queryKey: [...queryKeys.projects.detail(routeProjectRef), lookupCompanyId ?? null],
    queryFn: () => projectsApi.get(routeProjectRef, lookupCompanyId),
    enabled: canFetchProject,
  });

  const project = projectQuery.data ?? null;
  const workspace = useMemo(
    () => project?.workspaces.find((item) => item.id === routeWorkspaceId) ?? null,
    [project, routeWorkspaceId],
  );
  const canonicalProjectRef = project ? projectRouteRef(project) : routeProjectRef;
  const initialState = useMemo(() => (workspace ? formStateFromWorkspace(workspace) : null), [workspace]);
  const isDirty = Boolean(form && initialState && JSON.stringify(form) !== JSON.stringify(initialState));

  useEffect(() => {
    if (!project?.companyId || project.companyId === selectedCompanyId) return;
    setSelectedCompanyId(project.companyId, { source: "route_sync" });
  }, [project?.companyId, selectedCompanyId, setSelectedCompanyId]);

  useEffect(() => {
    if (!workspace) return;
    setForm(formStateFromWorkspace(workspace));
    setErrorMessage(null);
  }, [workspace]);

  useEffect(() => {
    if (!project) return;
    setBreadcrumbs([
      { label: t("projects.breadcrumb"), href: "/projects" },
      { label: project.name, href: `/projects/${canonicalProjectRef}` },
      { label: t("nav.workspaces"), href: `/projects/${canonicalProjectRef}/workspaces` },
      { label: workspace?.name ?? routeWorkspaceId },
    ]);
  }, [setBreadcrumbs, project, canonicalProjectRef, workspace?.name, routeWorkspaceId, t]);

  useEffect(() => {
    if (!project) return;
    if (routeProjectRef === canonicalProjectRef) return;
    navigate(projectWorkspaceUrl(project, routeWorkspaceId), { replace: true });
  }, [project, routeProjectRef, canonicalProjectRef, routeWorkspaceId, navigate]);

  const invalidateProject = () => {
    if (!project) return;
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.id) });
    queryClient.invalidateQueries({ queryKey: queryKeys.projects.detail(project.urlKey) });
    if (lookupCompanyId) {
      queryClient.invalidateQueries({ queryKey: queryKeys.projects.list(lookupCompanyId) });
    }
  };

  const updateWorkspace = useMutation({
    mutationFn: (patch: Record<string, unknown>) =>
      projectsApi.updateWorkspace(project!.id, routeWorkspaceId, patch, lookupCompanyId),
    onSuccess: () => {
      invalidateProject();
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : t("workspace.detail.save_failed"));
    },
  });

  const setPrimaryWorkspace = useMutation({
    mutationFn: () => projectsApi.updateWorkspace(project!.id, routeWorkspaceId, { isPrimary: true }, lookupCompanyId),
    onSuccess: () => {
      invalidateProject();
      setErrorMessage(null);
    },
    onError: (error) => {
      setErrorMessage(error instanceof Error ? error.message : t("workspace.detail.update_failed"));
    },
  });

  const controlRuntimeServices = useMutation({
    mutationFn: (request: WorkspaceRuntimeControlRequest) =>
      projectsApi.controlWorkspaceCommands(project!.id, routeWorkspaceId, request.action, lookupCompanyId, request),
    onSuccess: (result, request) => {
      invalidateProject();
      setErrorMessage(null);
      setRuntimeActionMessage(
        request.action === "run"
          ? t("workspace.detail.job_completed")
          : request.action === "stop"
            ? t("workspace.detail.service_stopped")
            : request.action === "restart"
              ? t("workspace.detail.service_restarted")
              : t("workspace.detail.service_started"),
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setErrorMessage(error instanceof Error ? error.message : t("workspace.detail.control_failed"));
    },
  });

  if (projectQuery.isLoading) return <p className="text-sm text-muted-foreground">{t("workspace.loading")}</p>;
  if (projectQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {projectQuery.error instanceof Error ? projectQuery.error.message : t("workspace.failed_load")}
      </p>
    );
  }
  if (!project || !workspace || !form || !initialState) {
    return <p className="text-sm text-muted-foreground">{t("workspace.not_found")}</p>;
  }

  const canRunWorkspaceCommands = Boolean(workspace.cwd);
  const canStartRuntimeServices = Boolean(workspace.runtimeConfig?.workspaceRuntime) && canRunWorkspaceCommands;
  const runtimeControlSections = buildWorkspaceRuntimeControlSections({
    runtimeConfig: workspace.runtimeConfig?.workspaceRuntime ?? null,
    runtimeServices: workspace.runtimeServices ?? [],
    canStartServices: canStartRuntimeServices,
    canRunJobs: canRunWorkspaceCommands,
  });
  const pendingRuntimeAction = controlRuntimeServices.isPending ? controlRuntimeServices.variables ?? null : null;

  const validationErrors = {
    remoteRequiresRef: t("workspace.detail.error_remote_requires_ref"),
    requiresPathOrRepo: t("workspace.detail.error_requires_path_or_repo"),
    pathMustBeAbsolute: t("workspace.detail.error_path_must_be_absolute"),
    repoUrlInvalid: t("errors.repo_url_invalid"),
    jsonObject: t("errors.json_must_be_object"),
    invalidJson: t("errors.invalid_json"),
  };

  const saveChanges = () => {
    const validationError = validateWorkspaceForm(form, validationErrors);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }
    const patch = buildWorkspacePatch(initialState, form, {
      jsonObject: validationErrors.jsonObject,
      invalidJson: validationErrors.invalidJson,
    });
    if (Object.keys(patch).length === 0) return;
    updateWorkspace.mutate(patch);
  };

  const sourceTypeDescription = t(`workspace.detail.source_type.${form.sourceType}.description`);

  return (
    <div className="mx-auto max-w-5xl space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="ghost" size="sm" asChild>
          <Link to={`/projects/${canonicalProjectRef}/workspaces`}>
            <ArrowLeft className="mr-1 h-4 w-4" />
            {t("workspace.back_to_workspaces")}
          </Link>
        </Button>
        <div className="inline-flex items-center rounded-full border border-border bg-background px-2.5 py-1 text-xs text-muted-foreground">
          {workspace.isPrimary ? t("workspace.primary_workspace") : t("workspace.secondary_workspace")}
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.9fr)]">
        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                  {t("workspace.project_workspace")}
                </div>
                <h1 className="text-2xl font-semibold">{workspace.name}</h1>
                <p className="max-w-2xl text-sm text-muted-foreground">
                  {t("workspace.detail.intro")}
                </p>
              </div>
              {!workspace.isPrimary ? (
                <Button
                  variant="outline"
                  className="w-full sm:w-auto"
                  disabled={setPrimaryWorkspace.isPending}
                  onClick={() => setPrimaryWorkspace.mutate()}
                >
                  {setPrimaryWorkspace.isPending
                    ? <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    : <Check className="mr-2 h-4 w-4" />}
                  {t("workspace.make_primary")}
                </Button>
              ) : (
                <div className="inline-flex items-center gap-2 rounded-xl border border-emerald-500/25 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-300 sm:max-w-sm">
                  <Sparkles className="h-4 w-4" />
                  {t("workspace.detail.primary_badge")}
                </div>
              )}
            </div>

            <Separator className="my-5" />

            <div className="grid gap-4 md:grid-cols-2">
              <Field label={t("workspace.detail.field.workspace_name")}>
                <input
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={form.name}
                  onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                  placeholder={t("workspace.detail.field.workspace_name")}
                />
              </Field>

              <Field label={t("workspace.detail.field.visibility")}>
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={form.visibility}
                  onChange={(event) =>
                    setForm((current) => current ? { ...current, visibility: event.target.value as ProjectWorkspaceVisibility } : current)
                  }
                >
                  {VISIBILITY_VALUES.map((value) => (
                    <option key={value} value={value}>{t(`workspace.detail.visibility.${value}`)}</option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="mt-4 grid gap-4">
              <Field label={t("workspace.detail.field.source_type")} hint={sourceTypeDescription ?? undefined}>
                <select
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                  value={form.sourceType}
                  onChange={(event) =>
                    setForm((current) => current ? { ...current, sourceType: event.target.value as ProjectWorkspaceSourceType } : current)
                  }
                >
                  {SOURCE_TYPE_VALUES.map((value) => (
                    <option key={value} value={value}>{t(`workspace.detail.source_type.${value}.label`)}</option>
                  ))}
                </select>
              </Field>

              <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_auto]">
                <Field label={t("workspace.detail.field.local_path")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cwd}
                    onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                    placeholder="/absolute/path/to/workspace"
                  />
                </Field>
                <div className="flex items-end">
                  <ChoosePathButton />
                </div>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("workspace.detail.field.repo_url")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.repoUrl}
                    onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                    placeholder="https://github.com/org/repo"
                  />
                </Field>
                <Field label={t("workspace.detail.field.repo_ref")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.repoRef}
                    onChange={(event) => setForm((current) => current ? { ...current, repoRef: event.target.value } : current)}
                    placeholder="origin/main"
                  />
                </Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("workspace.detail.field.default_ref")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.defaultRef}
                    onChange={(event) => setForm((current) => current ? { ...current, defaultRef: event.target.value } : current)}
                    placeholder="origin/main"
                  />
                </Field>
                <Field label={t("workspace.detail.field.shared_workspace_key")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.sharedWorkspaceKey}
                    onChange={(event) => setForm((current) => current ? { ...current, sharedWorkspaceKey: event.target.value } : current)}
                    placeholder="frontend"
                  />
                </Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("workspace.detail.field.remote_provider")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.remoteProvider}
                    onChange={(event) => setForm((current) => current ? { ...current, remoteProvider: event.target.value } : current)}
                    placeholder="codespaces"
                  />
                </Field>
                <Field label={t("workspace.detail.field.remote_workspace_ref")}>
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.remoteWorkspaceRef}
                    onChange={(event) => setForm((current) => current ? { ...current, remoteWorkspaceRef: event.target.value } : current)}
                    placeholder="workspace-123"
                  />
                </Field>
              </div>

              <div className="grid gap-4 md:grid-cols-2">
                <Field label={t("workspace.detail.field.setup_command")} hint={t("workspace.detail.hint.setup_command")}>
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.setupCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, setupCommand: event.target.value } : current)}
                    placeholder="pnpm install && pnpm dev"
                  />
                </Field>
                <Field label={t("workspace.detail.field.cleanup_command")} hint={t("workspace.detail.hint.cleanup_command")}>
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cleanupCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, cleanupCommand: event.target.value } : current)}
                    placeholder="pkill -f vite || true"
                  />
                </Field>
              </div>

              <details className="rounded-xl border border-dashed border-border/70 bg-background px-3 py-3">
                <summary className="cursor-pointer text-sm font-medium">{t("workspace.detail.advanced_json_summary")}</summary>
                <p className="mt-2 text-sm text-muted-foreground">
                  {t("workspace.detail.advanced_json_desc")}
                </p>
                <div className="mt-3">
                  <Field label={t("workspace.detail.field.commands_json")} hint={t("workspace.detail.hint.commands_json")}>
                    <textarea
                      className="min-h-96 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                      value={form.runtimeConfig}
                      onChange={(event) => setForm((current) => current ? { ...current, runtimeConfig: event.target.value } : current)}
                      placeholder={"{\n  \"commands\": [\n    {\n      \"id\": \"web\",\n      \"name\": \"web\",\n      \"kind\": \"service\",\n      \"command\": \"pnpm dev\",\n      \"cwd\": \".\",\n      \"port\": { \"type\": \"auto\" },\n      \"readiness\": {\n        \"type\": \"http\",\n        \"urlTemplate\": \"http://127.0.0.1:${port}\"\n      },\n      \"expose\": {\n        \"type\": \"url\",\n        \"urlTemplate\": \"http://127.0.0.1:${port}\"\n      },\n      \"lifecycle\": \"shared\",\n      \"reuseScope\": \"project_workspace\"\n    },\n    {\n      \"id\": \"db-migrate\",\n      \"name\": \"db:migrate\",\n      \"kind\": \"job\",\n      \"command\": \"pnpm db:migrate\",\n      \"cwd\": \".\"\n    }\n  ]\n}"}
                    />
                  </Field>
                </div>
              </details>
            </div>

            <div className="mt-5 flex flex-col items-stretch gap-3 sm:flex-row sm:flex-wrap sm:items-center">
              <Button className="w-full sm:w-auto" disabled={!isDirty || updateWorkspace.isPending} onClick={saveChanges}>
                {updateWorkspace.isPending ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {t("workspace.save_changes")}
              </Button>
              <Button
                variant="outline"
                className="w-full sm:w-auto"
                disabled={!isDirty || updateWorkspace.isPending}
                onClick={() => {
                  setForm(initialState);
                  setErrorMessage(null);
                }}
              >
                {t("workspace.reset")}
              </Button>
              {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
              {!errorMessage && runtimeActionMessage ? <p className="text-sm text-muted-foreground">{runtimeActionMessage}</p> : null}
              {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">{t("workspace.no_unsaved_changes")}</p> : null}
            </div>
          </div>
        </div>

        <div className="space-y-6">
          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("workspace.detail.facts_kicker")}</div>
              <h2 className="text-lg font-semibold">{t("workspace.detail.facts_title")}</h2>
            </div>
            <Separator className="my-4" />
            <DetailRow label={t("workspace.detail.row.project")}>
              <Link to={`/projects/${canonicalProjectRef}`} className="hover:underline">{project.name}</Link>
            </DetailRow>
            <DetailRow label={t("workspace.detail.row.workspace_id")}>
              <span className="break-all font-mono text-xs">{workspace.id}</span>
            </DetailRow>
            <DetailRow label={t("workspace.detail.row.local_path")}>
              <span className="break-all font-mono text-xs">{workspace.cwd ?? t("workspace.detail.value_none")}</span>
            </DetailRow>
            <DetailRow label={t("workspace.detail.row.repo")}>
              {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                  {workspace.repoUrl}
                  <ExternalLink className="h-3 w-3" />
                </a>
              ) : workspace.repoUrl ? (
                <span className="break-all font-mono text-xs">{workspace.repoUrl}</span>
              ) : t("workspace.detail.value_none")}
            </DetailRow>
            <DetailRow label={t("workspace.detail.row.default_ref")}>{workspace.defaultRef ?? t("workspace.detail.value_none")}</DetailRow>
            <DetailRow label={t("workspace.detail.row.updated")}>{new Date(workspace.updatedAt).toLocaleString()}</DetailRow>
          </div>

          <div className="rounded-2xl border border-border bg-card p-5">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">{t("workspace.detail.commands_kicker")}</div>
                <h2 className="text-lg font-semibold">{t("workspace.services_and_jobs_title")}</h2>
                <p className="text-sm text-muted-foreground">
                  {t("workspace.detail.commands_desc")}
                </p>
              </div>
            </div>
            <WorkspaceRuntimeControls
              className="mt-4"
              sections={runtimeControlSections}
              isPending={controlRuntimeServices.isPending}
              pendingRequest={pendingRuntimeAction}
              serviceEmptyMessage={
                workspace.runtimeConfig?.workspaceRuntime
                  ? t("workspace.detail.no_services_started")
                  : t("workspace.detail.no_command_config")
              }
              jobEmptyMessage={t("workspace.detail.no_jobs")}
              disabledHint={t("workspace.detail.disabled_hint")}
              onAction={(request) => controlRuntimeServices.mutate(request)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
