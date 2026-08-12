export function buildNewProjectRequests(input: {
  name: string;
  description: string;
  status: string;
  goalIds: string[];
  targetDate: string;
  repositoryIds: string[];
  workspaceLocalPath: string;
}) {
  const localPath = input.workspaceLocalPath.trim();
  const normalizedPath = localPath.replace(/[\\/]+$/, "");
  const segments = normalizedPath.split(/[\\/]/).filter(Boolean);
  return {
    project: {
      name: input.name.trim(),
      description: input.description.trim() || undefined,
      status: input.status,
      ...(input.goalIds.length > 0 ? { goalIds: input.goalIds } : {}),
      repositoryIds: input.repositoryIds,
      ...(input.targetDate ? { targetDate: input.targetDate } : {}),
    },
    workspace: localPath
      ? { name: segments[segments.length - 1] ?? "Local folder", cwd: localPath }
      : null,
  };
}
