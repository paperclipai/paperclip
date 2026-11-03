export interface ScheduledInvocation {
  id: string; companyId: string; routineId: string; triggerId: string | null; source: string;
  status: string; linkedIssueId: string | null; routineRevisionId?: string | null; triggeredAt: string;
}
export interface ScheduledTask {
  id: string; companyId: string; projectId: string; assigneeAgentId: string;
  originKind: string; originId: string; originRunId: string; status: string;
}
export interface ScheduledExpectation {
  companyId: string; routineId: string; triggerId: string; projectId: string; agentId: string; enabledAt: number;
}

/** Manual Run now and an unrelated successful task are not scheduler evidence. */
export function scheduledInvocationMatches(rows: ScheduledInvocation[], task: ScheduledTask, expected: ScheduledExpectation) {
  if (!Array.isArray(rows) || rows.length !== 1) return false;
  const run = rows[0]!;
  return typeof run.id === "string" && run.id.length > 0 && run.companyId === expected.companyId
    && run.routineId === expected.routineId && run.triggerId === expected.triggerId && run.source === "schedule"
    && typeof run.routineRevisionId === "string" && run.routineRevisionId.length > 0
    && Number.isFinite(Date.parse(run.triggeredAt)) && Date.parse(run.triggeredAt) >= expected.enabledAt
    && run.linkedIssueId === task.id && task.companyId === expected.companyId && task.projectId === expected.projectId
    && task.assigneeAgentId === expected.agentId && task.originKind === "routine_execution"
    && task.originId === expected.routineId && task.originRunId === run.id;
}

/** Monotonic elapsed time covers a full server minute regardless of clock offset. */
export const schedulePauseObservationMs = 65_000;
export function schedulePauseMatches(input: {
  enabled: unknown; pausedAt: number; completedAt: number; observedUntil: number;
  first: ScheduledInvocation[]; final: ScheduledInvocation[];
}) {
  const elapsed = input.observedUntil - Math.max(input.pausedAt, input.completedAt);
  return input.enabled === false && Number.isFinite(input.pausedAt) && Number.isFinite(input.completedAt)
    && Number.isFinite(input.observedUntil) && elapsed >= schedulePauseObservationMs && input.first.length === 1 && input.final.length === 1
    && input.first[0]!.id === input.final[0]!.id && input.final[0]!.status === "completed";
}
