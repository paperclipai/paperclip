import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type RoutineExecutionStatusScope = { issueId?: string; companyId?: string };

export function notifyRoutineExecutionStatus(tx: object, issueId?: string, companyId?: string) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.routineExecutionStatus,
    issueId || companyId ? JSON.stringify({ issueId, companyId } satisfies RoutineExecutionStatusScope) : "*");
}
