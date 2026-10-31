import { DELIVERY_QUEUES, notifyDeliveryWork } from "./delivery-work-notifications.js";

export type LiveRunRecoveryScope = { companyId: string; runId?: string; issueId?: string; agentId?: string };

export async function notifyActiveRunSilence(tx: object, scope?: LiveRunRecoveryScope) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.activeRunSilence, scope
    ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, issueId: scope.issueId }) : "*");
}

export async function notifyLiveRunRecovery(tx: object, scope?: LiveRunRecoveryScope) {
  const hint = scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId }) : "*";
  for (const queue of [DELIVERY_QUEUES.nativeProcessSessions, DELIVERY_QUEUES.nativeQuestionCancellations,
    DELIVERY_QUEUES.activeExecutionRecovery, DELIVERY_QUEUES.settledNativeProcesses])
    await notifyDeliveryWork(tx, queue, hint);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus, scope
    ? JSON.stringify({ companyId: scope.companyId, agentId: scope.agentId }) : "*");
  await notifyActiveRunSilence(tx, scope);
}

export type LiveResourceRecoveryScope = { companyId: string; runId?: string; leaseId?: string };

export async function notifyLiveResourceRecovery(tx: object, scope?: LiveResourceRecoveryScope) {
  const hint = scope ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId, leaseId: scope.leaseId }) : "*";
  for (const queue of [DELIVERY_QUEUES.orphanActiveLeases, DELIVERY_QUEUES.legacyShutdownSettlement])
    await notifyDeliveryWork(tx, queue, hint);
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.settledNativeProcesses, scope
    ? JSON.stringify({ companyId: scope.companyId, runId: scope.runId }) : "*");
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus, scope
    ? JSON.stringify({ companyId: scope.companyId }) : "*");
}

export async function notifyStrandedAgentStatus(tx: object, scope: { companyId: string; agentId: string }) {
  await notifyDeliveryWork(tx, DELIVERY_QUEUES.strandedAgentStatus,
    JSON.stringify({ companyId: scope.companyId, agentId: scope.agentId }));
}
