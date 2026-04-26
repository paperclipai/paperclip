type MaybeId = string | null | undefined;

/** Resolves the goal ID for an issue, preferring explicit goal > project goal > default goal. */
export function resolveIssueGoalId(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (input.goalId) return input.goalId;
  if (input.projectId) return input.projectGoalId ?? null;
  return input.defaultGoalId ?? null;
}

/** Computes the goal ID that an issue should have after a project or goal change, preserving explicit overrides. */
export function resolveNextIssueGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  currentProjectGoalId?: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  projectGoalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;
  const projectGoalId =
    input.projectGoalId !== undefined
      ? input.projectGoalId
      : projectId
        ? input.currentProjectGoalId
        : null;

  const resolveFallbackGoalId = (targetProjectId: MaybeId, targetProjectGoalId: MaybeId) => {
    if (targetProjectId) return targetProjectGoalId ?? null;
    return input.defaultGoalId ?? null;
  };

  if (input.goalId !== undefined) {
    return input.goalId ?? resolveFallbackGoalId(projectId, projectGoalId);
  }

  const currentFallbackGoalId = resolveFallbackGoalId(
    input.currentProjectId,
    input.currentProjectGoalId,
  );
  const nextFallbackGoalId = resolveFallbackGoalId(projectId, projectGoalId);

  if (!input.currentGoalId) {
    return nextFallbackGoalId;
  }

  if (input.currentGoalId === currentFallbackGoalId) {
    return nextFallbackGoalId;
  }

  return input.currentGoalId;
}
