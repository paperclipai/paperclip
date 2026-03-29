import type { ProjectWorkspace } from "@paperclipai/shared";

type WorkspaceSummary = Pick<ProjectWorkspace, "cwd" | "id" | "isPrimary" | "name" | "repoUrl">;

type ProjectWorkspaceProject =
  | {
      executionWorkspacePolicy?: { defaultProjectWorkspaceId?: string | null } | null;
      primaryWorkspace?: WorkspaceSummary | null;
      workspaces: WorkspaceSummary[];
    }
  | null
  | undefined;

export function defaultProjectWorkspaceIdForProject(project: ProjectWorkspaceProject): string | null {
  if (!project) return null;
  return (
    project.executionWorkspacePolicy?.defaultProjectWorkspaceId
    ?? project.workspaces.find((workspace) => workspace.isPrimary)?.id
    ?? project.primaryWorkspace?.id
    ?? project.workspaces[0]?.id
    ?? null
  );
}

export function selectedProjectWorkspaceForProject(
  project:
    | {
        primaryWorkspace?: WorkspaceSummary | null;
        workspaces: WorkspaceSummary[];
      }
    | null
    | undefined,
  projectWorkspaceId: string | null | undefined,
): WorkspaceSummary | null {
  if (!project) return null;
  if (projectWorkspaceId) {
    const selected = project.workspaces.find((workspace) => workspace.id === projectWorkspaceId);
    if (selected) return selected;
  }
  return project.primaryWorkspace ?? project.workspaces[0] ?? null;
}

export function projectWorkspaceLocation(
  workspace: Pick<WorkspaceSummary, "cwd" | "repoUrl"> | null | undefined,
): string | null {
  if (!workspace) return null;
  return workspace.repoUrl ?? workspace.cwd ?? null;
}

export function projectWorkspaceLocationLabel(
  workspace: Pick<WorkspaceSummary, "cwd" | "repoUrl"> | null | undefined,
): string | null {
  if (!workspace) return null;
  if (workspace.repoUrl) return "Repo";
  if (workspace.cwd) return "Path";
  return null;
}

export function projectWorkspaceOptionLabel(
  workspace: WorkspaceSummary,
): string {
  const location = projectWorkspaceLocation(workspace) ?? workspace.id.slice(0, 8);
  return [workspace.name, workspace.isPrimary ? "primary" : null, location].filter(Boolean).join(" · ");
}
