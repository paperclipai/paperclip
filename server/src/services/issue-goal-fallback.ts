type MaybeId = string | null | undefined;

export function resolveIssueGoalId(input: {
  projectId: MaybeId;
  goalId: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  if (!input.projectId && !input.goalId) {
    return input.defaultGoalId ?? null;
  }
  return input.goalId ?? null;
}

export function resolveNextIssueGoalId(input: {
  currentProjectId: MaybeId;
  currentGoalId: MaybeId;
  projectId?: MaybeId;
  goalId?: MaybeId;
  defaultGoalId: MaybeId;
}): string | null {
  const projectId =
    input.projectId !== undefined ? input.projectId : input.currentProjectId;
  const goalId =
    input.goalId !== undefined ? input.goalId : input.currentGoalId;

  if (!projectId && !goalId) {
    return input.defaultGoalId ?? null;
  }
  return goalId ?? null;
}
