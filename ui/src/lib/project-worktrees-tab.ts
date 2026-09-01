import type { ExecutionWorktree, Issue, Project } from "@paperclipai/shared";

type ProjectWorktreeLike = Pick<Project, "workspaces" | "primaryWorkspace">;

export type ProjectWorktreeLinkedIssue = Pick<Issue, "id" | "identifier" | "title" | "updatedAt"> & {
  status: string;
  priority: string;
  description?: string | null;
  blockerAttention?: Issue["blockerAttention"];
  projectId?: string | null;
  project?: Issue["project"];
  originKind?: Issue["originKind"];
  originId?: string | null;
};

export interface ProjectWorktreeSummary {
  key: string;
  kind: "execution_workspace" | "project_workspace";
  workspaceId: string;
  workspaceName: string;
  cwd: string | null;
  branchName: string | null;
  lastUpdatedAt: Date;
  projectWorkspaceId: string | null;
  executionWorkspaceId: string | null;
  executionWorkspaceStatus: ExecutionWorktree["status"] | null;
  serviceCount: number;
  runningServiceCount: number;
  primaryServiceUrl: string | null;
  primaryServiceUrlRunning: boolean;
  hasRuntimeConfig: boolean;
  linkedIssueCount: number;
  issues: ProjectWorktreeLinkedIssue[];
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

function primaryWorktreeId(project: ProjectWorktreeLike): string | null {
  return project.primaryWorkspace?.id
    ?? project.workspaces.find((worktree) => worktree.isPrimary)?.id
    ?? project.workspaces[0]?.id
    ?? null;
}

function isDefaultSharedExecutionWorktree(input: {
  executionWorkspace: ExecutionWorktree;
  issue: Issue;
  primaryWorkspaceId: string | null;
}) {
  const linkedProjectWorktreeId =
    input.executionWorkspace.projectWorkspaceId ?? input.issue.projectWorkspaceId ?? null;
  return input.executionWorkspace.mode === "shared_workspace" && linkedProjectWorktreeId === input.primaryWorkspaceId;
}

function runtimeServiceSummary(
  services: NonNullable<ExecutionWorktree["runtimeServices"]> | undefined,
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

export function buildProjectWorktreeSummaries(input: {
  project: ProjectWorktreeLike;
  issues: Issue[];
  executionWorktrees: ExecutionWorktree[];
}): ProjectWorktreeSummary[] {
  const primaryId = primaryWorktreeId(input.project);
  const executionWorktreesById = new Map(
    input.executionWorktrees.map((worktree) => [worktree.id, worktree] as const),
  );
  const projectWorktreesById = new Map(
    input.project.workspaces.map((worktree) => [worktree.id, worktree] as const),
  );
  const summaries = new Map<string, ProjectWorktreeSummary>();

  for (const issue of input.issues) {
    if (issue.executionWorkspaceId) {
      const executionWorktree = executionWorktreesById.get(issue.executionWorkspaceId);
      if (!executionWorktree) continue;
      if (executionWorktree.status === "archived") continue;
      if (isDefaultSharedExecutionWorktree({
        executionWorkspace: executionWorktree,
        issue,
        primaryWorkspaceId: primaryId,
      })) continue;

      const existing = summaries.get(`execution:${executionWorktree.id}`);
      const nextIssues = [...(existing?.issues ?? []), issue].sort(
        (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
      );
      const runtimeSummary = runtimeServiceSummary(executionWorktree.runtimeServices);

      summaries.set(`execution:${executionWorktree.id}`, {
        key: `execution:${executionWorktree.id}`,
        kind: "execution_workspace",
        workspaceId: executionWorktree.id,
        workspaceName: executionWorktree.name,
        cwd: executionWorktree.cwd ?? null,
        branchName: executionWorktree.branchName ?? executionWorktree.baseRef ?? null,
        lastUpdatedAt: maxDate(
          existing?.lastUpdatedAt,
          executionWorktree.lastUsedAt,
          executionWorktree.updatedAt,
          issue.updatedAt,
        ),
        projectWorkspaceId: executionWorktree.projectWorkspaceId ?? issue.projectWorkspaceId ?? null,
        executionWorkspaceId: executionWorktree.id,
        executionWorkspaceStatus: executionWorktree.status,
        ...runtimeSummary,
        hasRuntimeConfig: Boolean(
          executionWorktree.config?.workspaceRuntime
          ?? projectWorktreesById.get(executionWorktree.projectWorkspaceId ?? issue.projectWorkspaceId ?? "")?.runtimeConfig?.workspaceRuntime,
        ),
        linkedIssueCount: nextIssues.length,
        issues: nextIssues,
      });
      continue;
    }

    if (!issue.projectWorkspaceId || issue.projectWorkspaceId === primaryId) continue;
    const projectWorktree = projectWorktreesById.get(issue.projectWorkspaceId);
    if (!projectWorktree) continue;

    const existing = summaries.get(`project:${projectWorktree.id}`);
    const nextIssues = [...(existing?.issues ?? []), issue].sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    );
    const runtimeSummary = runtimeServiceSummary(projectWorktree.runtimeServices);

    summaries.set(`project:${projectWorktree.id}`, {
      key: `project:${projectWorktree.id}`,
      kind: "project_workspace",
      workspaceId: projectWorktree.id,
      workspaceName: projectWorktree.name,
      cwd: projectWorktree.cwd ?? null,
      branchName: projectWorktree.repoRef ?? projectWorktree.defaultRef ?? null,
      lastUpdatedAt: maxDate(existing?.lastUpdatedAt, projectWorktree.updatedAt, issue.updatedAt),
      projectWorkspaceId: projectWorktree.id,
      executionWorkspaceId: null,
      executionWorkspaceStatus: null,
      ...runtimeSummary,
      hasRuntimeConfig: Boolean(projectWorktree.runtimeConfig?.workspaceRuntime),
      linkedIssueCount: nextIssues.length,
      issues: nextIssues,
    });
  }

  for (const projectWorktree of input.project.workspaces) {
    const key = `project:${projectWorktree.id}`;
    if (summaries.has(key)) continue;
    const shouldSurfaceWorktree =
      projectWorktree.isPrimary
      || Boolean(projectWorktree.runtimeConfig?.workspaceRuntime)
      || (projectWorktree.runtimeServices?.length ?? 0) > 0;
    if (!shouldSurfaceWorktree) continue;
    const runtimeSummary = runtimeServiceSummary(projectWorktree.runtimeServices);
    summaries.set(key, {
      key,
      kind: "project_workspace",
      workspaceId: projectWorktree.id,
      workspaceName: projectWorktree.name,
      cwd: projectWorktree.cwd ?? null,
      branchName: projectWorktree.repoRef ?? projectWorktree.defaultRef ?? null,
      lastUpdatedAt: maxDate(projectWorktree.updatedAt),
      projectWorkspaceId: projectWorktree.id,
      executionWorkspaceId: null,
      executionWorkspaceStatus: null,
      ...runtimeSummary,
      hasRuntimeConfig: Boolean(projectWorktree.runtimeConfig?.workspaceRuntime),
      linkedIssueCount: 0,
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
