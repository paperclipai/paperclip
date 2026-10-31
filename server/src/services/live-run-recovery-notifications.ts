import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type LiveRunRecoveryScope = { companyId: string; runId?: string; issueId?: string; agentId?: string };

export async function notifyActiveRunSilence(tx: object, scope?: LiveRunRecoveryScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.activeRunSilence, scope
    ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}

export async function notifyLiveRunRecovery(tx: object, scope?: LiveRunRecoveryScope) {
  const hint = scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, agentId: scope.agentId }) : "*";
  for (const queue of [DELIVERY_QUEUES.nativeProcessSessions, DELIVERY_QUEUES.nativeQuestionCancellations,
    DELIVERY_QUEUES.activeExecutionRecovery, DELIVERY_QUEUES.settledNativeProcesses, DELIVERY_QUEUES.strandedAgentStatus])
    await notifyDeliveryWork(tx, queue, hint);
  await notifyActiveRunSilence(tx, scope);
}

export type LiveResourceRecoveryScope = { companyId: string; runId?: string; leaseId?: string };

export async function notifyLiveResourceRecovery(tx: object, scope?: LiveResourceRecoveryScope) {
  const hint = scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, leaseId: scope.leaseId }) : "*";
  for (const queue of [DELIVERY_QUEUES.orphanActiveLeases, DELIVERY_QUEUES.legacyShutdownSettlement,
    DELIVERY_QUEUES.strandedAgentStatus, DELIVERY_QUEUES.settledNativeProcesses])
    await notifyDeliveryWork(tx, queue, hint);
}
