import type { createDeliveryWorkCoordinator } from "./delivery-work-coordinator.js";
import { DELIVERY_QUEUES } from "./delivery-work-notifications.js";
import { registerScopedDeadlineWork } from "./scoped-deadline-work.js";
import type { routineExecutionStatusService } from "./routine-run-status.js";

export function registerRoutineExecutionStatusWork(
  coordinator: ReturnType<typeof createDeliveryWorkCoordinator>,
  service: ReturnType<typeof routineExecutionStatusService>,
  canRun: () => boolean,
) {
  return registerScopedDeadlineWork(coordinator, {
    queue: DELIVERY_QUEUES.routineExecutionStatus,
    decodeScope: hint => hint === "*" ? undefined : hint,
    matches: (entry, issueId?: string) => issueId === undefined || entry.issueId === issueId,
    load: async (issueId?: string) => (await service.load(issueId)).map(row => ({ ...row, dueAt: Date.now() })),
    check: async entry => { await service.settle(entry); return null; },
  }, canRun);
}
