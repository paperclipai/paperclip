import type { InstanceSchedulerHeartbeatAgent, RoutineListItem } from "@paperclipai/shared";

export const HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC = 15 * 60;

export interface HeartbeatAuditRow extends InstanceSchedulerHeartbeatAgent {
  shortInterval: boolean;
  hasActiveRoutine: boolean;
  missingRoutineCoverage: boolean;
  flagged: boolean;
}

export function buildActiveRoutineAssigneeIndex(
  routinesByCompanyId: Record<string, RoutineListItem[]>,
): Map<string, Set<string>> {
  const index = new Map<string, Set<string>>();

  for (const [companyId, routines] of Object.entries(routinesByCompanyId)) {
    const assignees = new Set<string>();
    for (const routine of routines) {
      if (routine.status !== "active") continue;
      assignees.add(routine.assigneeAgentId);
    }
    index.set(companyId, assignees);
  }

  return index;
}

export function buildHeartbeatAuditRows(
  agents: InstanceSchedulerHeartbeatAgent[],
  activeRoutineAssigneesByCompany: Map<string, Set<string>>,
  shortIntervalSec = HEARTBEAT_AUDIT_SHORT_INTERVAL_SEC,
): HeartbeatAuditRow[] {
  return agents.map((agent) => {
    const hasTimerHeartbeat = agent.heartbeatEnabled && agent.intervalSec > 0;
    const shortInterval = hasTimerHeartbeat && agent.intervalSec < shortIntervalSec;
    const hasActiveRoutine = activeRoutineAssigneesByCompany.get(agent.companyId)?.has(agent.id) ?? false;
    const missingRoutineCoverage = hasTimerHeartbeat && !hasActiveRoutine;
    return {
      ...agent,
      shortInterval,
      hasActiveRoutine,
      missingRoutineCoverage,
      flagged: shortInterval || missingRoutineCoverage,
    };
  });
}
