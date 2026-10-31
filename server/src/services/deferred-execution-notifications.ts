import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type DeferredExecutionScope = { companyId: string; requestId?: string };
export type DeferredReceiptRecoveryOptions = {
  companyId?: string;
  requestId?: string;
  onError?: (error: unknown) => void;
};

function hint(scope: DeferredExecutionScope) {
  return JSON.stringify({ companyId: scope.companyId, requestId: scope.requestId });
}

export async function notifyDeferredExecutionWork(tx: object, scope: DeferredExecutionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.deferredExecutionReceipts, hint(scope));
}

export async function notifyNativeStatusWakeWork(tx: object, scope: DeferredExecutionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusWakeIntents, hint(scope));
}

export async function notifyTaskRetrySettlement(tx: object, scope: DeferredExecutionScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.taskRetryReceiptSettlement, hint(scope));
}

export async function notifyDeferredExecutionEligibility(tx: object, scope?: { companyId: string }) {
  if (scope) {
    await notifyDeferredExecutionWork(tx, scope);
    await notifyNativeStatusWakeWork(tx, scope);
  } else {
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.deferredExecutionReceipts, "*");
    await notifyDeliveryWork(tx, DELIVERY_QUEUES.nativeStatusWakeIntents, "*");
  }
}
