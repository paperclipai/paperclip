import type { ExecutionWorkspace, Issue, Project } from "@paperclipai/shared";

type ProjectWorkspaceLike = Pick<Project, "workspaces" | "primaryWorkspace">;

export interface ProjectWorkspaceSummary {
  key: string;
  kind: "execution_workspace" | "project_workspace";
  workspaceId: string;
  workspaceName: string;
  cwd: string | null;
  branchName: string | null;
  lastUpdatedAt: Date;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceStatus: ExecutionWorkspace["status"] | null;
  serviceCount: number;
  runningServiceCount: number;
  primaryServiceUrl: string | null;
  primaryServiceUrlRunning: boolean;
  hasRuntimeConfig: boolean;
  issues: Issue[];
}

function toDate(value: Date | string | null | undefined): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function maxDate(...values: Array<Date | string | null | undefined>): Date {
  let latest = new Date(0);
  for (const value of values) {
    const date = toDate(value);
    if (date && date.getTime() > latest.getTime()) latest = date;
  }
  return latest;
}

function primaryWorkspaceId(project: ProjectWorkspaceLike): string | null {
  return project.primaryWorkspace?.id
    ?? project.workspaces.find((workspace) => workspace.isPrimary)?.id
    ?? project.workspaces[0]?.id
    ?? null;
}

function isDefaultSharedExecutionWorkspace(input: {
  executionWorkspace: ExecutionWorkspace;
  issue: Issue;
  primaryWorkspaceId: string | null;
}) {
  const linkedProjectWorkspaceId =
    input.executionWorkspace.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  return input.executionWorkspace.mode === "shared_workspace" && linkedProjectWorkspaceId === input.primaryWorkspaceId;
}

function runtimeServiceSummary(
  services: NonNullable<ExecutionWorkspace["runtimeServices"]> | undefined,
) {
  const serviceCount = services?.length ?? 0;
  const runningServiceCount = services?.filter((service) => service.status === "running").length ?? 0;
  const primaryService =
    services?.find((service) => service.status === "running" && service.url)
    ?? services?.find((service) => service.url)
    ?? null;

  return {
    serviceCount,
    runningServiceCount,
    primaryServiceUrl: primaryService?.url ?? null,
    primaryServiceUrlRunning: primaryService?.status === "running",
  };
}

export function buildProjectWorkspaceSummaries(input: {
  project: ProjectWorkspaceLike;
  issues: Issue[];
  executionWorkspaces: ExecutionWorkspace[];
}): ProjectWorkspaceSummary[] {
  const primaryId = primaryWorkspaceId(input.project);
  const executionWorkspacesById = new Map(
    input.executionWorkspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const projectWorkspacesById = new Map(
    input.project.workspaces.map((workspace) => [workspace.id, workspace] as const),
  );
  const summaries = new Map<string, ProjectWorkspaceSummary>();

  for (const issue of input.issues) {
    if (issue.executionWorkspaceId) {
      const executionWorkspace = executionWorkspacesById.get(issue.executionWorkspaceId);
      if (!executionWorkspace) continue;
      if (executionWorkspace.status === "archived") continue;
      if (isDefaultSharedExecutionWorkspace({
        executionWorkspace,
        issue,
        primaryWorkspaceId: primaryId,
      })) continue;

      const existing = summaries.get(`execution:${executionWorkspace.id}`);
      const nextIssues = [...(existing?.issues ?? []), issue].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      const runtimeSummary = runtimeServiceSummary(executionWorkspace.runtimeServices);

      summaries.set(`execution:${executionWorkspace.id}`, {
        key: `execution:${executionWorkspace.id}`,
        kind: "execution_workspace",
        workspaceId: executionWorkspace.id,
        workspaceName: executionWorkspace.name,
        cwd: executionWorkspace.cwd ?? null,
        branchName: executionWorkspace.branchName ?? executionWorkspace.baseRef ?? null,
        lastUpdatedAt: maxDate(
          existing?.lastUpdatedAt,
          executionWorkspace.lastUsedAt,
          executionWorkspace.updatedAt,
          issue.updatedAt,
        ),
        projectWorkspaceId: executionWorkspace.projectWorkspaceId ?? issue.projectWorkspaceId ?? null,
        executionWorkspaceId: executionWorkspace.id,
        executionWorkspaceStatus: executionWorkspace.status,
        ...runtimeSummary,
        hasRuntimeConfig: Boolean(
          executionWorkspace.config?.workspaceRuntime
          ?? projectWorkspacesById.get(executionWorkspace.projectWorkspaceId ?? issue.projectWorkspaceId ?? "")?.runtimeConfig?.workspaceRuntime,
        ),
        issues: nextIssues,
      });
      continue;
    }

    if (!issue.projectWorkspaceId || issue.projectWorkspaceId === primaryId) continue;
    const projectWorkspace = projectWorkspacesById.get(issue.projectWorkspaceId);
    if (!projectWorkspace) continue;

    const existing = summaries.get(`project:${projectWorkspace.id}`);
    const nextIssues = [...(existing?.issues ?? []), issue].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const runtimeSummary = runtimeServiceSummary(projectWorkspace.runtimeServices);

    summaries.set(`project:${projectWorkspace.id}`, {
      key: `project:${projectWorkspace.id}`,
      kind: "project_workspace",
      workspaceId: projectWorkspace.id,
      workspaceName: projectWorkspace.name,
      cwd: projectWorkspace.cwd ?? null,
      branchName: projectWorkspace.repoRef ?? projectWorkspace.defaultRef ?? null,
      lastUpdatedAt: maxDate(existing?.lastUpdatedAt, projectWorkspace.updatedAt, issue.updatedAt),
      projectWorkspaceId: projectWorkspace.id,
      executionWorkspaceId: null,
      executionWorkspaceStatus: null,
      ...runtimeSummary,
      hasRuntimeConfig: Boolean(projectWorkspace.runtimeConfig?.workspaceRuntime),
      issues: nextIssues,
    });
  }

  for (const projectWorkspace of input.project.workspaces) {
    const key = `project:${projectWorkspace.id}`;
    if (summaries.has(key)) continue;
    const shouldSurfaceWorkspace =
      projectWorkspace.isPrimary
      || Boolean(projectWorkspace.runtimeConfig?.workspaceRuntime)
      || (projectWorkspace.runtimeServices?.length ?? 0) > 0;
    if (!shouldSurfaceWorkspace) continue;
    const runtimeSummary = runtimeServiceSummary(projectWorkspace.runtimeServices);
    summaries.set(key, {
      key,
      kind: "project_workspace",
      workspaceId: projectWorkspace.id,
      workspaceName: projectWorkspace.name,
      cwd: projectWorkspace.cwd ?? null,
      branchName: projectWorkspace.repoRef ?? projectWorkspace.defaultRef ?? null,
      lastUpdatedAt: maxDate(projectWorkspace.updatedAt),
      projectWorkspaceId: projectWorkspace.id,
      executionWorkspaceId: null,
      executionWorkspaceStatus: null,
      ...runtimeSummary,
      hasRuntimeConfig: Boolean(projectWorkspace.runtimeConfig?.workspaceRuntime),
      issues: [],
    });
  }

  return [...summaries.values()].sort((a, b) => {
    const liveDiff = Number(b.runningServiceCount > 0) - Number(a.runningServiceCount > 0);
    if (liveDiff !== 0) return liveDiff;
    const diff = b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime();
    return diff !== 0 ? diff : a.workspaceName.localeCompare(b.workspaceName);
  });
}
