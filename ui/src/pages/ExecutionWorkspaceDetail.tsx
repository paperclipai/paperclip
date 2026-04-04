import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "@/lib/router";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ExecutionWorkspace, Project, ProjectWorkspace } from "@paperclipai/shared";
import { ArrowLeft, Check, Copy, ExternalLink, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { CopyText } from "../components/CopyText";
import { ExecutionWorkspaceCloseDialog } from "../components/ExecutionWorkspaceCloseDialog";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { useCompany } from "../context/CompanyContext";
import { queryKeys } from "../lib/queryKeys";
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

function MonoValue({ value, copy }: { value: string; copy?: boolean }) {
  return (
    <div className="inline-flex max-w-full items-start gap-2">
      <span className="break-all font-mono text-xs">{value}</span>
      {copy ? (
        <CopyText text={value} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel="Copied">
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
      { label: "Projects", href: "/projects" },
      ...(project ? [{ label: project.name, href: `/projects/${projectRef}` }] : []),
      ...(project ? [{ label: "Workspaces", href: `/projects/${projectRef}/workspaces` }] : []),
      { label: workspace.name },
    ];
    setBreadcrumbs(crumbs);
  }, [setBreadcrumbs, workspace, project, projectRef]);

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
      setErrorMessage(error instanceof Error ? error.message : "Failed to save execution workspace.");
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
          ? "Runtime services stopped."
          : action === "restart"
            ? "Runtime services restarted."
            : "Runtime services started.",
      );
    },
    onError: (error) => {
      setRuntimeActionMessage(null);
      setErrorMessage(error instanceof Error ? error.message : "Failed to control runtime services.");
    },
  });

  if (workspaceQuery.isLoading) return <p className="text-sm text-muted-foreground">Loading workspace…</p>;
  if (workspaceQuery.error) {
    return (
      <p className="text-sm text-destructive">
        {workspaceQuery.error instanceof Error ? workspaceQuery.error.message : "Failed to load workspace"}
      </p>
    );
  }
  if (!workspace || !form || !initialState) return null;

  const saveChanges = () => {
    const validationError = validateForm(form);
    if (validationError) {
      setErrorMessage(validationError);
      return;
    }

    let patch: Record<string, unknown>;
    try {
      patch = buildWorkspacePatch(initialState, form);
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : "Failed to build workspace update.");
      return;
    }

    if (Object.keys(patch).length === 0) return;
    updateWorkspace.mutate(patch);
  };

  return (
    <>
      <div className="mx-auto max-w-5xl space-y-6">
        <div className="flex flex-wrap items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link to={project ? `/projects/${projectRef}/workspaces` : "/projects"}>
              <ArrowLeft className="mr-1 h-4 w-4" />
              Back to all workspaces
            </Link>
          </Button>
          <StatusPill>{workspace.mode}</StatusPill>
          <StatusPill>{workspace.providerType}</StatusPill>
          <StatusPill className={workspace.status === "active" ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" : undefined}>
            {workspace.status}
          </StatusPill>
        </div>

        <div className="grid gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(18rem,0.95fr)]">
          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-col gap-4 sm:flex-row sm:flex-wrap sm:items-start sm:justify-between">
                <div className="space-y-2">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">
                    Execution workspace
                  </div>
                  <h1 className="text-2xl font-semibold">{workspace.name}</h1>
                  <p className="max-w-2xl text-sm text-muted-foreground">
                    Configure the concrete runtime workspace that Paperclip reuses for this issue flow. These settings stay
                    attached to the execution workspace so future runs can keep local paths, repo refs, provisioning, teardown,
                    and runtime-service behavior in sync with the actual workspace being reused.
                  </p>
                </div>
                <div className="flex w-full shrink-0 items-center gap-2 sm:w-auto">
                  <Button
                    variant="outline"
                    className="w-full sm:w-auto"
                    onClick={() => setCloseDialogOpen(true)}
                    disabled={workspace.status === "archived"}
                  >
                    {workspace.status === "cleanup_failed" ? "Retry close" : "Close workspace"}
                  </Button>
                </div>
              </div>

              <Separator className="my-5" />

              <div className="grid gap-4 md:grid-cols-2">
                <Field label="Workspace name">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.name}
                    onChange={(event) => setForm((current) => current ? { ...current, name: event.target.value } : current)}
                    placeholder="Execution workspace name"
                  />
                </Field>
                <Field label="Branch name" hint="Useful for isolated worktrees">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.branchName}
                    onChange={(event) => setForm((current) => current ? { ...current, branchName: event.target.value } : current)}
                    placeholder="PAP-946-workspace"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="Working directory">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.cwd}
                    onChange={(event) => setForm((current) => current ? { ...current, cwd: event.target.value } : current)}
                    placeholder="/absolute/path/to/workspace"
                  />
                </Field>
                <Field label="Provider path / ref">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.providerRef}
                    onChange={(event) => setForm((current) => current ? { ...current, providerRef: event.target.value } : current)}
                    placeholder="/path/to/worktree or provider ref"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="Repo URL">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm outline-none"
                    value={form.repoUrl}
                    onChange={(event) => setForm((current) => current ? { ...current, repoUrl: event.target.value } : current)}
                    placeholder="https://github.com/org/repo"
                  />
                </Field>
                <Field label="Base ref">
                  <input
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.baseRef}
                    onChange={(event) => setForm((current) => current ? { ...current, baseRef: event.target.value } : current)}
                    placeholder="origin/main"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <Field label="Provision command" hint="Runs when Paperclip prepares this execution workspace">
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.provisionCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, provisionCommand: event.target.value } : current)}
                    placeholder="bash ./scripts/provision-worktree.sh"
                  />
                </Field>
                <Field label="Teardown command" hint="Runs when the execution workspace is archived or cleaned up">
                  <textarea
                    className="min-h-28 w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm outline-none"
                    value={form.teardownCommand}
                    onChange={(event) => setForm((current) => current ? { ...current, teardownCommand: event.target.value } : current)}
                    placeholder="bash ./scripts/teardown-worktree.sh"
                  />
                </Field>
              </div>

              <div className="mt-4 grid gap-4">
                <Field label="Cleanup command" hint="Workspace-specific cleanup before teardown">
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
                        Runtime config source
                      </div>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {runtimeConfigSource === "execution_workspace"
                          ? "This execution workspace currently overrides the project workspace runtime config."
                          : runtimeConfigSource === "project_workspace"
                            ? "This execution workspace is inheriting the project workspace runtime config."
                            : "No runtime config is currently defined on this execution workspace or its project workspace."}
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
                      Reset to inherit
                    </Button>
                  </div>
                </div>

                <Field label="Runtime services JSON" hint="Concrete workspace runtime settings for this execution workspace. Leave this inheriting unless you need a one-off override. If you are missing the right commands, ask your CEO to set them up for you.">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <input
                      id="inherit-runtime-config"
                      type="checkbox"
                      checked={form.inheritRuntime}
                      onChange={(event) =>
                        setForm((current) => current ? { ...current, inheritRuntime: event.target.checked } : current)
                      }
                    />
                    <label htmlFor="inherit-runtime-config">Inherit project workspace runtime config</label>
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
                  Save changes
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
                  Reset
                </Button>
                {errorMessage ? <p className="text-sm text-destructive">{errorMessage}</p> : null}
                {!errorMessage && runtimeActionMessage ? <p className="text-sm text-muted-foreground">{runtimeActionMessage}</p> : null}
                {!errorMessage && !isDirty ? <p className="text-sm text-muted-foreground">No unsaved changes.</p> : null}
              </div>
            </div>
          </div>

          <div className="space-y-6">
            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Linked objects</div>
                <h2 className="text-lg font-semibold">Workspace context</h2>
              </div>
              <Separator className="my-4" />
              <DetailRow label="Project">
                {project ? <Link to={`/projects/${projectRef}`} className="hover:underline">{project.name}</Link> : <MonoValue value={workspace.projectId} />}
              </DetailRow>
              <DetailRow label="Project workspace">
                {project && linkedProjectWorkspace ? (
                  <WorkspaceLink project={project} workspace={linkedProjectWorkspace} />
                ) : workspace.projectWorkspaceId ? (
                  <MonoValue value={workspace.projectWorkspaceId} />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Source issue">
                {sourceIssue ? (
                  <Link to={issueUrl(sourceIssue)} className="hover:underline">
                    {sourceIssue.identifier ?? sourceIssue.id} · {sourceIssue.title}
                  </Link>
                ) : workspace.sourceIssueId ? (
                  <MonoValue value={workspace.sourceIssueId} />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Derived from">
                {derivedWorkspace ? (
                  <Link to={`/execution-workspaces/${derivedWorkspace.id}`} className="hover:underline">
                    {derivedWorkspace.name}
                  </Link>
                ) : workspace.derivedFromExecutionWorkspaceId ? (
                  <MonoValue value={workspace.derivedFromExecutionWorkspaceId} />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Workspace ID">
                <MonoValue value={workspace.id} />
              </DetailRow>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Paths and refs</div>
                <h2 className="text-lg font-semibold">Concrete location</h2>
              </div>
              <Separator className="my-4" />
              <DetailRow label="Working dir">
                {workspace.cwd ? <MonoValue value={workspace.cwd} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Provider ref">
                {workspace.providerRef ? <MonoValue value={workspace.providerRef} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Repo URL">
                {workspace.repoUrl && isSafeExternalUrl(workspace.repoUrl) ? (
                  <div className="inline-flex max-w-full items-start gap-2">
                    <a href={workspace.repoUrl} target="_blank" rel="noreferrer" className="inline-flex min-w-0 items-center gap-1 break-all hover:underline">
                      {workspace.repoUrl}
                      <ExternalLink className="h-3.5 w-3.5 shrink-0" />
                    </a>
                    <CopyText text={workspace.repoUrl} className="shrink-0 text-muted-foreground hover:text-foreground" copiedLabel="Copied">
                      <Copy className="h-3.5 w-3.5" />
                    </CopyText>
                  </div>
                ) : workspace.repoUrl ? (
                  <MonoValue value={workspace.repoUrl} copy />
                ) : (
                  "None"
                )}
              </DetailRow>
              <DetailRow label="Base ref">
                {workspace.baseRef ? <MonoValue value={workspace.baseRef} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Branch">
                {workspace.branchName ? <MonoValue value={workspace.branchName} copy /> : "None"}
              </DetailRow>
              <DetailRow label="Opened">{formatDateTime(workspace.openedAt)}</DetailRow>
              <DetailRow label="Last used">{formatDateTime(workspace.lastUsedAt)}</DetailRow>
              <DetailRow label="Cleanup">
                {workspace.cleanupEligibleAt
                  ? `${formatDateTime(workspace.cleanupEligibleAt)}${workspace.cleanupReason ? ` · ${workspace.cleanupReason}` : ""}`
                  : "Not scheduled"}
              </DetailRow>
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                <div className="space-y-1">
                  <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Runtime services</div>
                  <h2 className="text-lg font-semibold">Attached services</h2>
                  <p className="text-sm text-muted-foreground">
                    Source: {runtimeConfigSource === "execution_workspace"
                      ? "execution workspace override"
                      : runtimeConfigSource === "project_workspace"
                        ? "project workspace default"
                        : "none"}
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
                    Start
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={controlRuntimeServices.isPending || !effectiveRuntimeConfig || !workspace.cwd}
                    onClick={() => controlRuntimeServices.mutate("restart")}
                  >
                    Restart
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    className="w-full sm:w-auto"
                    disabled={controlRuntimeServices.isPending || (workspace.runtimeServices?.length ?? 0) === 0}
                    onClick={() => controlRuntimeServices.mutate("stop")}
                  >
                    Stop
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
                          <div className="text-xs text-muted-foreground">{service.status} · {service.lifecycle}</div>
                          <div className="space-y-1 text-xs text-muted-foreground">
                            {service.url ? (
                              <a href={service.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 hover:underline">
                                {service.url}
                                <ExternalLink className="h-3.5 w-3.5" />
                              </a>
                            ) : null}
                            {service.port ? <div>Port {service.port}</div> : null}
                            {service.command ? <MonoValue value={service.command} copy /> : null}
                            {service.cwd ? <MonoValue value={service.cwd} copy /> : null}
                          </div>
                        </div>
                        <StatusPill className="self-start">{service.healthStatus}</StatusPill>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  {effectiveRuntimeConfig
                    ? "No runtime services are currently running for this execution workspace."
                    : "No runtime config is defined for this execution workspace yet."}
                </p>
              )}
            </div>

            <div className="rounded-2xl border border-border bg-card p-5">
              <div className="space-y-1">
                <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Recent operations</div>
                <h2 className="text-lg font-semibold">Runtime and cleanup logs</h2>
              </div>
              <Separator className="my-4" />
              {workspaceOperationsQuery.isLoading ? (
                <p className="text-sm text-muted-foreground">Loading workspace operations…</p>
              ) : workspaceOperationsQuery.error ? (
                <p className="text-sm text-destructive">
                  {workspaceOperationsQuery.error instanceof Error
                    ? workspaceOperationsQuery.error.message
                    : "Failed to load workspace operations."}
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
                        <StatusPill className="self-start">{operation.status}</StatusPill>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">No workspace operations have been recorded yet.</p>
              )}
            </div>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-5">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
            <div className="space-y-1">
              <div className="text-xs font-medium uppercase tracking-[0.16em] text-muted-foreground">Linked issues</div>
              <h2 className="text-lg font-semibold">Issues using this workspace</h2>
              <p className="text-sm text-muted-foreground">
                Any issue attached to this execution workspace appears here so you can review the full session context before reusing or closing it.
              </p>
            </div>
            <StatusPill>{linkedIssues.length} linked</StatusPill>
          </div>
          <Separator className="my-4" />
          {linkedIssuesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading linked issues…</p>
          ) : linkedIssuesQuery.error ? (
            <p className="text-sm text-destructive">
              {linkedIssuesQuery.error instanceof Error
                ? linkedIssuesQuery.error.message
                : "Failed to load linked issues."}
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
                    <StatusPill className="shrink-0">{issue.status}</StatusPill>
                  </div>
                  <div className="mt-3 flex items-center justify-between gap-3 text-xs text-muted-foreground">
                    <span className="uppercase tracking-[0.16em]">{issue.priority}</span>
                    <span>{formatDateTime(issue.updatedAt)}</span>
                  </div>
                </Link>
              ))}
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No issues are currently linked to this execution workspace.</p>
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
