/** Only host-owned successful run records can prove the old execution contract. */
function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : {};
}

export function hasMatchingLegacySessionWorkspace(input: {
  companyId: string; agentId: string; responsibleUserId: string | null;
  taskId: string; workspaceId: string; sessionDisplayId: string;
  sessionFingerprint: string; workspaceFingerprint: string; fingerprintVersion: number;
  previousRun: {
    companyId: string; agentId: string; responsibleUserId: string | null;
    status: string; sessionIdAfter: string | null; contextSnapshot: unknown; resultJson: unknown;
  } | null;
}): boolean {
  const run = input.previousRun;
  if (!run || run.status !== "succeeded" || run.companyId !== input.companyId
    || run.agentId !== input.agentId || run.responsibleUserId !== input.responsibleUserId
    || run.sessionIdAfter !== input.sessionDisplayId) return false;
  const context = object(run.contextSnapshot);
  const taskIds = [context.taskId, context.issueId, context.taskKey]
    .filter((id): id is string => typeof id === "string" && id.length > 0);
  if (taskIds.length === 0 || taskIds.some(id => id !== input.taskId)
    || context.executionWorkspaceId !== input.workspaceId) return false;
  const freshness = object(object(run.resultJson).configFreshness);
  const session = object(freshness.session), workspace = object(freshness.workspace);
  return session.fingerprintVersion === input.fingerprintVersion
    && workspace.fingerprintVersion === input.fingerprintVersion
    && session.nextFingerprint === input.sessionFingerprint
    && workspace.nextFingerprint === input.workspaceFingerprint;
}
