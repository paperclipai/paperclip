import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export function notifyRoutineExecutionStatus(tx: object, issueId?: string) {
  return notifyDeliveryWork(tx, DELIVERY_QUEUES.routineExecutionStatus, issueId ?? "*");
}
