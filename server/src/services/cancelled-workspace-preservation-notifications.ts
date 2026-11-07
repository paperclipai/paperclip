import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type CancelledWorkspacePreservationScope = { companyId: string; runId?: string };

export async function notifyCancelledWorkspacePreservation(transaction: object, scope?: CancelledWorkspacePreservationScope) {
  await notifyDeliveryWork(transaction, DELIVERY_QUEUES.cancelledWorkspacePreservation, scope ? JSON.stringify(scope) : "*");
}
