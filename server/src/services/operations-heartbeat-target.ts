export type IssueTruthType = "completion" | "blocker" | "handoff" | null;

function normalizePriorityRank(priority: string | null | undefined) {
  switch ((priority ?? "").toLowerCase()) {
    case "urgent":
      return 4;
    case "high":
      return 3;
    case "medium":
      return 2;
    case "low":
      return 1;
    default:
      return 0;
  }
}

export function isSuccessfulHeartbeatRunStatus(status: string | null | undefined) {
  return status === "succeeded" || status === "completed";
}

export function hasFalseCompleteRecoverySignal(input: {
  runStatus: string | null | undefined;
  truthType: IssueTruthType;
}) {
  return (
    isSuccessfulHeartbeatRunStatus(input.runStatus)
    && input.truthType !== "completion"
    && input.truthType !== "blocker"
    && input.truthType !== "handoff"
  );
}

export function selectReadyUnassignedCandidate<T extends { priority: string | null | undefined; updatedAt: Date }>(
  rows: T[],
) {
  return [...rows].sort((a, b) => {
    const priorityDelta = normalizePriorityRank(b.priority) - normalizePriorityRank(a.priority);
    if (priorityDelta !== 0) return priorityDelta;
    return b.updatedAt.getTime() - a.updatedAt.getTime();
  })[0] ?? null;
}
