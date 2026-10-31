import { notifyRoutineExecutionStatus } from "./routine-execution-status-notifications.js";
import { notifyAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork, type DeliveryQueue } from "./delivery-work-notifications.js";

export type ExecutionWorkScope = { companyId: string; agentId?: string; runId?: string; issueId?: string };

export async function notifyExecutionRunWork(transaction: object, scope?: ExecutionWorkScope) {
  if (scope) await notifyRoutineExecutionStatus(transaction, scope.issueId, scope.companyId);
  if (scope) {
    await notifyAttentionRetentionWork(transaction, scope);
    await notifyStatusCardIssueChange(transaction, scope.companyId);
    await notifyRunDispatch(transaction, scope);
    await notifyDeferredExecutionEligibility(transaction, scope);
  }
  for (const queue of [DELIVERY_QUEUES.executionStatus, DELIVERY_QUEUES.executionFinalization,
    DELIVERY_QUEUES.executionReplacement, DELIVERY_QUEUES.executionDisposition, DELIVERY_QUEUES.issueMonitors]) {
    await notifyDeliveryWork(transaction, queue);
  }
}

export function writeExecutionControl<T>(
  db: Db | Parameters<Parameters<Db["transaction"]>[0]>[0],
  queue: DeliveryQueue | readonly DeliveryQueue[],
  write: (tx: Db) => PromiseLike<T>,
  scope: ExecutionWorkScope | undefined,
): Promise<T> {
  return db.transaction(async transaction => {
    if (scope) await notifyRoutineExecutionStatus(transaction, scope.issueId, scope.companyId);
    if (scope) await notifyAttentionRetentionWork(transaction, scope);
    if (scope) await notifyStatusCardIssueChange(transaction, scope.companyId);
    await notifyRunDispatch(transaction, scope);
    if (scope) await notifyDeferredExecutionEligibility(transaction, scope);
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.issueMonitors);
    for (const topic of typeof queue === "string" ? [queue] : queue) await notifyDeliveryWork(transaction, topic);
    return write(transaction as unknown as Db);
  });
}
