import { notifyLiveRunRecovery, notifyLiveResourceRecovery } from "./live-run-recovery-notifications.js";
import { notifyAttentionRetentionWork, notifyIssueAttentionRetentionWork } from "./retention-work-notifications.js";
import { notifyDeferredExecutionEligibility } from "./deferred-execution-notifications.js";
import { notifyRunDispatch } from "./run-dispatch-notifications.js";
import { notifyStatusCardIssueChange } from "./status-card-notifications.js";
import { notifyRoutineExecutionStatus } from "./routine-execution-status-notifications.js";
import type { Db } from "@paperclipai/db";
import { DELIVERY_QUEUES, notifyDeliveryWork, type DeliveryQueue } from "./delivery-work-notifications.js";

export type ExecutionWorkScope = { companyId: string; agentId?: string; runId?: string; issueId?: string };

async function notifyExecutionAttentionRetention(transaction: object, scope: ExecutionWorkScope) {
  if (scope.issueId || scope.runId) await notifyIssueAttentionRetentionWork(transaction, { companyId: scope.companyId, issueId: scope.issueId, runId: scope.runId });
  else await notifyAttentionRetentionWork(transaction, scope);
}

export async function notifyExecutionRunWork(transaction: object, scope?: ExecutionWorkScope) {
  if (scope) {
    await notifyExecutionAttentionRetention(transaction, scope);
    await notifyRunDispatch(transaction, scope);
    await notifyStatusCardIssueChange(transaction, scope.companyId);
    await notifyDeferredExecutionEligibility(transaction, scope);
    await notifyLiveRunRecovery(transaction, scope);
    await notifyLiveResourceRecovery(transaction, scope);
    await notifyRoutineExecutionStatus(transaction, scope.issueId, scope.companyId);
  }
  for (const queue of [DELIVERY_QUEUES.executionStatus, DELIVERY_QUEUES.executionFinalization,
    DELIVERY_QUEUES.executionReplacement, DELIVERY_QUEUES.executionDisposition, DELIVERY_QUEUES.issueMonitors,
    DELIVERY_QUEUES.remoteWorkspaceSnapshots]) {
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
    await notifyRunDispatch(transaction, scope);
    if (scope) {
      await notifyStatusCardIssueChange(transaction, scope.companyId);
      await notifyExecutionAttentionRetention(transaction, scope);
      await notifyRoutineExecutionStatus(transaction, scope.issueId, scope.companyId);
      await notifyDeferredExecutionEligibility(transaction, scope);
      await notifyLiveRunRecovery(transaction, scope);
      await notifyLiveResourceRecovery(transaction, scope);
    }
    await notifyDeliveryWork(transaction, DELIVERY_QUEUES.issueMonitors);
    for (const topic of typeof queue === "string" ? [queue] : queue) await notifyDeliveryWork(transaction, topic);
    return write(transaction as unknown as Db);
  });
}
