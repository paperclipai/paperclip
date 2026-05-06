import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type {
  Issue,
  Project,
  ProjectWorkProduct,
  WorkspaceBrowserKind,
  WorkspaceFileBrowserEntry,
} from "@paperclipai/shared";
import { Link } from "@/lib/router";
import {
  Activity,
  AlertTriangle,
  Bot,
  CheckCircle2,
  ExternalLink,
  File,
  FileCode2,
  Folder,
  FolderOpen,
  GitBranch,
  Github,
  HardDrive,
  Image as ImageIcon,
  RefreshCw,
  Rocket,
  Server,
  UploadCloud,
} from "lucide-react";
import { executionWorkspacesApi } from "../api/execution-workspaces";
import { heartbeatsApi, type LiveRunForIssue } from "../api/heartbeats";
import { issuesApi } from "../api/issues";
import { projectsApi } from "../api/projects";
import { ProjectWorkspacesContent } from "../components/ProjectWorkspacesContent";
import { StatusBadge } from "../components/StatusBadge";
import { queryKeys } from "../lib/queryKeys";
import { buildProjectWorkspaceSummaries } from "../lib/project-workspaces-tab";
import {
  agentUrl,
  cn,
  formatDateTime,
  formatNumber,
  issueUrl,
  projectWorkspaceUrl,
  relativeTime,
} from "../lib/utils";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

const TERMINAL_ISSUE_STATUSES = new Set(["done", "cancelled"]);
const DEPLOYMENT_WORK_PRODUCT_TYPES = new Set(["preview_url", "runtime_service"]);

interface ProjectSystemViewProps {
  project: Project;
  companyId: string;
  projectRef: string;
}

interface SystemWorkspaceTarget {
  key: string;
  kind: WorkspaceBrowserKind;
  workspaceId: string;
  workspaceName: string;
  cwd: string | null;
  href: string;
  description: string;
}

function titleize(value: string) {
  return value.replace(/_/g, " ");
}

function isTextContentType(contentType: string | null | undefined) {
  return Boolean(contentType && (contentType.startsWith("text/") || contentType.startsWith("application/")));
}

function isImageContentType(contentType: string | null | undefined) {
  return Boolean(contentType?.startsWith("image/"));
}

function formatBytes(bytes: number | null | undefined) {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

function SummaryStat({
  icon: Icon,
  label,
  value,
  description,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  description: string;
}) {
  return (
    <Card className="gap-4 py-5">
      <CardContent className="flex items-start justify-between gap-4 px-5">
        <div className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-[0.18em] text-muted-foreground">{label}</div>
          <div className="text-2xl font-semibold tracking-tight">{value}</div>
          <p className="text-sm text-muted-foreground">{description}</p>
        </div>
        <div className="rounded-full border border-border/70 bg-muted/40 p-2 text-muted-foreground">
          <Icon className="size-4" />
        </div>
      </CardContent>
    </Card>
  );
}

function EmptyState({ title, description }: { title: string; description: string }) {
  return (
    <div className="rounded-lg border border-dashed border-border/80 bg-muted/20 px-4 py-8 text-center">
      <div className="text-sm font-medium">{title}</div>
      <p className="mt-2 text-sm text-muted-foreground">{description}</p>
    </div>
  );
}

function IntegrationChip({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-2.5 py-1 text-xs font-medium",
        ok
          ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300"
          : "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300",
      )}
    >
      {ok ? <CheckCircle2 className="size-3.5" /> : <AlertTriangle className="size-3.5" />}
      {children}
    </span>
  );
}

function WorkProductCard({ product }: { product: ProjectWorkProduct }) {
  const issueLabel = product.issueIdentifier ? `${product.issueIdentifier} · ${product.issueTitle}` : product.issueTitle;

  return (
    <div className="rounded-lg border border-border/80 bg-background px-4 py-4 shadow-xs">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium leading-6">{product.title}</div>
            <StatusBadge status={product.status} />
            {product.healthStatus ? <StatusBadge status={product.healthStatus} /> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <span>{titleize(product.type)}</span>
            <span>{product.provider}</span>
            <Link className="hover:text-foreground hover:underline" to={issueUrl({ id: product.issueId, identifier: product.issueIdentifier })}>
              {issueLabel}
            </Link>
            <span>Updated {relativeTime(product.updatedAt)}</span>
          </div>
          {product.summary ? <p className="text-sm text-muted-foreground">{product.summary}</p> : null}
          {product.url ? (
            <div className="truncate text-xs text-muted-foreground">
              <span className="font-medium text-foreground/80">URL:</span> {product.url}
            </div>
          ) : null}
        </div>
        {product.url ? (
          <Button asChild size="sm" variant="outline">
            <a href={product.url} rel="noreferrer" target="_blank">
              Open
              <ExternalLink className="size-4" />
            </a>
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function LiveRunCard({ run, issue }: { run: LiveRunForIssue; issue: Issue }) {
  return (
    <div className="rounded-lg border border-border/80 bg-background px-4 py-4 shadow-xs">
      <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <div className="space-y-2 min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <Link className="text-sm font-medium hover:underline" to={issueUrl(issue)}>
              {issue.identifier ? `${issue.identifier} · ${issue.title}` : issue.title}
            </Link>
            <StatusBadge status={run.status} />
            {run.livenessState ? <StatusBadge status={run.livenessState} /> : null}
          </div>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
            <Link className="hover:text-foreground hover:underline" to={agentUrl({ id: run.agentId, name: run.agentName })}>
              {run.agentName}
            </Link>
            <span>{run.adapterType}</span>
            <span>{run.startedAt ? `Started ${relativeTime(run.startedAt)}` : `Created ${relativeTime(run.createdAt)}`}</span>
            {run.nextAction ? <span>Next: {run.nextAction}</span> : null}
          </div>
          {run.livenessReason ? <p className="text-sm text-muted-foreground">{run.livenessReason}</p> : null}
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>{formatDateTime(run.startedAt ?? run.createdAt)}</div>
          {typeof run.lastOutputBytes === "number" ? <div>{formatBytes(run.lastOutputBytes)} recent output</div> : null}
        </div>
      </div>
    </div>
  );
}

export function ProjectSystemView({ project, companyId, projectRef }: ProjectSystemViewProps) {
  const queryClient = useQueryClient();
  const [selectedWorkspaceKey, setSelectedWorkspaceKey] = useState<string>("");
  const [currentPath, setCurrentPath] = useState("");
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);
  const integrationStatusQueryKey = useMemo(
    () => ["projects", project.id, "integration-status", companyId] as const,
    [companyId, project.id],
  );

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (window.location.hash !== "#project-files-manager") return;
    const filesManager = document.getElementById("project-files-manager");
    if (!filesManager) return;
    requestAnimationFrame(() => {
      filesManager.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, []);

  const issuesQuery = useQuery({
    queryKey: queryKeys.issues.listByProject(companyId, project.id),
    queryFn: () => issuesApi.list(companyId, { projectId: project.id }),
    enabled: !!companyId,
  });

  const liveRunsQuery = useQuery({
    queryKey: queryKeys.liveRuns(companyId),
    queryFn: () => heartbeatsApi.liveRunsForCompany(companyId, { limit: 250 }),
    enabled: !!companyId,
    refetchInterval: 5000,
  });

  const executionWorkspacesQuery = useQuery({
    queryKey: queryKeys.executionWorkspaces.list(companyId, { projectId: project.id }),
    queryFn: () => executionWorkspacesApi.list(companyId, { projectId: project.id }),
    enabled: !!companyId,
  });

  const workProductsQuery = useQuery({
    queryKey: queryKeys.projects.workProducts(project.id),
    queryFn: () => projectsApi.listWorkProducts(project.id, companyId),
    enabled: !!companyId,
  });

  const integrationStatusQuery = useQuery({
    queryKey: integrationStatusQueryKey,
    queryFn: () => projectsApi.getIntegrationStatus(project.id, companyId),
    enabled: !!companyId,
    refetchInterval: 15000,
  });

  const githubActionMutation = useMutation({
    mutationFn: (action: "pull" | "push" | "sync-progress") => projectsApi.runGithubAction(project.id, action, companyId),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: integrationStatusQueryKey });
    },
  });

  const vercelDeployMutation = useMutation({
    mutationFn: (production: boolean) => projectsApi.deployToVercel(project.id, { production }, companyId),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: integrationStatusQueryKey }),
        queryClient.invalidateQueries({ queryKey: queryKeys.projects.workProducts(project.id) }),
      ]);
    },
  });

  const issues = issuesQuery.data ?? [];
  const executionWorkspaces = executionWorkspacesQuery.data ?? [];
  const workProducts = workProductsQuery.data ?? [];

  const workspaceSummaries = useMemo(
    () =>
      buildProjectWorkspaceSummaries({
        project,
        issues,
        executionWorkspaces,
      }),
    [executionWorkspaces, issues, project],
  );

  const issuesById = useMemo(() => new Map(issues.map((issue) => [issue.id, issue] as const)), [issues]);

  const liveRuns = useMemo(() => {
    return (liveRunsQuery.data ?? [])
      .filter((run) => run.issueId && issuesById.has(run.issueId))
      .sort((left, right) => {
        const leftTime = new Date(left.startedAt ?? left.createdAt).getTime();
        const rightTime = new Date(right.startedAt ?? right.createdAt).getTime();
        return rightTime - leftTime;
      });
  }, [issuesById, liveRunsQuery.data]);

  const workspaceTargets = useMemo<SystemWorkspaceTarget[]>(() => {
    const codebaseTarget: SystemWorkspaceTarget = {
      key: `codebase:${project.id}`,
      kind: "project_codebase",
      workspaceId: project.id,
      workspaceName: "Project codebase",
      cwd: project.codebase.effectiveLocalFolder,
      href: `/projects/${projectRef}#project-files-manager`,
      description: project.codebase.origin === "local_folder" ? "Project codebase · local folder" : "Project codebase · managed checkout",
    };
    const projectTargets = project.workspaces.map((workspace) => ({
      key: `project:${workspace.id}`,
      kind: "project_workspace" as const,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.cwd ?? (project.codebase.workspaceId === workspace.id ? project.codebase.effectiveLocalFolder : null),
      href: projectWorkspaceUrl(project, workspace.id),
      description: workspace.cwd
        ? (workspace.isPrimary ? "Project workspace · primary checkout" : "Project workspace")
        : "Project workspace · managed checkout",
    }));
    const executionTargets = executionWorkspaces.map((workspace) => ({
      key: `execution:${workspace.id}`,
      kind: "execution_workspace" as const,
      workspaceId: workspace.id,
      workspaceName: workspace.name,
      cwd: workspace.cwd,
      href: `/execution-workspaces/${workspace.id}`,
      description: `Execution workspace · ${titleize(workspace.status)}`,
    }));
    return [codebaseTarget, ...projectTargets, ...executionTargets].filter((workspace) => Boolean(workspace.cwd));
  }, [executionWorkspaces, project, projectRef]);

  const selectedWorkspace = useMemo(
    () => workspaceTargets.find((workspace) => workspace.key === selectedWorkspaceKey) ?? workspaceTargets[0] ?? null,
    [selectedWorkspaceKey, workspaceTargets],
  );

  useEffect(() => {
    if (!selectedWorkspace && workspaceTargets.length === 0) return;
    if (selectedWorkspaceKey && workspaceTargets.some((workspace) => workspace.key === selectedWorkspaceKey)) return;
    setSelectedWorkspaceKey(workspaceTargets[0]?.key ?? "");
  }, [selectedWorkspace, selectedWorkspaceKey, workspaceTargets]);

  useEffect(() => {
    setCurrentPath("");
    setSelectedFilePath(null);
  }, [selectedWorkspaceKey]);

  const fileListingQuery = useQuery({
    queryKey: selectedWorkspace
      ? selectedWorkspace.kind === "project_codebase"
        ? ["projects", project.id, "codebase-files", currentPath]
        : selectedWorkspace.kind === "project_workspace"
        ? queryKeys.projects.workspaceFiles(project.id, selectedWorkspace.workspaceId, currentPath)
        : queryKeys.executionWorkspaces.files(selectedWorkspace.workspaceId, currentPath)
      : ["project-system", project.id, "files", "disabled"],
    queryFn: () => {
      if (!selectedWorkspace) {
        throw new Error("No workspace selected");
      }
      if (selectedWorkspace.kind === "project_codebase") {
        return projectsApi.listCodebaseFiles(project.id, currentPath, companyId);
      }
      if (selectedWorkspace.kind === "project_workspace") {
        return projectsApi.listWorkspaceFiles(project.id, selectedWorkspace.workspaceId, currentPath, companyId);
      }
      return executionWorkspacesApi.listFiles(selectedWorkspace.workspaceId, currentPath);
    },
    enabled: Boolean(selectedWorkspace),
  });

  const selectedFileEntry = useMemo<WorkspaceFileBrowserEntry | null>(() => {
    if (!selectedFilePath || !fileListingQuery.data) return null;
    return fileListingQuery.data.entries.find((entry) => entry.path === selectedFilePath) ?? null;
  }, [fileListingQuery.data, selectedFilePath]);

  const selectedFileRawUrl = useMemo(() => {
    if (!selectedWorkspace || !selectedFilePath) return null;
    if (selectedWorkspace.kind === "project_codebase") {
      return projectsApi.codebaseFileRawPath(project.id, selectedFilePath, companyId);
    }
    if (selectedWorkspace.kind === "project_workspace") {
      return projectsApi.workspaceFileRawPath(project.id, selectedWorkspace.workspaceId, selectedFilePath, companyId);
    }
    return executionWorkspacesApi.fileRawPath(selectedWorkspace.workspaceId, selectedFilePath);
  }, [companyId, project.id, selectedFilePath, selectedWorkspace]);

  const selectedFileNeedsTextPreview = Boolean(
    selectedWorkspace
    && selectedFileEntry
    && selectedFileEntry.kind === "file"
    && selectedFilePath
    && isTextContentType(selectedFileEntry.contentType),
  );

  const fileContentQuery = useQuery({
    queryKey: selectedWorkspace && selectedFilePath
      ? selectedWorkspace.kind === "project_codebase"
        ? ["projects", project.id, "codebase-file-content", selectedFilePath]
        : selectedWorkspace.kind === "project_workspace"
        ? queryKeys.projects.workspaceFileContent(project.id, selectedWorkspace.workspaceId, selectedFilePath)
        : queryKeys.executionWorkspaces.fileContent(selectedWorkspace.workspaceId, selectedFilePath)
      : ["project-system", project.id, "file-content", "disabled"],
    queryFn: () => {
      if (!selectedWorkspace || !selectedFilePath) {
        throw new Error("No file selected");
      }
      if (selectedWorkspace.kind === "project_codebase") {
        return projectsApi.getCodebaseFileContent(project.id, selectedFilePath, companyId);
      }
      if (selectedWorkspace.kind === "project_workspace") {
        return projectsApi.getWorkspaceFileContent(project.id, selectedWorkspace.workspaceId, selectedFilePath, companyId);
      }
      return executionWorkspacesApi.getFileContent(selectedWorkspace.workspaceId, selectedFilePath);
    },
    enabled: selectedFileNeedsTextPreview,
  });

  useEffect(() => {
    if (!selectedFilePath || !fileListingQuery.data) return;
    const entryExists = fileListingQuery.data.entries.some((entry) => entry.path === selectedFilePath);
    if (!entryExists) setSelectedFilePath(null);
  }, [fileListingQuery.data, selectedFilePath]);

  const browseableWorkspaceCount = workspaceTargets.length;
  const openIssueCount = issues.filter((issue) => !TERMINAL_ISSUE_STATUSES.has(issue.status)).length;
  const blockedIssueCount = issues.filter((issue) => issue.status === "blocked").length;
  const runningServiceCount = workspaceSummaries.reduce((total, workspace) => total + workspace.runningServiceCount, 0);
  const serviceCount = workspaceSummaries.reduce((total, workspace) => total + workspace.serviceCount, 0);
  const deploymentCount = workProducts.filter((product) => DEPLOYMENT_WORK_PRODUCT_TYPES.has(product.type)).length;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-5">
        <SummaryStat
          icon={Activity}
          label="Open issues"
          value={formatNumber(openIssueCount)}
          description={blockedIssueCount > 0 ? `${formatNumber(blockedIssueCount)} blocked right now.` : "No blockers on the radar."}
        />
        <SummaryStat
          icon={Bot}
          label="Live runs"
          value={formatNumber(liveRuns.length)}
          description={liveRuns.length > 0 ? "Agents currently working in this project." : "No active agent runs at the moment."}
        />
        <SummaryStat
          icon={Server}
          label="Runtime services"
          value={`${formatNumber(runningServiceCount)}/${formatNumber(serviceCount)}`}
          description={serviceCount > 0 ? "Running vs total tracked services." : "No runtime services configured yet."}
        />
        <SummaryStat
          icon={Rocket}
          label="Deployments"
          value={formatNumber(deploymentCount)}
          description={deploymentCount > 0 ? "Preview URLs and runtime services attached to work." : "No previews or runtime artifacts attached yet."}
        />
        <SummaryStat
          icon={HardDrive}
          label="Browseable workspaces"
          value={formatNumber(browseableWorkspaceCount)}
          description={browseableWorkspaceCount > 0 ? "Workspaces with local paths available for file browsing." : "No local workspaces are browseable yet."}
        />
      </div>

      <Card>
        <CardHeader>
          <CardTitle>Live agent work</CardTitle>
          <CardDescription>
            Current work happening in this project, filtered from the company-wide live run stream.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {issuesQuery.isLoading || liveRunsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading live project activity...</p>
          ) : liveRuns.length === 0 ? (
            <EmptyState
              title="No active runs"
              description="When agents start working on this project's issues, their live runs will appear here."
            />
          ) : (
            liveRuns.map((run) => {
              const issue = run.issueId ? issuesById.get(run.issueId) : null;
              return issue ? <LiveRunCard key={run.id} run={run} issue={issue} /> : null;
            })
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Workspaces & runtime</CardTitle>
          <CardDescription>
            Project workspaces, execution workspaces, and their currently tracked runtime services.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {executionWorkspacesQuery.isLoading && issuesQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading workspaces...</p>
          ) : (
            <ProjectWorkspacesContent
              companyId={companyId}
              projectId={project.id}
              projectRef={projectRef}
              summaries={workspaceSummaries}
            />
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>GitHub sync & Vercel deployment</CardTitle>
          <CardDescription>
            See whether this project has a GitHub-backed checkout, whether local progress is synced, and whether a Vercel deployment exists.
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 xl:grid-cols-2">
          {integrationStatusQuery.isLoading ? (
            <p className="text-sm text-muted-foreground xl:col-span-2">Loading integration status...</p>
          ) : integrationStatusQuery.error ? (
            <p className="text-sm text-destructive xl:col-span-2">{(integrationStatusQuery.error as Error).message}</p>
          ) : integrationStatusQuery.data ? (
            <>
              <div className="rounded-lg border border-border/80 bg-background p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Github className="size-4 text-muted-foreground" />
                      <div className="text-sm font-medium">GitHub repository</div>
                      <IntegrationChip ok={integrationStatusQuery.data.github.synced}>
                        {integrationStatusQuery.data.github.synced ? "Synced" : "Needs sync"}
                      </IntegrationChip>
                    </div>
                    <p className="text-sm text-muted-foreground">{integrationStatusQuery.data.github.message}</p>
                    <p className="text-xs text-muted-foreground">
                      Paperclip now writes `.paperclip/project-progress.md` and keeps it committed/pushed automatically when project issues or outputs change.
                    </p>
                    <div className="space-y-1 text-xs text-muted-foreground">
                      <div className="truncate">
                        <span className="font-medium text-foreground/80">Repo:</span>{" "}
                        {integrationStatusQuery.data.github.repoUrl ?? "Not connected"}
                      </div>
                      <div className="truncate">
                        <span className="font-medium text-foreground/80">Path:</span> {integrationStatusQuery.data.github.rootPath}
                      </div>
                      <div className="flex flex-wrap gap-x-3 gap-y-1">
                        <span className="inline-flex items-center gap-1">
                          <GitBranch className="size-3.5" />
                          {integrationStatusQuery.data.github.branch ?? "No branch"}
                        </span>
                        {integrationStatusQuery.data.github.commitSha ? (
                          <span>{integrationStatusQuery.data.github.commitSha.slice(0, 8)}</span>
                        ) : null}
                        {integrationStatusQuery.data.github.dirty !== null ? (
                          <span>{integrationStatusQuery.data.github.dirty ? "Uncommitted changes" : "Clean tree"}</span>
                        ) : null}
                        {integrationStatusQuery.data.github.ahead !== null || integrationStatusQuery.data.github.behind !== null ? (
                          <span>
                            ↑{integrationStatusQuery.data.github.ahead ?? 0} ↓{integrationStatusQuery.data.github.behind ?? 0}
                          </span>
                        ) : null}
                      </div>
                    </div>
                    {githubActionMutation.error ? (
                      <p className="text-xs text-destructive">{(githubActionMutation.error as Error).message}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {integrationStatusQuery.data.github.repoUrl ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={integrationStatusQuery.data.github.repoUrl} rel="noreferrer" target="_blank">
                          Open repo
                          <ExternalLink className="size-4" />
                        </a>
                      </Button>
                    ) : null}
                    <Button
                      disabled={!integrationStatusQuery.data.github.isGitCheckout || githubActionMutation.isPending}
                      onClick={() => githubActionMutation.mutate("pull")}
                      size="sm"
                      variant="outline"
                    >
                      <RefreshCw className="size-4" />
                      Pull latest
                    </Button>
                    <Button
                      disabled={!integrationStatusQuery.data.github.isGitCheckout || githubActionMutation.isPending}
                      onClick={() => githubActionMutation.mutate("push")}
                      size="sm"
                      variant="outline"
                    >
                      <UploadCloud className="size-4" />
                      Push branch
                    </Button>
                    <Button
                      disabled={!integrationStatusQuery.data.github.isGitCheckout || githubActionMutation.isPending}
                      onClick={() => githubActionMutation.mutate("sync-progress")}
                      size="sm"
                    >
                      <UploadCloud className="size-4" />
                      Sync progress
                    </Button>
                  </div>
                </div>
              </div>

              <div className="rounded-lg border border-border/80 bg-background p-4">
                <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
                  <div className="space-y-2 min-w-0">
                    <div className="flex flex-wrap items-center gap-2">
                      <Rocket className="size-4 text-muted-foreground" />
                      <div className="text-sm font-medium">Vercel deployment</div>
                      <IntegrationChip ok={integrationStatusQuery.data.vercel.deployed}>
                        {integrationStatusQuery.data.vercel.deployed ? "Deployed" : "Not deployed"}
                      </IntegrationChip>
                    </div>
                    <p className="text-sm text-muted-foreground">{integrationStatusQuery.data.vercel.message}</p>
                    {integrationStatusQuery.data.vercel.latestDeployment?.url ? (
                      <div className="truncate text-xs text-muted-foreground">
                        <span className="font-medium text-foreground/80">Latest:</span>{" "}
                        {integrationStatusQuery.data.vercel.latestDeployment.url}
                      </div>
                    ) : null}
                    <div className="text-xs text-muted-foreground">
                      {integrationStatusQuery.data.vercel.hasToken
                        ? "Vercel token configured for deploy actions."
                        : "Add VERCEL_TOKEN to enable deploy actions."}
                    </div>
                    {vercelDeployMutation.error ? (
                      <p className="text-xs text-destructive">{(vercelDeployMutation.error as Error).message}</p>
                    ) : null}
                    {vercelDeployMutation.data?.deploymentUrl ? (
                      <p className="text-xs text-muted-foreground">Deployment started: {vercelDeployMutation.data.deploymentUrl}</p>
                    ) : null}
                  </div>
                  <div className="flex shrink-0 flex-wrap gap-2">
                    {integrationStatusQuery.data.vercel.latestDeployment?.url ? (
                      <Button asChild size="sm" variant="outline">
                        <a href={integrationStatusQuery.data.vercel.latestDeployment.url} rel="noreferrer" target="_blank">
                          Open deployment
                          <ExternalLink className="size-4" />
                        </a>
                      </Button>
                    ) : null}
                    <Button
                      disabled={!integrationStatusQuery.data.vercel.hasToken || vercelDeployMutation.isPending}
                      onClick={() => vercelDeployMutation.mutate(false)}
                      size="sm"
                      variant="outline"
                    >
                      Deploy preview
                    </Button>
                    <Button
                      disabled={!integrationStatusQuery.data.vercel.hasToken || vercelDeployMutation.isPending}
                      onClick={() => vercelDeployMutation.mutate(true)}
                      size="sm"
                    >
                      Deploy production
                    </Button>
                  </div>
                </div>
              </div>
            </>
          ) : null}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Deployments & outputs</CardTitle>
          <CardDescription>
            Work products attached to issues in this project: previews, runtime URLs, pull requests, artifacts, and documents.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {workProductsQuery.isLoading ? (
            <p className="text-sm text-muted-foreground">Loading project work products...</p>
          ) : workProducts.length === 0 ? (
            <EmptyState
              title="No work products yet"
              description="As issues attach previews, pull requests, artifacts, or documents, they’ll show up here automatically."
            />
          ) : (
            workProducts.map((product) => <WorkProductCard key={product.id} product={product} />)
          )}
        </CardContent>
      </Card>

      <Card id="project-files-manager">
        <CardHeader>
          <CardTitle>Files manager</CardTitle>
          <CardDescription>
            Browse local project and execution workspaces, preview text files, and open raw assets directly.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {workspaceTargets.length === 0 ? (
            <EmptyState
              title="No browseable workspaces"
              description="Only workspaces with a local filesystem path can be browsed from Paperclip."
            />
          ) : (
            <>
              <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">Workspace</span>
                  <select
                    className="h-10 rounded-md border border-border bg-background px-3 text-sm"
                    value={selectedWorkspace?.key ?? ""}
                    onChange={(event) => setSelectedWorkspaceKey(event.target.value)}
                  >
                    {workspaceTargets.map((workspace) => (
                      <option key={workspace.key} value={workspace.key}>
                        {workspace.workspaceName} — {workspace.description}
                      </option>
                    ))}
                  </select>
                </label>
                {selectedWorkspace ? (
                  <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                    <span>{selectedWorkspace.description}</span>
                    <span>•</span>
                    <span className="truncate max-w-[28rem]">{selectedWorkspace.cwd}</span>
                    <Button asChild size="xs" variant="outline">
                      <Link to={selectedWorkspace.href}>Open workspace</Link>
                    </Button>
                  </div>
                ) : null}
              </div>

              <div className="grid gap-4 xl:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]">
                <div className="rounded-lg border border-border/80 bg-background">
                  <div className="border-b border-border/80 px-4 py-3">
                    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
                      <button
                        className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
                        onClick={() => {
                          setCurrentPath("");
                          setSelectedFilePath(null);
                        }}
                        type="button"
                      >
                        root
                      </button>
                      {fileListingQuery.data?.currentPath
                        ? fileListingQuery.data.currentPath.split("/").filter(Boolean).map((segment, index, parts) => {
                            const segmentPath = parts.slice(0, index + 1).join("/");
                            return (
                              <span className="flex items-center gap-2" key={segmentPath}>
                                <span>/</span>
                                <button
                                  className="rounded px-1.5 py-0.5 hover:bg-accent hover:text-accent-foreground"
                                  onClick={() => {
                                    setCurrentPath(segmentPath);
                                    setSelectedFilePath(null);
                                  }}
                                  type="button"
                                >
                                  {segment}
                                </button>
                              </span>
                            );
                          })
                        : <span>/</span>}
                    </div>
                  </div>
                  <div className="max-h-[34rem] overflow-y-auto p-2">
                    {fileListingQuery.isLoading ? (
                      <p className="px-3 py-6 text-sm text-muted-foreground">Loading files...</p>
                    ) : fileListingQuery.error ? (
                      <p className="px-3 py-6 text-sm text-destructive">{(fileListingQuery.error as Error).message}</p>
                    ) : (
                      <div className="space-y-1">
                        {fileListingQuery.data?.parentPath !== null ? (
                          <button
                            className="flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                            onClick={() => {
                              setCurrentPath(fileListingQuery.data?.parentPath ?? "");
                              setSelectedFilePath(null);
                            }}
                            type="button"
                          >
                            <span className="flex items-center gap-2">
                              <FolderOpen className="size-4 text-muted-foreground" />
                              ..
                            </span>
                            <span className="text-xs text-muted-foreground">Up one level</span>
                          </button>
                        ) : null}
                        {fileListingQuery.data?.entries.length ? (
                          fileListingQuery.data.entries.map((entry) => {
                            const isSelected = selectedFilePath === entry.path;
                            const isDirectory = entry.kind === "dir";
                            return (
                              <button
                                key={entry.path}
                                className={cn(
                                  "flex w-full items-center justify-between rounded-md px-3 py-2 text-left text-sm transition-colors",
                                  isSelected
                                    ? "bg-accent text-accent-foreground"
                                    : "hover:bg-accent/70 hover:text-accent-foreground",
                                )}
                                onClick={() => {
                                  if (isDirectory) {
                                    setCurrentPath(entry.path);
                                    setSelectedFilePath(null);
                                    return;
                                  }
                                  setSelectedFilePath(entry.path);
                                }}
                                type="button"
                              >
                                <span className="flex min-w-0 items-center gap-2">
                                  {isDirectory ? (
                                    <Folder className="size-4 shrink-0 text-muted-foreground" />
                                  ) : isImageContentType(entry.contentType) ? (
                                    <ImageIcon className="size-4 shrink-0 text-muted-foreground" />
                                  ) : isTextContentType(entry.contentType) ? (
                                    <FileCode2 className="size-4 shrink-0 text-muted-foreground" />
                                  ) : (
                                    <File className="size-4 shrink-0 text-muted-foreground" />
                                  )}
                                  <span className="truncate">{entry.name}</span>
                                </span>
                                <span className="shrink-0 text-xs text-muted-foreground">
                                  {isDirectory ? "folder" : formatBytes(entry.byteSize)}
                                </span>
                              </button>
                            );
                          })
                        ) : (
                          <p className="px-3 py-6 text-sm text-muted-foreground">This folder is empty.</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/80 bg-background">
                  <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border/80 px-4 py-3">
                    <div>
                      <div className="text-sm font-medium">Preview</div>
                      <p className="text-xs text-muted-foreground">
                        {selectedFileEntry ? selectedFileEntry.path : "Select a file to preview or open."}
                      </p>
                    </div>
                    {selectedFileRawUrl ? (
                      <Button asChild size="xs" variant="outline">
                        <a href={selectedFileRawUrl} rel="noreferrer" target="_blank">
                          Open raw
                          <ExternalLink className="size-4" />
                        </a>
                      </Button>
                    ) : null}
                  </div>
                  <div className="max-h-[34rem] overflow-auto p-4">
                    {!selectedFileEntry ? (
                      <EmptyState
                        title="No file selected"
                        description="Pick a file from the left pane to preview it here."
                      />
                    ) : isImageContentType(selectedFileEntry.contentType) && selectedFileRawUrl ? (
                      <div className="space-y-3">
                        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                          <span>{selectedFileEntry.contentType}</span>
                          <span>{formatBytes(selectedFileEntry.byteSize)}</span>
                        </div>
                        <div className="overflow-hidden rounded-lg border border-border/80 bg-muted/20 p-3">
                          <img alt={selectedFileEntry.name} className="max-h-[28rem] w-full rounded object-contain" src={selectedFileRawUrl} />
                        </div>
                      </div>
                    ) : selectedFileNeedsTextPreview ? (
                      fileContentQuery.isLoading ? (
                        <p className="text-sm text-muted-foreground">Loading file preview...</p>
                      ) : fileContentQuery.error ? (
                        <p className="text-sm text-destructive">{(fileContentQuery.error as Error).message}</p>
                      ) : fileContentQuery.data ? (
                        <div className="space-y-3">
                          <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
                            <span>{fileContentQuery.data.contentType ?? "text"}</span>
                            <span>{formatBytes(fileContentQuery.data.byteSize)}</span>
                            {fileContentQuery.data.truncated ? <span>Preview truncated at 128 KB</span> : null}
                          </div>
                          <pre className="overflow-auto rounded-lg border border-border/80 bg-muted/20 p-4 text-xs leading-5 whitespace-pre-wrap break-words">
                            {fileContentQuery.data.content}
                          </pre>
                        </div>
                      ) : null
                    ) : (
                      <EmptyState
                        title="Preview unavailable"
                        description="This file is not text-previewable in the inline viewer, but you can still open the raw file directly."
                      />
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
