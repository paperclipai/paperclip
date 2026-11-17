import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { RoutineExecutionStatusScope } from "./routine-execution-status-notifications.js";
import { ROUTINE_EXECUTION_STATUS_PAGE_SIZE, type routineExecutionStatusService } from "./routine-run-status.js";

export function registerRoutineExecutionStatusWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof routineExecutionStatusService>,
  canRun: () => boolean,
) {
  const cursors = new Map<string, string>();
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.routineExecutionStatus,
    decodeScope: hint => hint === "*" ? undefined : JSON.parse(hint) as RoutineExecutionStatusScope,
    matches: (entry, scope?: RoutineExecutionStatusScope) => (!scope?.issueId || entry.issueId === scope.issueId)
      && (!scope?.companyId || entry.companyId === scope.companyId),
    load: async (scope?: RoutineExecutionStatusScope) => {
      const key = JSON.stringify(scope) ?? "*";
      const rows = await service.load(scope, cursors.get(key));
      const complete = rows.length < ROUTINE_EXECUTION_STATUS_PAGE_SIZE;
      if (complete) cursors.delete(key); else cursors.set(key, rows.at(-1)!.id);
      return { rows: rows.map(row => ({ ...row, dueAt: Date.now() })), complete };
    },
    check: async entry => { await service.settle(entry); return null; },
  }, canRun);
}
