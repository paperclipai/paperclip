import { issuePriorityWeight } from "@paperclipai/shared";

export type IssueTruthType = "completion" | "blocker" | "handoff" | null;

function normalizePriorityRank(priority: string | null | undefined) {
  return issuePriorityWeight(priority);
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
